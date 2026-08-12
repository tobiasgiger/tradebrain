import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  parseEventPreHours,
  validateModelResponse,
  validateRiskCodes,
} from '../scripts/assessment-helpers.mjs';
import {
  buildPrompt,
  buildSignal,
  buildStatusJson,
  fetchWithRetry,
} from '../scripts/fetch-assessment.mjs';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..');
const fixture = JSON.parse(readFileSync(join(testDir, 'fixtures', 'correctness-reproduction.json'), 'utf8'));

function validModel(overrides = {}) {
  return {
    status: 'gruen',
    dayStatus: 'gruen',
    statusText: 'Aktuelle Stunde ruhig',
    empfehlung: 'Bots aktuell normal laufen lassen.',
    headline: 'Keine akute Störung in der aktuellen Stunde',
    body: 'Die aktuelle Marktlage ist ruhig und es besteht kein aktives Ereignisfenster.',
    confidence: 'mittel',
    quellen: [
      { titel: 'BLS', url: 'https://www.bls.gov/schedule/' },
      { titel: 'Federal Reserve', url: 'https://www.federalreserve.gov/newsevents/calendar.htm' },
    ],
    termine: [],
    rueckblickSummary: 'Der Rückblick zeigt keine akute Störung.',
    rueckblickCodes: 'G'.repeat(24),
    ausblickSummary: 'Der Ausblick zeigt derzeit keine verifizierte Störung.',
    forecastCodes: 'G'.repeat(24),
    forecastKommentare: Array.from({ length: 6 }, (_, index) => `Stunde ${index + 1} ohne verifizierte Störung.`),
    ...overrides,
  };
}

test('risk codes accept only an exact trimmed 24-character G/Y/R string', () => {
  const valid = 'GYR'.repeat(8);
  assert.equal(validateRiskCodes(valid), valid);
  assert.equal(validateRiskCodes(`  ${valid}\n`), valid);

  for (const invalid of [
    'G'.repeat(23),
    'G'.repeat(25),
    '',
    `${'G'.repeat(12)}X${'G'.repeat(11)}`,
    `${'G'.repeat(12)} ${'G'.repeat(11)}`,
    null,
    123,
  ]) {
    assert.throws(() => validateRiskCodes(invalid), /exakt 24|primitiver String/);
  }
});

test('strict model fields reject malformed values instead of repairing them', () => {
  const now = new Date('2026-08-12T20:31:43.000Z');
  const cases = [
    ['status', 'blue'],
    ['statusText', null],
    ['empfehlung', 7],
    ['headline', ''],
    ['body', null],
    ['confidence', 'unknown'],
    ['rueckblickSummary', []],
    ['ausblickSummary', null],
    ['quellen', []],
    ['termine', null],
    ['forecastKommentare', ['nur einer']],
  ];
  for (const [field, value] of cases) {
    const model = validModel();
    model[field] = value;
    assert.throws(() => validateModelResponse(model, now), /Ungültige Modellantwort/);
  }
  const nonStringComment = validModel();
  nonStringComment.forecastKommentare[3] = null;
  assert.throws(() => validateModelResponse(nonStringComment, now), /primitiver String/);
});

test('day red and current hour green produce a non-paused green bot signal', () => {
  const now = new Date(fixture.now);
  const model = validateModelResponse(structuredClone(fixture.model), now);
  const status = buildStatusJson(model, now, 2);
  const signal = buildSignal(status);

  assert.equal(status.status, 'rot');
  assert.equal(status.dayStatus, 'rot');
  assert.equal(status.currentHourStatus, 'gruen');
  assert.equal(signal.dayStatus, 'rot');
  assert.equal(signal.effectiveStatus, 'gruen');
  assert.equal(signal.currentHourStatus, 'gruen');
  assert.equal(signal.pause, false);
  assert.equal(signal.caution, false);
});

test('validated exact high-impact event in the configured window forces current hour red', () => {
  const now = new Date('2026-08-12T20:31:43.000Z');
  const model = validateModelResponse(validModel({
    termine: [{ name: 'US PPI', datum: '2026-08-12', zeitZurich: '23:30', impact: 'hoch' }],
  }), now);
  const status = buildStatusJson(model, now, 2);
  const signal = buildSignal(status);

  assert.equal(status.currentHourStatus, 'rot');
  assert.equal(signal.effectiveStatus, 'rot');
  assert.equal(signal.pause, true);
  assert.equal(signal.caution, false);
  assert.equal(buildStatusJson(model, now, 0).currentHourStatus, 'gruen');
});

test('approximate first-Friday recurrence alone cannot force red', () => {
  const now = new Date('2026-09-04T12:10:00.000Z'); // first Friday, 14:10 Zurich
  const model = validateModelResponse(validModel(), now);
  const status = buildStatusJson(model, now, 2);
  assert.equal(status.currentHourStatus, 'gruen');
  assert.equal(buildSignal(status).pause, false);
});

test('EVENT_PRE_HOURS allows zero and rejects invalid or excessive values', () => {
  assert.equal(parseEventPreHours(undefined), 2);
  assert.equal(parseEventPreHours(''), 2);
  assert.equal(parseEventPreHours('0'), 0);
  assert.equal(parseEventPreHours(0), 0);
  for (const invalid of ['-1', '-0.5', '1.5', 'text', 'NaN', '169', Infinity]) {
    assert.throws(() => parseEventPreHours(invalid), /EVENT_PRE_HOURS/);
  }
});

test('model contradiction is rejected and the retry path requests a fresh response', async () => {
  const now = new Date('2026-08-12T20:31:43.000Z');
  const contradictory = validModel({ status: 'rot', forecastCodes: 'G'.repeat(24) });
  assert.throws(() => validateModelResponse(contradictory, now), /widerspricht/);

  let calls = 0;
  const result = await fetchWithRetry('prompt', now, {
    maxAttempts: 2,
    sleepFn: async () => {},
    callModelFn: async () => JSON.stringify(++calls === 1 ? contradictory : validModel()),
  });
  assert.equal(calls, 2);
  assert.equal(result.status, 'gruen');
});

test('past same-day event and wrong-event countdown are rejected', () => {
  const now = new Date(fixture.now);
  const stale = structuredClone(fixture.model);
  stale.statusText = 'CPI-Release heute 14:30 Uhr Zürich';
  stale.empfehlung = 'Bots pausieren, CPI in ~16 Stunden.';
  assert.throws(() => validateModelResponse(stale, now), /vergangenen|keinen passenden/);
});

test('deterministic production reproduction keeps CPI past, PPI next, day red, and bot green', () => {
  const now = new Date(fixture.now);
  const model = validateModelResponse(structuredClone(fixture.model), now);
  const status = buildStatusJson(model, now, 2);
  const signal = buildSignal(status);

  assert.deepEqual(status.termine.map((event) => event.name), ['US PPI']);
  assert.match(status.headline, /PPI/);
  assert.doesNotMatch(status.statusText + status.empfehlung + status.headline + status.body, /CPI[^.]*\bin\s*[~≈]?\s*\d+\s*(?:h|Std|Stunden)/i);
  assert.equal(status.currentHourStatus, 'gruen');
  assert.equal(status.dayStatus, 'rot');
  assert.equal(signal.effectiveStatus, status.currentHourStatus);
  assert.equal(signal.pause, false);
});

test('prompt supplies exact UTC/Zurich time and the corrected temporal/source contract', () => {
  const prompt = buildPrompt(new Date(fixture.now));
  assert.match(prompt, /2026-08-12T20:31:43\.000Z/);
  assert.match(prompt, /Europe\/Zurich/);
  assert.match(prompt, /früher am selben Tag ist ebenfalls VERGANGEN/);
  assert.match(prompt, /forecastCodes\[0\]/);
  assert.match(prompt, /BLS, Federal Reserve, BEA/);
  assert.match(prompt, /dayStatus/);
});

test('missing API key exits non-zero without touching existing JSON', () => {
  const paths = ['status.json', 'signal.json', 'history.json'].map((name) => join(repoRoot, 'data', name));
  const before = paths.map((path) => readFileSync(path, 'utf8'));
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const result = spawnSync(process.execPath, ['scripts/fetch-assessment.mjs'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /ANTHROPIC_API_KEY/);
  assert.deepEqual(paths.map((path) => readFileSync(path, 'utf8')), before);
});
