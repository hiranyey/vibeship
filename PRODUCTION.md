# Running Vibeship in production

The production setup is one Debian VM behind Cloudflare: Caddy terminates TLS with a Cloudflare origin certificate for `*.hiranyey.dev`, Vibeship runs next to it, and apps live at `<project>.hiranyey.dev`. `scripts/bootstrap.sh` sets it all up and is safe to run again.

## 1. Before the server

**Cloudflare** (the `hiranyey.dev` zone):

1. SSL/TLS > Overview: set the mode to **Full (strict)**.
2. SSL/TLS > Origin Server > Create Certificate: RSA or ECDSA, hostnames `*.hiranyey.dev` and `hiranyey.dev`. Save the certificate as `origin.pem` and the private key as `origin.key`; the key is shown only once.
3. DNS: a **proxied** `A` record for `*` (and `AAAA` if the VM has IPv6) pointing at the VM. `vibeship.hiranyey.dev` is covered by the wildcard.

**Clerk** (a production instance):

1. Turn sign-ups off (the restricted sign-up mode in Clerk's restrictions settings), so only users you invite exist.
2. Create an OAuth application with redirect URL `https://vibeship.hiranyey.dev/auth/callback` and scopes `openid email profile`.
3. Note the issuer (the instance's Frontend API URL, e.g. `https://clerk.hiranyey.dev`), the client ID and the client secret.

Vibeship also checks `ADMIN_EMAILS` itself: only those verified emails can log in, whatever Clerk allows.

## 2. Bootstrap

On a fresh Debian 12 or 13 VM, as root:

```sh
apt-get update && apt-get install -y git
git clone https://github.com/hiranyey/vibeship.git /opt/vibeship-src   # a private repo needs a deploy key or token
cd /opt/vibeship-src
# copy origin.pem and origin.key to the VM first, e.g. with scp to /root
VIBESHIP_HOST=vibeship.hiranyey.dev \
ADMIN_EMAILS=you@example.com \
ORIGIN_CERT=/root/origin.pem ORIGIN_KEY=/root/origin.key \
OIDC_ISSUER=https://clerk.hiranyey.dev OIDC_CLIENT_ID=... OIDC_CLIENT_SECRET=... \
CLOUDFLARE_ONLY=1 \
scripts/bootstrap.sh
```

It installs Docker Engine with the compose plugin, turns on unattended security updates, caps container logs at 5 × 10 MB, creates the `web` and internal `caddy-admin` networks and `/opt/stack/{caddy,vibeship}`, builds the Vibeship image from the checkout, writes `/opt/stack/vibeship/.env` (mode 600, with a new `MASTER_KEY`), starts Caddy and Vibeship, and turns on ufw with only SSH and 443 open. With `CLOUDFLARE_ONLY=1`, 443 accepts only Cloudflare's ranges, both in ufw and in Docker's `DOCKER-USER` chain (Docker-published ports bypass ufw's own rules). The script header lists every setting.

Afterwards, delete `/root/origin.key` (a copy lives in `/opt/stack/caddy/certs`), and copy `/opt/stack/vibeship/.env` to your password manager: without its `MASTER_KEY`, the stored env secrets and registry tokens can't be decrypted.

Check from your laptop:

```sh
nmap -Pn -p 1-65535 <vm ip>        # 22 and 443 only (443 filtered unless from Cloudflare with CLOUDFLARE_ONLY=1)
curl -sI https://vibeship.hiranyey.dev/healthz
```

Then log in at `https://vibeship.hiranyey.dev`.

## 3. Registry and tokens

- **RepoFlow**: create a read-only token in RepoFlow, then add it in Vibeship under Registries (name, URL `https://repoflow.hiranyey.dev`, username, token). Projects whose image is on that host use it automatically.
- **API tokens**: create them under API tokens in the UI. Before you can log in (or with login off), use the command line:

  ```sh
  docker compose -f /opt/stack/vibeship/compose.yaml exec vibeship node src/token-cli.ts laptop deploy
  ```

- **MCP**: `claude mcp add --transport http vibeship https://vibeship.hiranyey.dev/mcp --header "Authorization: Bearer <token>"`.

## 4. Deploying an app from GitHub

1. In Vibeship, create an image project with image `repoflow.hiranyey.dev/library/<app>:latest`, its port and a health path.
2. On its Settings tab, create the webhook URL.
3. Copy `examples/github-actions/deploy.yml` to the app's repository as `.github/workflows/deploy.yml`, set `IMAGE`, and add the secrets `REPOFLOW_USERNAME`, `REPOFLOW_TOKEN` (a login that can push) and `VIBESHIP_WEBHOOK_URL`.

A push to `main` then builds, pushes and posts the digest; Vibeship pulls that digest, health checks it and only then routes `<app>.hiranyey.dev` to it.

## Updating Vibeship

Vibeship never redeploys itself. To update it:

```sh
cd /opt/vibeship-src && git pull && VIBESHIP_HOST=vibeship.hiranyey.dev CLOUDFLARE_ONLY=1 scripts/bootstrap.sh
```

Settings are kept in `/opt/stack/vibeship/.env`, so a re-run needs only `VIBESHIP_HOST` (plus `CLOUDFLARE_ONLY=1` if you use it). A deploy cut off by the restart is marked failed and the last healthy version is brought back. To change a setting, pass it again; to rotate the origin certificate, pass `ORIGIN_CERT` and `ORIGIN_KEY` again. The script refuses to replace an existing `MASTER_KEY`.

## Moving to a new server

Stop both stacks, copy `/opt/stack` to the new VM as is (its `vibeship/.env` holds `MASTER_KEY` and the settings, `caddy/certs` the certificate), then clone the repository there and run `VIBESHIP_HOST=vibeship.hiranyey.dev scripts/bootstrap.sh`. Each project's `data/` folder comes along inside `/opt/stack/<project>`; named compose volumes are Docker volumes and need copying separately, e.g. `docker run --rm -v <volume>:/v -v "$PWD":/out alpine tar czf /out/<volume>.tgz -C /v .`.

To start fresh on a new server but keep an existing database, pass the old key as `MASTER_KEY=...` on the first run.
