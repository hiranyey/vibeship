// A temporary command line for driving Vibeship before the HTTP API exists
// (phase 3 replaces it). It runs inside the Vibeship container next to the
// server and shares its database, but only queues deploys: the server's
// queue picks them up within a couple of seconds.
//
//   scripts/dev.sh exec vibeship node src/dev-cli.ts <command> [args]
//
// Commands print JSON. See `usage` below.
import { setTimeout as sleep } from 'node:timers/promises';
import { systemContext } from './actor.ts';
import { loadConfig } from './config.ts';
import { Db } from './db/db.ts';
import { migrate } from './db/migrate.ts';
import { AppError } from './errors.ts';
import { createServices } from './services/index.ts';

const usage = `Usage: node src/dev-cli.ts <command>
  registry-add <name> <url> [username token]
  setting <key> <value>
  create <name> <imageRef> <port> [healthPath]
  env-set <name> <KEY> <value> [--secret]
  deploy <name> [digest] [--wait]
  wait <deployId>
  show <name>
  logs <deployId>
  remove <name> [--delete-data]`;

const config = loadConfig();
const db = new Db(config.dbPath);
migrate(db);
const s = createServices({ db, config, runDeploys: false });
const ctx = systemContext;

const [command, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const args = rest.filter((a) => !a.startsWith('--'));
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

/** Waits for a deploy to finish, echoing its log lines to stderr as they arrive. */
async function wait(deployId: number) {
  let seq = 0;
  for (;;) {
    for (const line of s.deploys.logs(deployId, seq)) {
      console.error(`  [${line.stream}] ${line.line}`);
      seq = line.seq;
    }
    const d = s.deploys.get(deployId);
    if (d.status === 'healthy' || d.status === 'failed') return d;
    await sleep(500);
  }
}

try {
  switch (command) {
    case 'registry-add': {
      const [name, url, username, token] = args;
      print(s.registries.create(ctx, { name, url, username: username ?? null, token: token ?? null }));
      break;
    }
    case 'setting':
      print(s.settings.set(ctx, args[0] as 'health_timeout_seconds', args[1]));
      break;
    case 'create': {
      const [name, imageRef, port, healthPath] = args;
      print(s.projects.create(ctx, { kind: 'image', name, imageRef, containerPort: Number(port), healthPath: healthPath ?? null }));
      break;
    }
    case 'env-set': {
      const [name, key, value] = args;
      print(s.env.set(ctx, s.projects.getByName(name!).id, { set: { [key!]: { value, secret: flags.has('--secret') } } }));
      break;
    }
    case 'deploy': {
      const [name, digest] = args;
      const d = s.deploys.request(ctx, s.projects.getByName(name!).id, digest ? { digest } : {}, 'api');
      print(flags.has('--wait') ? await wait(d.id) : d);
      break;
    }
    case 'wait':
      print(await wait(Number(args[0])));
      break;
    case 'show': {
      const p = s.projects.getByName(args[0]!);
      print({ project: p, deploys: s.deploys.list(p.id, 10), drift: s.deploys.drift(p.id) });
      break;
    }
    case 'logs':
      print(s.deploys.logs(Number(args[0])));
      break;
    case 'remove':
      await s.deploys.removeProject(ctx, s.projects.getByName(args[0]!).id, { deleteData: flags.has('--delete-data') });
      print({ removed: args[0] });
      break;
    default:
      console.error(usage);
      process.exitCode = 2;
  }
} catch (err) {
  if (!(err instanceof AppError)) throw err;
  print({ error: { code: err.code, message: err.message } });
  process.exitCode = 1;
} finally {
  db.close();
}
