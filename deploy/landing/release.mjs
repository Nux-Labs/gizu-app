import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, writeFile, lstat, rm } from 'node:fs/promises';
import { resolve, join, dirname, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const shaPattern = /^[a-f0-9]{40}$/;
const associationNames = ['apple-app-site-association', 'assetlinks.json'];
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.gif': 'image/gif', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain', '.xml': 'application/xml' };

function safePath(path) {
  return typeof path === 'string' && path.length < 500 && path.split('/').every(part =>
    /^[A-Za-z0-9_@+.-]+$/.test(part) && !part.startsWith('.') || part === '.well-known');
}
export function metadata(path) {
  const association = associationNames.some(name => path === `.well-known/${name}`);
  const contentType = association ? 'application/json' : types[extname(path)];
  if (!safePath(path) || !contentType || path === 'manifest.json') throw new Error(`Disallowed artifact path: ${path}`);
  return { contentType, cacheControl: /^assets\/.+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(path)
    ? 'public,max-age=31536000,immutable' : path === 'index.html' ? 'public,max-age=60,must-revalidate' : 'public,max-age=300,must-revalidate' };
}
export function validateManifest(manifest) {
  if (manifest?.version !== 1 || !shaPattern.test(manifest.sha) || !Array.isArray(manifest.files) || manifest.files.length > 1000) throw new Error('Invalid release manifest');
  const seen = new Set();
  let total = 0;
  for (const file of manifest.files) {
    const expected = metadata(file.path);
    if (seen.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.contentType !== expected.contentType || file.cacheControl !== expected.cacheControl) throw new Error('Invalid file manifest');
    seen.add(file.path);
    total += file.bytes;
  }
  if (total > 100 * 1024 * 1024 || !seen.has('index.html') || associationNames.some(name => !seen.has(`.well-known/${name}`))) throw new Error('Incomplete or oversized release');
  return manifest;
}
async function walk(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error('Symlinks are forbidden in artifacts');
    if (entry.isDirectory()) result.push(...await walk(root, path));
    else if (entry.isFile()) result.push(path);
    else throw new Error('Artifact must contain regular files only');
  }
  return result.sort();
}
export async function packageRelease(dist, output, sha) {
  if (!shaPattern.test(sha)) throw new Error('Release must use a full commit SHA');
  await mkdir(output); // Refuse accidental replacement of an existing artifact.
  for (const path of await walk(dist)) {
    metadata(path);
    await mkdir(dirname(join(output, path)), { recursive: true });
    await writeFile(join(output, path), await readFile(join(dist, path)));
  }
  for (const name of associationNames) {
    const path = `.well-known/${name}`;
    const bytes = await readFile(join(sourceRoot, 'frontend/public', path));
    JSON.parse(bytes.toString('utf8'));
    await mkdir(dirname(join(output, path)), { recursive: true });
    await writeFile(join(output, path), bytes);
  }
  const files = [];
  for (const path of await walk(output)) {
    const bytes = await readFile(join(output, path));
    files.push({ path, bytes: bytes.length, sha256: hash(bytes), ...metadata(path) });
  }
  const manifest = validateManifest({ version: 1, sha, files });
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
export async function loadBundle(root) {
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Bundle directory cannot be a symlink');
  const manifest = validateManifest(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')));
  const actual = await walk(root);
  if (actual.length !== manifest.files.length + 1 || actual.some(path => path !== 'manifest.json' && !manifest.files.some(file => file.path === path))) throw new Error('Unexpected bundle contents');
  for (const file of manifest.files) {
    const bytes = await readFile(join(root, file.path));
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error(`Artifact checksum mismatch: ${file.path}`);
  }
  for (const name of associationNames) JSON.parse(await readFile(join(root, '.well-known', name), 'utf8'));
  return { root, manifest };
}

export function awsStorage(env = process.env) {
  const bucket = env.LANDING_BUCKET;
  const distribution = env.LANDING_DISTRIBUTION_ID;
  const domain = env.LANDING_CLOUDFRONT_DOMAIN;
  if (!/^gizu-landing-[0-9]{12}$/.test(bucket ?? '') || !/^[A-Z0-9]+$/.test(distribution ?? '') || !/^[a-z0-9]+\.cloudfront\.net$/.test(domain ?? '')) throw new Error('Invalid AWS landing configuration');
  function aws(args) {
    return execFileSync('aws', [...args, '--no-cli-pager'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  async function get(key, target) {
    try { aws(['s3api', 'get-object', '--bucket', bucket, '--key', key, target]); return true; }
    catch (error) {
      if (/\(NoSuchKey\)|\(404\)/.test(String(error.stderr))) return false;
      throw new Error(`Cannot read release object: ${key}`);
    }
  }
  return {
    get,
    async put(key, file, meta, immutable = false) {
      const args = ['s3api', 'put-object', '--bucket', bucket, '--key', key, '--body', file, '--content-type', meta.contentType, '--cache-control', meta.cacheControl, '--metadata', `sha256=${meta.sha256}`];
      if (immutable) args.push('--if-none-match', '*');
      try { aws(args); }
      catch {
        if (immutable) {
          // A retry may find files from an earlier interrupted upload. Compare
          // actual bytes; matching user-supplied metadata alone is insufficient.
          const temp = await mkdtemp(join(tmpdir(), 'gizu-existing-'));
          try {
            const existing = join(temp, 'object');
            if (await get(key, existing) && hash(await readFile(existing)) === meta.sha256) return;
          } finally { await rm(temp, { recursive: true, force: true }); }
        }
        throw new Error(`Cannot write release object: ${key}`);
      }
    },
    async invalidate() {
      const result = JSON.parse(aws(['cloudfront', 'create-invalidation', '--distribution-id', distribution, '--paths', '/*']));
      aws(['cloudfront', 'wait', 'invalidation-completed', '--distribution-id', distribution, '--id', result.Invalidation.Id]);
    },
    async verify(bundle) {
      for (const path of ['index.html', ...associationNames.map(name => `.well-known/${name}`)]) {
        const response = await fetch(`https://${domain}/${path === 'index.html' ? '' : path}`, { redirect: 'error', signal: AbortSignal.timeout(30000) });
        const bytes = Buffer.from(await response.arrayBuffer());
        const expected = bundle.manifest.files.find(file => file.path === path);
        if (response.status !== 200 || hash(bytes) !== expected.sha256 || (path.startsWith('.well-known/') && !response.headers.get('content-type')?.startsWith('application/json'))) throw new Error(`CloudFront release verification failed: ${path}`);
      }
    },
  };
}

export async function archivedBundle(storage, sha, root) {
  if (!shaPattern.test(sha)) throw new Error('Invalid archived release SHA');
  await mkdir(root);
  if (!await storage.get(`archive/${sha}/manifest.json`, join(root, 'manifest.json'))) throw new Error('Archived release does not exist');
  const manifest = validateManifest(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')));
  if (manifest.sha !== sha) throw new Error('Archive identity mismatch');
  for (const file of manifest.files) {
    await mkdir(dirname(join(root, file.path)), { recursive: true });
    if (!await storage.get(`archive/${sha}/${file.path}`, join(root, file.path))) throw new Error('Incomplete archive');
  }
  return loadBundle(root);
}
async function writeJson(storage, key, root, name, value, immutable = false) {
  const path = join(root, name);
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  await writeFile(path, bytes);
  await storage.put(key, path, { contentType: 'application/json', cacheControl: 'no-store', sha256: hash(bytes) }, immutable);
}
async function publish(storage, bundle) {
  // Old hashed assets remain available; publish the HTML entry point last.
  const files = [...bundle.manifest.files].sort((a, b) => Number(a.path === 'index.html') - Number(b.path === 'index.html'));
  for (const file of files) await storage.put(`site/${file.path}`, join(bundle.root, file.path), file);
  await storage.invalidate();
  await storage.verify(bundle);
}
export async function deployRelease(storage, bundle) {
  const scratch = await mkdtemp(join(tmpdir(), 'gizu-release-'));
  try {
    const previousPath = join(scratch, 'previous.json');
    let previous;
    if (await storage.get('control/current.json', previousPath)) {
      previous = JSON.parse(await readFile(previousPath, 'utf8'));
      if (!shaPattern.test(previous.sha)) throw new Error('Invalid current-release pointer');
    }
    // Verify rollback material before touching the live prefix.
    const oldBundle = previous ? await archivedBundle(storage, previous.sha, join(scratch, 'old')) : null;
    // Restoring an older association can remove identities needed by installed
    // signed apps. Identity changes need their own native-aware rollout.
    if (oldBundle) for (const name of associationNames) {
      const path = `.well-known/${name}`;
      const oldHash = oldBundle.manifest.files.find(file => file.path === path).sha256;
      const nextHash = bundle.manifest.files.find(file => file.path === path).sha256;
      if (oldHash !== nextHash) throw new Error('Passkey association changes need a separately reviewed rollout before automatic rollback is safe');
    }
    for (const file of bundle.manifest.files) await storage.put(`archive/${bundle.manifest.sha}/${file.path}`, join(bundle.root, file.path), file, true);
    await writeJson(storage, `archive/${bundle.manifest.sha}/manifest.json`, scratch, 'manifest.json', bundle.manifest, true);
    try {
      await publish(storage, bundle);
      await writeJson(storage, 'control/current.json', scratch, 'current.json', { sha: bundle.manifest.sha, previous: previous?.sha ?? null });
    } catch (error) {
      if (!oldBundle) throw new Error(`${error.message}; first deployment has no previous release to restore`);
      try {
        await publish(storage, oldBundle);
        await writeJson(storage, 'control/current.json', scratch, 'current.json', previous);
      } catch (recovery) { throw new Error(`${error.message}; RECOVERY FAILED: ${recovery.message}`); }
      throw new Error(`${error.message}; previous release restored, deployment remains failed`);
    }
    return bundle.manifest.sha;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

async function main() {
  const [command, first, second, third] = process.argv.slice(2);
  if (command === 'package' && first && second && third) {
    await packageRelease(resolve(first), resolve(second), third);
  } else if (command === 'deploy' && first) {
    console.log(`Deployed ${await deployRelease(awsStorage(), await loadBundle(resolve(first)))}`);
  } else if (command === 'rollback' && shaPattern.test(first ?? '')) {
    const temp = await mkdtemp(join(tmpdir(), 'gizu-rollback-'));
    try {
      const storage = awsStorage();
      console.log(`Restored ${await deployRelease(storage, await archivedBundle(storage, first, join(temp, 'bundle')))}`);
    } finally { await rm(temp, { recursive: true, force: true }); }
  } else throw new Error('Usage: release.mjs package DIST OUTPUT SHA | deploy BUNDLE | rollback SHA');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
