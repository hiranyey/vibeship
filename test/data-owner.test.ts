// dataOwner: who owns an image project's data/ folder. Only root can give a
// file to another user, so most tests record lchown calls with a fake and
// check what would be changed; one uses the real call with the test's own
// uid:gid, and one (root only) checks real ownership end to end.
import assert from 'node:assert/strict';
import { lchownSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import type { Lchown } from '../src/deploy/files.ts';
import { DATA_OWNER_LABEL } from '../src/deploy/layout.ts';
import { imageProject, setup, tempDir } from './helpers.ts';

const REF = 'localhost:5050/library/hello:latest';
const me = () => `${process.getuid!()}:${process.getgid!()}`;
/** An owner that differs from whoever runs the tests. */
const other = () => `${(process.getuid!() + 1) % 65536}:${(process.getgid!() + 1) % 65536}`;

type Call = { path: string; uid: number; gid: number };

function recorder(): { calls: Call[]; lchown: Lchown } {
  const calls: Call[] = [];
  return { calls, lchown: (path, uid, gid) => void calls.push({ path, uid, gid }) };
}

async function deploy(s: ReturnType<typeof setup>, id: number, input: Record<string, unknown> = {}) {
  const d = s.deploys.request(s.ctx, id, input, 'api');
  await s.queue.idle();
  return { deploy: s.deploys.get(d.id), log: s.deploys.logs(d.id).map((l) => l.line) };
}

/** A healthy v1 with no dataOwner, so data/ exists and is owned by whoever runs the tests. */
async function deployedWithout(t: TestContext, lchown?: Lchown) {
  const s = setup(t, { lchown });
  s.fakeDocker.push(REF, 'healthy');
  const project = s.projects.create(s.ctx, imageProject({ healthPath: null }));
  const first = await deploy(s, project.id);
  assert.equal(first.deploy.status, 'healthy');
  return { ...s, project, data: join(s.stackRoot, 'hello', 'data') };
}

test('without dataOwner, nothing is chowned and the generated file is unchanged', async (t) => {
  const { calls, lchown } = recorder();
  const s = await deployedWithout(t, lchown);
  assert.deepEqual(calls, []);
  const compose = readFileSync(join(s.stackRoot, 'hello', 'compose.yaml'), 'utf8');
  assert.ok(!compose.includes(DATA_OWNER_LABEL));
  assert.doesNotMatch(compose, /^\s+user:/m, 'never sets user:');
  assert.ok(statSync(s.data).isDirectory());
});

test('with dataOwner, a deploy chowns data/ for real and logs it', async (t) => {
  // The real lchown: giving a folder to its own owner works without root.
  const s = setup(t);
  s.fakeDocker.push(REF, 'healthy');
  const { id } = s.projects.create(s.ctx, imageProject({ healthPath: null, dataOwner: me() }));
  const { deploy: d, log } = await deploy(s, id);
  assert.equal(d.status, 'healthy');
  assert.ok(log.includes(`Data folder owned by ${me()}`), log.join('\n'));
  const st = statSync(join(s.stackRoot, 'hello', 'data'));
  assert.equal(`${st.uid}:${st.gid}`, me());
  const compose = readFileSync(join(s.stackRoot, 'hello', 'compose.yaml'), 'utf8');
  assert.ok(compose.includes(`${DATA_OWNER_LABEL}: "${me()}"`));
  assert.doesNotMatch(compose, /^\s+user:/m, 'the image USER still decides who runs');
});

test('data/ is chowned recursively only when its top-level owner differs', async (t) => {
  const { calls, lchown } = recorder();
  const s = await deployedWithout(t, lchown);
  mkdirSync(join(s.data, 'db', 'wal'), { recursive: true });
  writeFileSync(join(s.data, 'db', 'app.sqlite'), 'x');
  writeFileSync(join(s.data, 'db', 'wal', 'log'), 'x');

  // Top level differs from dataOwner: everything inside, then the folder itself last.
  s.projects.update(s.ctx, s.project.id, { dataOwner: other() });
  const first = await deploy(s, s.project.id);
  assert.equal(first.deploy.status, 'healthy');
  const [uid, gid] = other().split(':').map(Number);
  assert.ok(calls.every((c) => c.uid === uid && c.gid === gid));
  assert.deepEqual(calls.map((c) => c.path).sort(), [s.data, ...['db', 'db/app.sqlite', 'db/wal', 'db/wal/log'].map((p) => join(s.data, p))].sort());
  assert.equal(calls.at(-1)?.path, s.data, 'the folder itself is chowned last, so an interrupted walk is redone');
  assert.ok(first.log.includes(`Data folder owned by ${other()} (it had another owner, so 4 existing entries were changed too)`), first.log.join('\n'));

  // Top level already matches: only the folder itself, whatever is inside.
  calls.length = 0;
  s.projects.update(s.ctx, s.project.id, { dataOwner: me() });
  const second = await deploy(s, s.project.id);
  assert.equal(second.deploy.status, 'healthy');
  assert.deepEqual(calls.map((c) => c.path), [s.data]);
  assert.ok(second.log.includes(`Data folder owned by ${me()}`));
});

test('symlinks inside data/ are chowned as links and never followed', async (t) => {
  const { calls, lchown } = recorder();
  const s = await deployedWithout(t, lchown);
  const outside = tempDir(t);
  mkdirSync(join(outside, 'secret-dir'));
  writeFileSync(join(outside, 'secret-dir', 'file'), 'x');
  writeFileSync(join(outside, 'secret-file'), 'x');
  symlinkSync(join(outside, 'secret-dir'), join(s.data, 'dir-link'));
  symlinkSync(join(outside, 'secret-file'), join(s.data, 'file-link'));
  symlinkSync('/', join(s.data, 'root-link'));

  s.projects.update(s.ctx, s.project.id, { dataOwner: other() });
  assert.equal((await deploy(s, s.project.id)).deploy.status, 'healthy');
  const paths = calls.map((c) => c.path).sort();
  assert.deepEqual(paths, [s.data, join(s.data, 'dir-link'), join(s.data, 'file-link'), join(s.data, 'root-link')].sort());
  assert.ok(paths.every((p) => p === s.data || p.startsWith(`${s.data}/`)), 'nothing outside data/ is touched');
});

test('a data/ that is itself a symlink fails the deploy before anything changes', async (t) => {
  const { calls, lchown } = recorder();
  const s = await deployedWithout(t, lchown);
  const outside = tempDir(t);
  rmSync(s.data, { recursive: true });
  symlinkSync(outside, s.data);
  const composeBefore = readFileSync(join(s.stackRoot, 'hello', 'compose.yaml'), 'utf8');

  s.projects.update(s.ctx, s.project.id, { dataOwner: '1000:1000' });
  const { deploy: d, log } = await deploy(s, s.project.id);
  assert.equal(d.status, 'failed');
  assert.equal(d.failureReason, 'could not give data/ to 1000:1000: data/ is a symlink, so its owner is left alone');
  assert.deepEqual(calls, []);
  assert.ok(lstatSync(s.data).isSymbolicLink());
  assert.equal(readFileSync(join(s.stackRoot, 'hello', 'compose.yaml'), 'utf8'), composeBefore);
  assert.ok(log.some((l) => l.startsWith('Nothing was changed')), log.join('\n'));
});

test('a failed chown fails the deploy before up -d, and the running version keeps serving', async (t) => {
  let fail = false;
  const s = await deployedWithout(t, (path, uid, gid) => {
    if (fail) throw Object.assign(new Error(`EPERM: operation not permitted, lchown '${path}'`), { code: 'EPERM' });
    void [uid, gid];
  });
  const v1 = s.projects.get(s.project.id).image!.currentDigest!;
  const ups = () => s.fakeDocker.calls.filter((c) => c.startsWith('up')).length;
  const upsBefore = ups();
  const composeBefore = readFileSync(join(s.stackRoot, 'hello', 'compose.yaml'), 'utf8');

  fail = true;
  s.fakeDocker.push(REF, 'healthy'); // a newer image for the tag
  s.projects.update(s.ctx, s.project.id, { dataOwner: '1000:1000' });
  const { deploy: d, log } = await deploy(s, s.project.id);
  assert.equal(d.status, 'failed');
  assert.match(d.failureReason!, /^could not give data\/ to 1000:1000: EPERM: operation not permitted/);
  assert.equal(ups(), upsBefore, 'up -d never ran');
  assert.equal(s.fakeDocker.runningDigest('hello'), v1);
  const p = s.projects.get(s.project.id);
  assert.equal(p.status, 'running');
  assert.equal(p.image?.currentDigest, v1);
  assert.equal(readFileSync(join(s.stackRoot, 'hello', 'compose.yaml'), 'utf8'), composeBefore, 'files were not rewritten');
  assert.ok(log.some((l) => l.startsWith('Nothing was changed')), log.join('\n'));
  assert.equal(s.deploys.drift(s.project.id).pendingChanges, true, 'still waiting to be applied');
});

test('changing dataOwner is a pending change until the next deploy', async (t) => {
  const { lchown } = recorder();
  const s = await deployedWithout(t, lchown);
  const id = s.project.id;
  assert.equal(s.deploys.drift(id).pendingChanges, false);

  s.projects.update(s.ctx, id, { dataOwner: '1000:1000' });
  assert.equal(s.deploys.drift(id).pendingChanges, true);
  const digest = s.projects.get(id).image!.currentDigest!;
  assert.equal((await deploy(s, id, { digest })).deploy.status, 'healthy');
  assert.deepEqual(s.deploys.drift(id), {
    files: [{ path: '.env', state: 'ok' }, { path: 'compose.yaml', state: 'ok' }],
    pendingChanges: false,
  });

  s.projects.update(s.ctx, id, { dataOwner: null });
  assert.equal(s.deploys.drift(id).pendingChanges, true, 'clearing it is a change too');
  await deploy(s, id, { digest });
  assert.equal(s.deploys.drift(id).pendingChanges, false);
});

test('as root, data/ and what is inside end up owned by dataOwner', { skip: process.getuid?.() !== 0 && 'needs root to give files away' }, async (t) => {
  const s = setup(t);
  s.fakeDocker.push(REF, 'healthy');
  const { id } = s.projects.create(s.ctx, imageProject({ healthPath: null }));
  await deploy(s, id);
  const data = join(s.stackRoot, 'hello', 'data');
  writeFileSync(join(data, 'old.txt'), 'written as root');
  const outside = tempDir(t);
  writeFileSync(join(outside, 'target'), 'x');
  symlinkSync(join(outside, 'target'), join(data, 'link'));
  lchownSync(join(outside, 'target'), 0, 0);

  s.projects.update(s.ctx, id, { dataOwner: '1000:1000' });
  assert.equal((await deploy(s, id)).deploy.status, 'healthy');
  for (const p of [data, join(data, 'old.txt'), join(data, 'link')]) {
    const st = lstatSync(p);
    assert.equal(`${st.uid}:${st.gid}`, '1000:1000', p);
  }
  assert.equal(statSync(join(outside, 'target')).uid, 0, 'the link target is not touched');
});
