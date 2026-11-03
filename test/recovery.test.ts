import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { recoverInterruptedDeploys } from '../src/deploy/recovery.ts';
import { imageProject, setup } from './helpers.ts';

const REF = 'localhost:5050/library/hello:latest';
const V2_REF = 'localhost:5050/library/hello:v2';

/** A project with a healthy v1 deployed. */
async function withV1(t: TestContext) {
  const s = setup(t);
  const v1 = s.fakeDocker.push(REF, 'healthy');
  const { id } = s.projects.create(s.ctx, imageProject());
  s.deploys.request(s.ctx, id, {}, 'ui');
  await s.queue.idle();
  const recover = () => recoverInterruptedDeploys({ db: s.db, docker: s.fakeDocker, audit: s.audit, files: s.files });
  /** Leaves a deploy row in the state a restart mid-deploy would. */
  const cutOff = (digest: string) =>
    s.db.run(`INSERT INTO deploys (project_id, trigger, digest, status, actor) VALUES (?, 'api', ?, 'running', 'user:1')`, id, digest).lastInsertRowid;
  const runQueue = async () => {
    s.queue.start(60_000);
    await s.queue.idle();
    s.queue.stop();
  };
  return { ...s, id, v1, recover, cutOff, runQueue };
}

test('an interrupted deploy is marked failed and the last healthy version comes back first', async (t) => {
  const s = await withV1(t);
  const v2 = s.fakeDocker.push(V2_REF, 'healthy');
  // v2 was half started when the restart hit, and another deploy was waiting.
  const cut = s.cutOff(v2);
  s.fakeDocker.containers.set('hello', { image: `localhost:5050/library/hello@${v2}`, behavior: 'healthy', project: 'hello' });
  const waiting = s.db.run(`INSERT INTO deploys (project_id, trigger, digest, actor) VALUES (?, 'api', ?, 'user:1')`, s.id, v2).lastInsertRowid;

  await s.recover();
  assert.deepEqual(
    { status: s.deploys.get(cut).status, reason: s.deploys.get(cut).failureReason },
    { status: 'failed', reason: 'interrupted by restart' },
  );

  await s.runQueue();
  const recovery = s.deploys.list(s.id).find((d) => d.trigger === 'recovery')!;
  assert.equal(recovery.status, 'healthy');
  assert.equal(recovery.digest, s.v1);
  assert.equal(recovery.actor, 'system');
  // Recovery ran before the waiting deploy, which then took v2 live.
  assert.ok(recovery.finishedAt! <= s.deploys.get(waiting).startedAt!);
  assert.equal(s.deploys.get(waiting).status, 'healthy');
  assert.equal(s.projects.get(s.id).image?.currentDigest, v2);

  const systemActions = s.audit.list().filter((e) => e.actorType === 'system').map((e) => e.action);
  assert.deepEqual(systemActions.sort(), ['deploy.interrupted', 'deploy.recovery']);
});

test('no recovery deploy when the last healthy version is still serving', async (t) => {
  const s = await withV1(t);
  s.cutOff(s.v1);
  s.db.run(`UPDATE projects SET status = 'deploying' WHERE id = ?`, s.id);

  await s.recover();
  assert.equal(s.deploys.list(s.id).some((d) => d.trigger === 'recovery'), false);
  assert.equal(s.projects.get(s.id).status, 'running');
  assert.ok(s.audit.list().some((e) => e.action === 'deploy.recovery_not_needed'));
});

test('an interrupted first deploy stops the container and marks the project failed', async (t) => {
  const s = setup(t);
  const v1 = s.fakeDocker.push(REF, 'healthy');
  const { id } = s.projects.create(s.ctx, imageProject());
  s.db.run(`INSERT INTO deploys (project_id, trigger, digest, status, actor) VALUES (?, 'ui', ?, 'running', 'user:1')`, id, v1);
  s.fakeDocker.containers.set('hello', { image: `localhost:5050/library/hello@${v1}`, behavior: 'healthy', project: 'hello' });

  await recoverInterruptedDeploys({ db: s.db, docker: s.fakeDocker, audit: s.audit, files: s.files });
  assert.equal(s.fakeDocker.containers.has('hello'), false);
  assert.equal(s.projects.get(id).status, 'failed');
  assert.equal(s.deploys.list(id).some((d) => d.trigger === 'recovery'), false);
});

test('a failed recovery is not retried in a loop', async (t) => {
  const s = await withV1(t);
  s.cutOff(s.v1);
  s.fakeDocker.containers.delete('hello');
  await s.recover();

  // The last healthy image now crashes too (say, a database it needs is gone).
  const up = s.fakeDocker.composeUp.bind(s.fakeDocker);
  s.fakeDocker.composeUp = async (target, onLine) => {
    await up(target, onLine);
    s.fakeDocker.containers.get(target.project)!.behavior = 'crash';
  };
  await s.runQueue();

  const recoveries = s.deploys.list(s.id).filter((d) => d.trigger === 'recovery');
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0]!.status, 'failed');
  assert.equal(s.projects.get(s.id).status, 'failed');
  assert.ok(s.deploys.logs(recoveries[0]!.id).some((l) => l.line.includes('nothing to fall back to')));
});
