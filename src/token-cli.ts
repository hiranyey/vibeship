// Creates an API token from the command line, for the first token before
// anyone has logged in (or when login is not configured), and for scripts.
// It writes to the database directly, so it runs where the database is:
//
//   docker compose exec vibeship node src/token-cli.ts <name> <read|deploy|admin> [expires-at]
//   npm run token -- <name> <read|deploy|admin> [expires-at]
//
// The token is printed once on stdout; only its hash is stored.
import { systemContext } from './actor.ts';
import { loadConfig } from './config.ts';
import { Db } from './db/db.ts';
import { migrate } from './db/migrate.ts';
import { AppError } from './errors.ts';
import { AuditLog } from './services/audit.ts';
import { TokenService } from './services/tokens.ts';

const [name, scope, expiresAt] = process.argv.slice(2);
if (!name || !scope) {
  console.error('Usage: node src/token-cli.ts <name> <read|deploy|admin> [expires-at, e.g. 2027-01-01T00:00:00Z]');
  process.exit(2);
}

const config = loadConfig();
const db = new Db(config.dbPath);
try {
  migrate(db);
  const tokens = new TokenService({ db, audit: new AuditLog(db) });
  const { token, apiToken } = tokens.create(systemContext, { name, scope, expiresAt: expiresAt ?? null });
  console.error(`Created ${apiToken.scope} token #${apiToken.id} "${apiToken.name}". It is shown only once:`);
  console.log(token);
} catch (err) {
  if (!(err instanceof AppError)) throw err;
  console.error(err.message);
  process.exitCode = 1;
} finally {
  db.close();
}
