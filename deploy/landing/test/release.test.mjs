import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { packageRelease, loadBundle, deployRelease, archivedBundle, validateManifest } from '../release.mjs';

async function fixture(t, sha = 'a'.repeat(40)) {
  const root = await mkdtemp(join(tmpdir(), 'landing-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'dist/assets'), { recursive: true });
  await writeFile(join(root, 'dist/index.html'), `<html>${sha}</html>`);
  await writeFile(join(root, `dist/assets/main-${sha.slice(0, 8)}.js`), `console.log('${sha}')`);
  await packageRelease(join(root, 'dist'), join(root, 'bundle'), sha);
  return loadBundle(join(root, 'bundle'));
}
function memoryStorage() {
  const objects = new Map(), writes = [];
  let failFor = null;
  const storage = {
    objects, writes,
    failVerificationFor: sha => { failFor = sha; },
    async get(key, target) {
      if (!objects.has(key)) return false;
      await writeFile(target, objects.get(key));
      return true;
    },
    async put(key, path, _meta, immutable) {
      const bytes = await readFile(path);
      if (immutable && objects.has(key) && !objects.get(key).equals(bytes)) throw new Error('Immutable archive changed');
      objects.set(key, bytes);
      writes.push(key);
    },
    async invalidate() {},
    async verify(bundle) {
      if (bundle.manifest.sha === failFor) throw new Error('Wrong public response');
      for (const file of bundle.manifest.files) {
        assert.equal(createHash('sha256').update(objects.get(`site/${file.path}`)).digest('hex'), file.sha256);
      }
    },
  };
  return storage;
}
test('package includes byte-exact canonical associations with explicit JSON metadata', async t => {
  const bundle = await fixture(t);
  for (const name of ['apple-app-site-association', 'assetlinks.json']) {
    assert.deepEqual(await readFile(join(bundle.root, '.well-known', name)), await readFile(`frontend/public/.well-known/${name}`));
    assert.equal(bundle.manifest.files.find(file => file.path === `.well-known/${name}`).contentType, 'application/json');
  }
  assert.match(bundle.manifest.files.find(file => file.path.endsWith('.js')).cacheControl, /immutable/);
});
test('modified artifacts, symlinks and traversal manifests are rejected', async t => {
  const bundle = await fixture(t);
  await writeFile(join(bundle.root, 'index.html'), 'modified');
  await assert.rejects(loadBundle(bundle.root), /checksum/);
  await symlink('/etc/passwd', join(bundle.root, 'passwords.txt'));
  await assert.rejects(loadBundle(bundle.root), /Symlinks/);
  const manifest = structuredClone(bundle.manifest);
  manifest.files[0].path = '../outside.json';
  assert.throws(() => validateManifest(manifest), /Disallowed/);
});
test('publish archives before live writes and switches HTML last', async t => {
  const bundle = await fixture(t), storage = memoryStorage();
  await deployRelease(storage, bundle);
  const live = storage.writes.filter(key => key.startsWith('site/'));
  assert.equal(live.at(-1), 'site/index.html');
  assert.ok(storage.writes.indexOf(`archive/${bundle.manifest.sha}/manifest.json`) < storage.writes.indexOf(live[0]));
  assert.equal(JSON.parse(storage.objects.get('control/current.json')).sha, bundle.manifest.sha);
});
test('failed candidate verification restores previous release and still fails the deployment', async t => {
  const old = await fixture(t), next = await fixture(t, 'b'.repeat(40)), storage = memoryStorage();
  await deployRelease(storage, old);
  storage.failVerificationFor(next.manifest.sha);
  await assert.rejects(deployRelease(storage, next), /previous release restored/);
  assert.deepEqual(storage.objects.get('site/index.html'), await readFile(join(old.root, 'index.html')));
  assert.equal(JSON.parse(storage.objects.get('control/current.json')).sha, old.manifest.sha);
});
test('corrupt previous archive aborts before touching live objects', async t => {
  const old = await fixture(t), next = await fixture(t, 'b'.repeat(40)), storage = memoryStorage();
  await deployRelease(storage, old);
  storage.objects.set(`archive/${old.manifest.sha}/index.html`, Buffer.from('corrupt'));
  const start = storage.writes.length;
  await assert.rejects(deployRelease(storage, next), /checksum/);
  assert.equal(storage.writes.length, start);
});
test('explicit rollback loads a verified completed archive and retains newer hashed assets', async t => {
  const old = await fixture(t), next = await fixture(t, 'b'.repeat(40)), storage = memoryStorage();
  await deployRelease(storage, old);
  await deployRelease(storage, next);
  const root = await mkdtemp(join(tmpdir(), 'landing-restore-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = await archivedBundle(storage, old.manifest.sha, join(root, 'old'));
  await deployRelease(storage, previous);
  assert.equal(JSON.parse(storage.objects.get('control/current.json')).sha, old.manifest.sha);
  assert.ok(storage.objects.has(`archive/${next.manifest.sha}/manifest.json`));
  assert.ok(storage.objects.has(`site/assets/main-${next.manifest.sha.slice(0, 8)}.js`));
});
test('first deployment failure reports that no previous release exists', async t => {
  const bundle = await fixture(t), storage = memoryStorage();
  storage.failVerificationFor(bundle.manifest.sha);
  await assert.rejects(deployRelease(storage, bundle), /first deployment has no previous/);
  assert.equal(storage.objects.has('control/current.json'), false);
});
test('association changes are rejected before live writes to preserve signed-app rollback compatibility', async t => {
  const old = await fixture(t), next = await fixture(t, 'b'.repeat(40)), storage = memoryStorage();
  await deployRelease(storage, old);
  const bytes = Buffer.from('{"webcredentials":{"apps":["NEW.IDENTITY"]}}');
  const path = '.well-known/apple-app-site-association';
  const file = next.manifest.files.find(file => file.path === path);
  file.bytes = bytes.length;
  file.sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(next.root, path), bytes);
  await writeFile(join(next.root, 'manifest.json'), JSON.stringify(next.manifest));
  const start = storage.writes.length;
  await assert.rejects(deployRelease(storage, await loadBundle(next.root)), /association changes/);
  assert.equal(storage.writes.length, start);
});
test('failed recovery is reported after exactly one recovery attempt', async t => {
  const old = await fixture(t), next = await fixture(t, 'b'.repeat(40)), storage = memoryStorage();
  await deployRelease(storage, old);
  let checks = 0;
  storage.verify = async () => { checks++; throw new Error('Unavailable'); };
  await assert.rejects(deployRelease(storage, next), /RECOVERY FAILED/);
  assert.equal(checks, 2);
});
