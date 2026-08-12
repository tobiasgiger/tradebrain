import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import helpers from '../scripts/dashboard-helpers.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(testDir, 'fixtures', 'correctness-reproduction.json'), 'utf8'));
const {
  filterFutureEvents,
  generationsMatch,
  loadCoherentSnapshot,
  normStatus,
  selectCurrentHourlySlot,
  signalInvariantValid,
  snapshotCoherent,
} = helpers;

function coherentPair(generatedAt = '2026-08-12T20:31:43.000Z') {
  const status = {
    generatedAt,
    currentHourStatus: 'gruen',
    forecast: [{ ts: '2026-08-12T20:00:00.000Z', status: 'gruen' }],
  };
  const signal = {
    generatedAt,
    currentHourStatus: 'gruen',
    effectiveStatus: 'gruen',
    pause: false,
    caution: false,
  };
  return { status, signal };
}

test('upcoming events exclude completed CPI and sort PPI as the next event', () => {
  const future = filterFutureEvents(fixture.events, new Date(fixture.now));
  assert.deepEqual(future.map((event) => event.name), ['US PPI']);
});

test('snapshot generation mismatch is detected and equal generations are accepted', () => {
  const { status, signal } = coherentPair();
  assert.equal(generationsMatch(status, { ...signal, generatedAt: '2026-08-12T21:00:00.000Z' }), false);
  assert.equal(generationsMatch(status, signal), true);
  assert.equal(snapshotCoherent(status, signal), true);
});

test('snapshot loader retries the stale side with bounded coherent output', async () => {
  const a = coherentPair('2026-08-12T20:00:00.000Z');
  const b = coherentPair('2026-08-12T21:00:00.000Z');
  const calls = [];
  const fetchJson = async (name) => {
    calls.push(name);
    if (calls.length === 1) return a.status;
    if (calls.length === 2) return b.signal;
    return b.status;
  };
  const result = await loadCoherentSnapshot(fetchJson, { retries: 2 });
  assert.deepEqual(calls, ['status', 'signal', 'status']);
  assert.equal(result.coherent, true);
  assert.equal(result.status.generatedAt, b.signal.generatedAt);
});

test('dashboard status remains available when signal fetch repeatedly fails', async () => {
  const { status } = coherentPair();
  let signalAttempts = 0;
  const result = await loadCoherentSnapshot(async (name) => {
    if (name === 'status') return status;
    signalAttempts++;
    throw new Error('signal unavailable');
  }, { retries: 2 });
  assert.equal(result.status, status);
  assert.equal(result.signal, null);
  assert.equal(result.coherent, false);
  assert.equal(signalAttempts, 3);
});

test('same-generation contradictory bot flags are still treated as incoherent', () => {
  const { status, signal } = coherentPair();
  const bad = { ...signal, effectiveStatus: 'rot', currentHourStatus: 'rot', pause: true };
  assert.equal(generationsMatch(status, bad), true);
  assert.equal(signalInvariantValid(status, bad), false);
  assert.equal(snapshotCoherent(status, bad), false);
  assert.equal(signalInvariantValid(status, { ...signal, currentHourStatus: '' }), false);
});

test('unknown or corrupt statuses never normalize to green', () => {
  assert.equal(normStatus('gruen'), 'gruen');
  for (const invalid of ['GREEN', 'blue', '', null, undefined, 0]) {
    assert.equal(normStatus(invalid), 'unbekannt');
  }
});

test('current-hour selection uses the supplied actual time, not generation time', () => {
  const slots = [
    { ts: '2026-08-12T20:00:00.000Z', status: 'gruen' },
    { ts: '2026-08-12T21:00:00.000Z', status: 'rot' },
  ];
  assert.equal(selectCurrentHourlySlot(slots, new Date('2026-08-12T20:31:43.000Z')).status, 'gruen');
  assert.equal(selectCurrentHourlySlot(slots, new Date('2026-08-12T21:15:00.000Z')).status, 'rot');
  assert.equal(selectCurrentHourlySlot(slots, new Date('2026-08-13T00:00:00.000Z')), null);
});

test('frontend inline script parses and source URLs are assigned through DOM properties', () => {
  const html = readFileSync(join(testDir, '..', 'index.html'), 'utf8');
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/);
  assert.ok(script, 'inline script found');
  assert.doesNotThrow(() => new vm.Script(script[1]));
  assert.match(html, /link\.href = source\.url/);
  assert.doesNotMatch(html, /<a href="\$\{esc\(q\.url\)\}/);
});
