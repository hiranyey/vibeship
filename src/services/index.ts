import type { Config } from '../config.ts';
import { SecretBox } from '../crypto/secret-box.ts';
import type { Db } from '../db/db.ts';
import { AuditLog } from './audit.ts';
import { EnvService } from './env.ts';
import { ProjectService } from './projects.ts';

/** The service layer shared by the UI, the HTTP API, the webhook receiver and MCP. */
export type Services = {
  audit: AuditLog;
  projects: ProjectService;
  env: EnvService;
};

export function createServices(deps: { db: Db; config: Pick<Config, 'baseDomain' | 'masterKey'> }): Services {
  const { db } = deps;
  const audit = new AuditLog(db);
  const box = new SecretBox(deps.config.masterKey);
  return {
    audit,
    projects: new ProjectService({ db, audit, baseDomain: deps.config.baseDomain }),
    env: new EnvService({ db, audit, box }),
  };
}
