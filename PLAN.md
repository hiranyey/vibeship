# Vibeship: build plan

Phases for building the MVP described in [SPEC.md](SPEC.md). Each phase ends with something that runs and is tested on the local dev stack, so nothing is built on top of untested ground. Production comes last, once everything works locally.

| Phase | Outcome |
|---|---|
| [0. Skeleton and dev stack](#phase-0-skeleton-and-dev-stack) | `npm run dev` brings up Vibeship, Caddy and a local registry |
| [1. Data and core services](#phase-1-data-and-core-services) | Database, encryption, audit log and project rules, unit tested |
| [2. Deploy engine for image projects](#phase-2-deploy-engine-for-image-projects) | Image projects deploy, fail safe and recover, with Caddy routes |
| [3. Auth, HTTP API and webhooks](#phase-3-auth-http-api-and-webhooks) | Login, API tokens and per-project webhooks trigger deploys |
| [4. Compose projects](#phase-4-compose-projects) | Compose projects validated by the allowlist and deployed |
| [5. MCP endpoint](#phase-5-mcp-endpoint) | An agent can create, deploy and debug projects |
| [6. Web UI](#phase-6-web-ui) | Every flow is available in the browser |
| [7. Production](#phase-7-production) | Running on the VM at `vibeship.hiranyey.dev` |

Phases 5 and 6 both sit on top of the service layer from phases 1 to 4 and can be built in either order.

## Phase 0: Skeleton and dev stack

- [x] Repo setup: Node 26, TypeScript, Hono, Zod, `node:test`, and an `npm test` script.
- [x] Config loaded from `.env`: `STACK_ROOT`, `BASE_DOMAIN`, `TLS_MODE`, `MASTER_KEY`, OIDC settings.
- [x] `Dockerfile` on `node:26-slim` with the Docker CLI and compose plugin.
- [x] `compose.dev.yaml` with Caddy, `registry:3` on `localhost:5050`, and Vibeship running `node --watch` with the source mounted.
- [x] The `web` and `caddy-admin` networks, the Docker socket mount, and `STACK_ROOT` bound at the same path.
- [x] Caddy base config: admin API on `caddy-admin` only, plain HTTP on `127.0.0.1:8080`, and a static route for `vibeship.localhost`.

**Done when** `npm run dev` serves a placeholder page at `http://vibeship.localhost:8080`, and `npm test` runs an empty suite.

## Phase 1: Data and core services

- [x] Migration runner for numbered `.sql` files on boot, with WAL mode on.
- [x] First migration with every table in the spec's data model.
- [x] A thin wrapper around `DatabaseSync` with prepared statements, and no ORM.
- [x] `MASTER_KEY` read from `.env` (`npm run gen-key` prints one, `npm run dev` fills it in), and AES-256-GCM helpers to encrypt and decrypt env values and registry tokens.
- [x] `audit_log` writer that every service call goes through, with actor types user, token and system.
- [x] Zod schemas for projects, env vars, deploys and tokens, shared by the API and MCP later.
- [x] Project service: create, read, update and delete, slug rules, reserved names (`caddy`, `vibeship`, `web`), unique hostnames.
- [x] Env service: set and unset values; secret values are write-only.

**Done when** unit tests cover migrations on `:memory:`, encryption round trips, slug and reserved-name rules, and the audit log.

## Phase 2: Deploy engine for image projects

- [x] `DockerRunner` interface with a real implementation (shells out to `docker` and `docker compose`) and a fake one for tests.
- [x] Registry access through the Docker daemon: pulls by tag or digest with the registry's read-only token in a throwaway `DOCKER_CONFIG`. Pulling `<repository>@<digest>` is also the check that a digest belongs to the project's repository.
- [x] Render `compose.yaml` and `.env` from the database into `STACK_ROOT/<project>/`, with the routed container on `web` under the `<project>` alias.
- [x] Deploy steps: pull, render, `up -d`, health check with a timeout, route, and fail safe back to the last healthy version.
- [x] Every step's output streamed into `deploy_logs`.
- [x] An in-process queue that runs one deploy at a time per project.
- [x] Recovery on boot: interrupted `running` deploys are marked `failed` and the last healthy version is restored if needed, then `queued` deploys run again in order.
- [x] Caddy client: add, update and delete one route by `@id`, and rebuild every route from the database on boot.
- [x] Drift check: compare the files on disk with what the database would generate.
- [x] Fixture images in `examples/fixture/`: `hello`, `hello-v2`, `crash`, `unhealthy`, `slow` and `probe`, built and pushed by `npm run fixtures`.
- [x] Temporary dev CLI (`src/dev-cli.ts`) that queues deploys for the server to run; replaced by the HTTP API in phase 3.

**Done when** these pass:

- Unit tests of the deploy steps against the fake Docker, simulating a crash, a timeout and an unhealthy container.
- Integration tests (`npm run test:integration`), driving the dev CLI before the API exists:
  - `hello` deploys and answers at `hello.localhost:8080`.
  - Deploying `crash` or `unhealthy` over it brings `hello` back.
  - Killing Vibeship mid-deploy recovers correctly.
  - `probe` cannot reach `caddy:2019`.
  - Restarting Caddy rebuilds every route.

## Phase 3: Auth, HTTP API and webhooks

- [x] Clerk OIDC login with PKCE, and `/auth/login`, `/auth/callback`, `/auth/logout`. The ID token's signature, issuer, audience, expiry and nonce are checked (`src/auth/oidc.ts`, tested against a fake provider). Still to do: try it against the Clerk development instance.
- [x] Sessions: random tokens in a secure cookie, stored hashed.
- [x] API tokens: create (shown once), list and revoke, stored as SHA-256 hashes, with scope read, deploy or admin and an optional expiry. `npm run token` creates one from the command line, for the first token or when login is off.
- [x] Middleware that accepts a session or a bearer token and checks scope on each route. Cookie-authenticated writes must come from Vibeship's own origin, because apps on sibling subdomains count as same-site.
- [x] Every HTTP API route in the spec, validated with the shared Zod schemas, plus read routes for env, deploys, drift, registries, settings and the audit log. Deleting a project goes through `DeployService.removeProject`, which also stops containers and drops the route. `POST /api/projects/:id/compose` comes with compose versions in phase 4.
- [x] Vibeship itself enforces auth on every route: apps on `web` can reach `vibeship:3000` directly, without going through Caddy.
- [x] Remove `src/dev-cli.ts` and move the integration tests onto the API.
- [x] Server-sent events streams for deploy logs and container logs.
- [x] Per-project webhooks: generate or rotate the token (shown once), `POST /hooks/deploy/:token`, and reject digests that don't belong to the project's image. The deploy pulls `<repository>@<digest>`, so a foreign digest fails at the pull without touching the running version; an `image` field in the body, if sent, must name the project's repository.
- [x] Caddy access log for the Vibeship host leaves out `/hooks/`.
- [x] `scripts/webhook.sh` to send a webhook request by hand.

**Done when** `scripts/webhook.sh` deploys `hello`, a rotated webhook URL returns 404 for the old token, each scope is refused on routes above it, and the integration tests from phase 2 now go through the API.

## Phase 4: Compose projects

- [x] Allowlist validator for compose YAML: allowed service keys, allowed volumes, allowed top-level keys, and an error that names the offending key (`src/compose/validate.ts`). The YAML is parsed, checked and written out again from the parsed value, so YAML tags and merge keys can't hide anything.
- [x] Unit tests with a table of good YAML and malicious YAML, covering every rejected key.
- [x] Patching: force the project name, attach the routed service to `web` with the `<project>` alias, and keep other services off `web`.
- [x] A routed service can't shadow a reserved name or another project: it is renamed to the project name in the written file, keeping its own name as an alias on the project's networks only.
- [x] `compose_versions`: save numbered versions with the routed service, port and optional health path, through `POST /api/projects/:id/compose`.
- [x] Deploy compose projects through the same steps as image projects, with `docker compose config` and `docker compose pull` instead of pulling by digest. Any saved version can be deployed again by number.
- [x] Docker commands run with a minimal environment, so compose can't interpolate `MASTER_KEY` into a container, and `$` is refused where interpolation could change a mount, port or network.
- [x] Fixture `compose-two-apps`: two projects that both have `app` and `db` services.

**Done when** malicious YAML is rejected, both `compose-two-apps` projects route correctly through their aliases, and a broken compose version brings back the last healthy one.

## Phase 5: MCP endpoint

- [x] `/mcp` over Streamable HTTP with `@modelcontextprotocol/sdk`, authenticated with bearer API tokens only (a browser session is refused). It runs stateless with plain JSON replies: each request gets a fresh server, and nothing needs a session or a stream.
- [x] Every tool in the spec's MCP table, calling the same service layer as the API and checking the tool's scope. A token only sees the tools its scope allows. `update_project` was added so an agent can fix a wrong port or health path.
- [x] `deploy` returns a deploy id immediately; progress is read with `get_deploy_logs` (with `afterSeq` to page) and `get_status`.
- [x] No tool ever returns a secret value.
- [x] Integration tests that drive `/mcp` with the SDK client.
- [x] `restart`, `stop` and `start` also exist in the HTTP API, with `GET /api/projects/:id/status`. A stopped project's route is dropped until it starts again.

**Done when** an agent with a deploy token, using Claude Code or MCP Inspector against `http://vibeship.localhost:8080/mcp`, creates a project, deploys it, reads its logs and fixes a failed deploy without touching the UI.

## Phase 6: Web UI

- [ ] `vibeship.css`and `DESIGN-SYSTEM.html` in the Ink & Grid theme.
- [ ] Layout: sidebar, dense tables, status pills, rendered on the server with `hono/html`.
- [ ] Dashboard listing every project with status, hostname, current version and last deploy.
- [ ] Project page with tabs: overview, deploys, logs, env, compose (YAML editor and version history) and settings (including webhook URL and drift warnings).
- [ ] New project wizard for image and compose projects.
- [ ] Deploy view with live logs over server-sent events, in a little vanilla JS.
- [ ] Settings pages for registries, API tokens and the audit log.

**Done when** every flow from phases 2 to 4 can be done in the browser, logged in through the Clerk development instance.

## Phase 7: Production

- [ ] `bootstrap.sh` for fresh Debian: Docker Engine and compose plugin, unattended security updates, both networks, folders, Caddy and Vibeship, and a firewall allowing only 22 and 443.
- [ ] Test `bootstrap.sh` on a throwaway Debian VM (OrbStack, Lima or Multipass), including running it twice.
- [ ] `TLS_MODE=origin-cert` with the Cloudflare origin certificate for `*.hiranyey.dev`.
- [ ] Clerk production instance with signup disabled.
- [ ] RepoFlow registry configured with a read-only token.
- [ ] Sample GitHub Actions workflow that builds, pushes to RepoFlow and posts the digest to the project's webhook URL.
- [ ] Run `bootstrap.sh` on the VM and log in at `vibeship.hiranyey.dev`.

**Done when** the spec's "Done means" holds in production:

- A push to a repo with the sample workflow goes live at its subdomain within a couple of minutes.
- A broken image is replaced by the previous version once its health check fails.
- An agent with a deploy token can create, deploy and debug a project through MCP alone.

## After the MVP

These are listed under "Later" in the spec and aren't part of any phase above:

- Viewer role and per-project token allowlists
- Registry polling fallback
- Rollback button and MCP tool, with compose images pinned by digest
- Snapshots of `data/` and off-VM backups
- Automatic image pruning
- Multiple registries and routes per project
- CPU and memory graphs
- UI polish beyond functional pages
