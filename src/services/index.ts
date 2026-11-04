import { type CaddyApi, CaddyClient } from '../caddy/client.ts';
import type { Config } from '../config.ts';
import { SecretBox } from '../crypto/secret-box.ts';
import type { Db } from '../db/db.ts';
import { DeployEngine } from '../deploy/engine.ts';
import { type Lchown, ProjectFiles } from '../deploy/files.ts';
import { fetchProbe, type HealthTiming, type HttpProbe } from '../deploy/health.ts';
import { DeployLogs } from '../deploy/logs.ts';
import { DeployQueue } from '../deploy/queue.ts';
import { RouteSync } from '../deploy/routes.ts';
import { CliDockerRunner } from '../docker/cli-runner.ts';
import type { DockerRunner } from '../docker/runner.ts';
import { HostMonitor, type HostSource } from '../system/host.ts';
import { AuditLog } from './audit.ts';
import { DeployService } from './deploys.ts';
import { EnvService } from './env.ts';
import { MetricsService } from './metrics.ts';
import { ProjectService } from './projects.ts';
import { RegistryService } from './registries.ts';
import { SessionService } from './sessions.ts';
import { SettingsService } from './settings.ts';
import { TokenService } from './tokens.ts';

/** The service layer shared by the UI, the HTTP API, the webhook receiver and MCP. */
export type Services = ReturnType<typeof createServices>;

export function createServices(deps: {
  db: Db;
  config: Pick<Config, 'baseDomain' | 'masterKey' | 'stackRoot' | 'caddyAdminUrl'>;
  /** Fakes for tests; real implementations by default. */
  docker?: DockerRunner;
  caddy?: CaddyApi;
  probe?: HttpProbe;
  timing?: Partial<HealthTiming>;
  /** Replaces `fs.lchownSync` for `data/` ownership, since tests don't run as root. */
  lchown?: Lchown;
  /** Replaces `/proc` for host CPU and memory in tests. */
  hostSource?: HostSource;
  /** False for processes that share the database but must leave deploys to the server. */
  runDeploys?: boolean;
}) {
  const { db, config } = deps;
  const audit = new AuditLog(db);
  const box = new SecretBox(config.masterKey);
  const docker = deps.docker ?? new CliDockerRunner();
  const caddy = deps.caddy ?? new CaddyClient(config.caddyAdminUrl);

  const projects = new ProjectService({ db, audit, baseDomain: config.baseDomain });
  const env = new EnvService({ db, audit, box });
  const registries = new RegistryService({ db, audit, box });
  const settings = new SettingsService({ db, audit });
  const tokens = new TokenService({ db, audit });
  const sessions = new SessionService({ db, audit });
  const logs = new DeployLogs(db);
  const files = new ProjectFiles({ db, stackRoot: config.stackRoot, lchown: deps.lchown });

  const engine = new DeployEngine({
    db, projects, env, registries, settings, logs, files, docker, caddy,
    probe: deps.probe ?? fetchProbe,
    timing: deps.timing,
  });
  const queue = new DeployQueue({ db, engine, enabled: deps.runDeploys });
  const routes = new RouteSync({ db, caddy });
  const deploys = new DeployService({ db, audit, projects, engine, queue, logs, files, docker, caddy });
  const host = new HostMonitor({ source: deps.hostSource });
  const metrics = new MetricsService({ docker, host, projects });

  return { audit, box, projects, env, registries, settings, tokens, sessions, deploys, engine, queue, routes, files, docker, host, metrics };
}
