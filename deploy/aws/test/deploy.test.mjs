import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// Run on Linux, matching the host's GNU mv/flock behavior.
const script = resolve('deploy/aws/deploy.sh');
const sha = 'a'.repeat(40);
const image = `ghcr.io/nux-labs/gizu-app/api@sha256:${'b'.repeat(64)}`;
const oldImage = `ghcr.io/nux-labs/gizu-app/api@sha256:${'c'.repeat(64)}`;
function scenario(mode, previous = true) {
  const root = mkdtempSync(join(tmpdir(), 'gizu-deploy-'));
  const config = join(root, 'config');
  const bin = join(root, 'bin');
  for (const dir of [config, bin, join(root, 'state'), join(root, 'old')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(config, 'deploy-enabled'), '');
  writeFileSync(join(config, 'compose.yml'), '');
  for (const file of ['api-image', 'landing/index.html', 'frontend/index.html', 'associations/apple-app-site-association', 'associations/assetlinks.json']) {
    const path = join(root, 'incoming', sha, file);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, file === 'api-image' ? image : '{}');
  }
  if (previous) {
    symlinkSync(join(root, 'old'), join(root, 'current'));
    writeFileSync(join(root, 'state/api-image'), oldImage);
  }
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash
echo "$API_IMAGE $*" >> "$GIZU_ROOT/calls"
if [[ "$*" == *"pull api"* && "$MODE" == pull-fail ]]; then exit 1; fi
if [[ "$*" == *"up -d"* ]]; then
  if [[ "$MODE" == all-fail ]]; then exit 1; fi
  if [[ "$MODE" == unhealthy && "$API_IMAGE" == "${image}" ]]; then exit 1; fi
fi
`, { mode: 0o755 });
  const result = spawnSync('bash', [script, sha], {
    encoding: 'utf8', env: { ...process.env, GIZU_ROOT: root, GIZU_CONFIG: config, MODE: mode, PATH: `${bin}:${process.env.PATH}` },
  });
  return { root, result, calls: readFileSync(join(root, 'calls'), 'utf8') };
}
for (const mode of ['success', 'pull-fail', 'unhealthy', 'all-fail']) {
  test(`release transaction: ${mode}`, { skip: process.platform !== 'linux' }, () => {
    const { root, result, calls } = scenario(mode);
    try {
      assert.equal(result.status, mode === 'success' ? 0 : 1, result.stderr);
      assert.equal(readFileSync(join(root, 'state/api-image'), 'utf8').trim(), mode === 'success' ? image : oldImage);
      assert.equal(readlinkSync(join(root, 'current')), join(root, mode === 'success' ? `releases/${sha}` : 'old'));
      const restores = calls.split('\n').filter(line => line.startsWith(oldImage) && line.includes('up -d'));
      assert.equal(restores.length, ['unhealthy', 'all-fail'].includes(mode) ? 1 : 0);
      if (mode === 'pull-fail') assert.ok(!calls.includes('stop api'));
      if (mode === 'all-fail') assert.match(result.stderr, /RECOVERY FAILED/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
test('first deployment failure stops candidate and reports no rollback target', { skip: process.platform !== 'linux' }, () => {
  const { root, result, calls } = scenario('unhealthy', false);
  try {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No previous API exists/);
    assert.equal(calls.split('\n').filter(line => line.includes('up -d')).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
