import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const root = join(testDir, '..');

test('all committed data files remain valid JSON', () => {
  for (const name of ['status.json', 'signal.json', 'history.json']) {
    assert.doesNotThrow(() => JSON.parse(readFileSync(join(root, 'data', name), 'utf8')), name);
  }
});

test('frontend and generator versions stay synchronized', () => {
  const backend = readFileSync(join(root, 'scripts', 'fetch-assessment.mjs'), 'utf8');
  const frontend = readFileSync(join(root, 'index.html'), 'utf8');
  const backendVersion = backend.match(/const APP_VERSION = '([^']+)'/)[1];
  const frontendVersion = frontend.match(/const APP_VERSION = '([^']+)'/)[1];
  assert.equal(backendVersion, frontendVersion);
  assert.equal(backendVersion, '1.8.0');
});

test('workflow explicitly requests and verifies Pages without force-pushing or changing Pages settings', () => {
  const workflow = readFileSync(join(root, '.github', 'workflows', 'update-assessment.yml'), 'utf8');
  assert.match(workflow, /contents:\s*write/);
  assert.match(workflow, /pages:\s*write/);
  assert.match(workflow, /id:\s*commit/);
  assert.match(workflow, /changed=true/);
  assert.match(workflow, /pushed_sha=/);
  assert.match(workflow, /gh api --method POST "repos\/\$GITHUB_REPOSITORY\/pages\/builds"/);
  assert.match(workflow, /pages\/builds\/latest/);
  assert.match(workflow, /build_sha" == "\$EXPECTED_SHA/);
  assert.doesNotMatch(workflow, /push[^\n]*(?:--force|-f\b)/);
  assert.doesNotMatch(workflow, /gh api --method (?:PUT|DELETE) "repos\/\$GITHUB_REPOSITORY\/pages/);
});
