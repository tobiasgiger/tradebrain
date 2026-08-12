#!/usr/bin/env node
// NQ Pause-Board — Backend-Skript
//
// Ruft die Anthropic Messages API mit dem web_search-Tool auf, schätzt die
// Marktlage für NQ-Futures ein und schreibt:
//   - data/status.json   (volle Einschätzung fürs Frontend)
//   - data/signal.json    (kompaktes Pause-Flag für Trading-Bots)
//   - data/history.json   (Verlauf der Gesamt-Ampel)
// und schickt bei Eskalation nach ROT (bzw. Entwarnung) einen Push.
//
// Design-Entscheidungen:
//  - Das Modell liefert KOMPAKTE Codes (24-Zeichen G/Y/R) + 6 Kommentare +
//    Quellen + Confidence. Die Uhrzeiten berechnet das Skript deterministisch
//    (Europe/Zurich) und mappt sie per Index auf die Codes.
//  - Termin-Cross-Check: nur verifizierte exakte High-Impact-Termine und die
//    gepflegte FOMC-Liste dürfen ROT deterministisch erzwingen.
//  - Bei API-/Validierungsfehlern: 3 Versuche mit Backoff, alte Dateien bleiben
//    unangetastet und der Prozess endet mit einem Fehlerstatus.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CODE_TO_STATUS,
  parseEventPreHours,
  validateModelResponse,
  validateRiskCodes,
  zurichInstantFromModelTerm,
} from './assessment-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const STATUS_PATH = join(DATA_DIR, 'status.json');
const SIGNAL_PATH = join(DATA_DIR, 'signal.json');
const HISTORY_PATH = join(DATA_DIR, 'history.json');

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const BOARD_URL = process.env.BOARD_URL || 'https://tobiasgiger.github.io/tradebrain/';
const TIMEZONE = 'Europe/Zurich';
const MAX_ATTEMPTS = 3;
const HISTORY_MAX = 200;

// App-/Generator-Version. KEEP IN SYNC mit APP_VERSION in index.html.
const APP_VERSION = '1.8.0';

const RANK = { gruen: 0, gelb: 1, rot: 2 };
const worst = (a, b) => (RANK[a] >= RANK[b] ? a : b);

// FOMC-Zinsentscheide (Zurich 20:00). KEEP IN SYNC mit index.html FOMC_DATES.
const FOMC_DATES = new Set([
  '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18',
  '2025-07-30', '2025-09-17', '2025-10-29', '2025-12-10',
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17',
  '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09',
]);

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Zeit-Helfer (Europe/Zurich)
// ---------------------------------------------------------------------------

function zurichHourLabel(date) {
  return new Intl.DateTimeFormat('de-CH', {
    timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date); // "14:00"
}

function zurichDateTime(date) {
  return new Intl.DateTimeFormat('de-CH', {
    timeZone: TIMEZONE, weekday: 'short', day: '2-digit', month: '2-digit',
    year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date);
}

// Kalender-Bestandteile eines Zeitpunkts in Zürcher Lokalzeit.
function zurichParts(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour };
}

// Nur die gepflegte, exakte FOMC-Tabelle ist ein autoritativer fester Anker.
// Ungefähre NFP/CPI/PCE-Wiederholungsmuster bleiben reine Frontend-Hinweise.
function exactEventAtSlot(date) {
  const { y, mo, d, h } = zurichParts(date);
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (h === 20 && FOMC_DATES.has(iso)) return 'FOMC';         // 20:00
  return null;
}

// Event, das in DIESER Stunde oder in den nächsten eventPreHours Stunden liegt.
// Berücksichtigt exakte Anker UND validierte, recherchierte High-Impact-
// Termine (extraHours: Map<hourMs, name>). Gibt { ev, hoursAhead } zurück.
function eventWindowForSlot(date, extraHours, eventPreHours) {
  for (let k = 0; k <= eventPreHours; k++) {
    const probe = new Date(date.getTime() + k * 3600_000);
    const name = exactEventAtSlot(probe) || (extraHours && extraHours.get(probe.getTime()));
    if (name) return { ev: name, hoursAhead: k };
  }
  return null;
}

// Validiert die vom Modell gelieferte Terminliste und wandelt sie in absolute
// Zeitpunkte. Liefert { termine, extraHours }:
//  - termine: sortierte Liste [{ name, ts, impact }] für die Anzeige (nächste 7 Tage)
//  - extraHours: Map<hourMs, name> der High-Impact-Termine (impact "hoch") für den
//    Cross-Check (erzwingen ROT + Vorlauf).
function parseTermine(model, now) {
  const termine = [];
  const extraHours = new Map();
  const list = model.termine;
  const maxTs = now.getTime() + 7 * 86400_000;
  for (const t of list) {
    const inst = zurichInstantFromModelTerm(t);
    if (inst.getTime() <= now.getTime() || inst.getTime() > maxTs) continue;
    const impact = t.impact;
    const name = t.name.slice(0, 60);
    termine.push({ name, ts: inst.toISOString(), impact });
    if (impact === 'hoch') {
      const hourMs = Math.floor(inst.getTime() / 3600_000) * 3600_000;
      if (!extraHours.has(hourMs)) extraHours.set(hourMs, name);
    }
  }
  termine.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  return { termine: termine.slice(0, 12), extraHours };
}

// ---------------------------------------------------------------------------
// Code-Expansion & Cross-Check
// ---------------------------------------------------------------------------

function expandCodes(codes, startHour, comments = []) {
  validateRiskCodes(codes);
  const out = [];
  for (let i = 0; i < 24; i++) {
    const time = new Date(startHour.getTime() + i * 3600_000);
    // ts = absoluter Zeitstempel der Stunde. Das Frontend beschriftet daraus in
    // Gerätezeit und positioniert den "Jetzt"-Marker nach echter aktueller Zeit.
    const status = CODE_TO_STATUS[codes[i]];
    if (!status) throw new Error(`Unbekannter Risiko-Code an Position ${i}`);
    const entry = { stunde: zurichHourLabel(time), ts: time.toISOString(), status };
    if (comments[i] != null) entry.kommentar = String(comments[i]);
    out.push(entry);
  }
  return out;
}

// Erzwingt ROT in der Event-Stunde UND den konfigurierten Stunden davor.
// Gibt { index: { ev, hoursAhead } } zurück.
function applyCrossCheck(entries, startHour, extraHours, eventPreHours) {
  const labels = {};
  entries.forEach((e, i) => {
    const hit = eventWindowForSlot(new Date(startHour.getTime() + i * 3600_000), extraHours, eventPreHours);
    if (hit) { e.status = 'rot'; labels[i] = hit; }
  });
  return labels;
}

function extractJson(text) {
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Kein JSON-Objekt in der Modellantwort gefunden');
  }
  return JSON.parse(t.slice(start, end + 1));
}

// ---------------------------------------------------------------------------
// Anthropic API
// ---------------------------------------------------------------------------

function buildPrompt(now) {
  const nowUtc = now.toISOString();
  const nowLocal = zurichDateTime(now);
  return `Du bist ein Risiko-Analyst für NQ-Futures (Nasdaq-100) im Mean-Reversion-Trading.
Aufgabe: Beurteile, wann automatisierte Trading-Bots wegen Marktrisiko (News, Geopolitik, Wirtschaftsdaten) besser pausiert werden sollten.

NOW exakt in UTC: ${nowUtc}
NOW formatiert in ${TIMEZONE}: ${nowLocal}

Recherchiere mit dem web_search-Tool die aktuelle Lage:
- Geopolitik: Naher Osten / Iran / Israel, Ukraine / Russland (aktive Eskalation?)
- US-Wirtschaftsdaten: NFP, CPI, FOMC, PCE — was steht heute / in den nächsten 24h an?
- Marktbewegung & Volatilität (z.B. VIX), relevante Schlagzeilen der letzten Stunden

Bevorzuge für US-Makrotermine Primärquellen: BLS, Federal Reserve, BEA,
US Census Bureau oder die jeweils verantwortliche US-Behörde. Sekundäre Kalender
dürfen ergänzen, aber ein nicht verlässlich verifizierbares Datum ist wegzulassen.

Antworte AUSSCHLIESSLICH mit EINEM JSON-Objekt — kein Markdown, kein Text davor/danach — mit exakt diesen Feldern:

{
  "status": "gruen | gelb | rot — Risiko exakt NOW; muss forecastCodes[0] entsprechen",
  "dayStatus": "gruen | gelb | rot — breiteres Tages-/Gesamtbild",
  "statusText": "kurzer Titel, max. 40 Zeichen",
  "empfehlung": "konkrete Handlungsempfehlung, 1 Satz",
  "headline": "Ticker-Zeile, max. 80 Zeichen",
  "body": "Begründung der Tages-Ampel, 2-3 Sätze",
  "confidence": "niedrig | mittel | hoch",
  "quellen": [ { "titel": "Kurztitel der Quelle", "url": "https://..." } ],
  "termine": [ { "name": "US Core PPI", "datum": "2026-08-13", "zeitZurich": "14:30", "impact": "hoch" } ],
  "rueckblickSummary": "letzte 24h, 2-3 Sätze",
  "rueckblickCodes": "GENAU 24 Zeichen aus G/Y/R, ein Zeichen pro Stunde, ÄLTESTE zuerst",
  "ausblickSummary": "nächste 24h, 2-3 Sätze",
  "forecastCodes": "GENAU 24 Zeichen aus G/Y/R, chronologisch ab der aktuellen Stunde",
  "forecastKommentare": ["genau 6 kurze Sätze — je einer für die ersten 6 Zukunftsstunden"]
}

Ampel-Kriterien je Stunde:
- R (rot): aktive geopolitische Eskalation, starke Marktbewegung, ODER High-Impact-Release (NFP / CPI / FOMC) in dem Stundenfenster.
- Y (gelb): erhöhte Unsicherheit, US-Cash-Open (~15:30 ${TIMEZONE}), Power-Hour-Close (~22:00 ${TIMEZONE}), kleinere Termine.
- G (grün): sonst.

Zeitliche Pflichtregeln:
- status, statusText, empfehlung, headline und body beschreiben das Risiko exakt NOW.
- Jeder Termin-Zeitstempel vor NOW ist VERGANGEN. Ein Ereignis von früher am selben Tag ist ebenfalls VERGANGEN.
- Beschreibe niemals ein vergangenes Ereignis als bevorstehend und berechne nie einen Countdown vom falschen Datum oder Ereignis.
- Nach einem Ereignis darf es nur dann relevant bleiben, wenn tatsächlich beobachtetes Marktverhalten nach der Veröffentlichung noch gefährlich ist. Benenne das ausdrücklich als Post-Event-/Nachwirkungsrisiko.
- Andernfalls richte den Vorwärtsblick auf den nächsten echten zukünftigen Termin.
- forecastCodes[0] repräsentiert die aktuelle Stunde und status muss vor den deterministischen Skript-Overrides semantisch exakt dazu passen.
- dayStatus ist ausschließlich das separat ausgewiesene breitere Tagesbild und darf von status abweichen.
- Erfinde keine Daten. Wenn ein Termin nicht verlässlich verifiziert werden kann, lasse ihn weg.

Zum Feld "termine": Recherchiere den US-Wirtschaftskalender der nächsten 7 Tage und liste ALLE relevanten Termine einzeln auf — CPI, Core CPI, PPI, Core PPI, Retail Sales, NFP, FOMC, PCE, ISM, Jobless Claims, GDP usw. Jeder Eintrag mit exaktem "datum" (YYYY-MM-DD), "zeitZurich" (HH:MM in Europe/Zurich) und "impact" ("hoch" oder "mittel"). "hoch" = markttreibende Releases (CPI/Core CPI, PPI/Core PPI, NFP, FOMC, PCE, Retail Sales) → sie erzwingen automatisch ein rotes Vorlauf-Fenster. Nenne echte, recherchierte Daten; wenn ein Datum unsicher ist, lass den Eintrag weg statt zu raten.

Wichtig: "rueckblickCodes"/"forecastCodes" müssen EXAKT 24 Zeichen lang sein. "forecastKommentare" genau 6 Einträge. "quellen" 2-4 wichtigste Quellen mit echten URLs aus deiner Recherche. Keine Uhrzeiten im Ampel-Teil ausgeben.`;
}

async function callModel(prompt) {
  const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];
  let messages = [{ role: 'user', content: prompt }];

  for (let cont = 0; cont < 4; cont++) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 2000, tools, messages }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${errText.slice(0, 500)}`);
    }
    const data = await res.json();
    if (data.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: data.content });
      continue;
    }
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (!text.trim()) throw new Error('Leere Textantwort vom Modell');
    return text;
  }
  throw new Error('Zu viele pause_turn-Fortsetzungen');
}

async function fetchWithRetry(prompt, now, { callModelFn = callModel, sleepFn = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)), maxAttempts = MAX_ATTEMPTS } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      log(`API-Aufruf Versuch ${attempt}/${maxAttempts} (Modell: ${MODEL})`);
      const parsed = extractJson(await callModelFn(prompt));
      return validateModelResponse(parsed, now);
    } catch (err) {
      lastErr = err;
      log(`Versuch ${attempt} fehlgeschlagen: ${err.message}`);
      if (attempt < maxAttempts) await sleepFn(2000 * 2 ** (attempt - 1));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Aufbau von status.json (inkl. Cross-Check)
// ---------------------------------------------------------------------------

function buildStatusJson(model, now, eventPreHours = 2) {
  const topOfHour = new Date(Math.floor(now.getTime() / 3600_000) * 3600_000);
  const rueckblickStart = new Date(topOfHour.getTime() - 24 * 3600_000);
  const forecastStart = topOfHour;

  const rueckblick = expandCodes(model.rueckblickCodes, rueckblickStart);
  const forecast = expandCodes(model.forecastCodes, forecastStart);

  // Live-Terminkalender aus der Modell-Recherche (CPI, PPI, Retail Sales …).
  const { termine, extraHours } = parseTermine(model, now);

  // Termin-Cross-Check: nur exakte Anker und validierte Live-High-Impact-Termine.
  applyCrossCheck(rueckblick, rueckblickStart, extraHours, eventPreHours);
  const forecastLabels = applyCrossCheck(forecast, forecastStart, extraHours, eventPreHours);

  const kommentare = model.forecastKommentare;
  const forecastDetail = forecast.slice(0, 6).map((h, i) => {
    const entry = { stunde: h.stunde, ts: h.ts, status: h.status, kommentar: kommentare[i] || '' };
    const lab = forecastLabels[i];
    if (lab) {
      const tag = lab.hoursAhead > 0 ? `${lab.ev} in ${lab.hoursAhead}h` : lab.ev;
      entry.kommentar = `⚠ ${tag}: ${entry.kommentar}`.trim();
    }
    return entry;
  });

  const currentHourStatus = forecast[0].status;
  // Das breitere Tagesbild bleibt separat und nie ruhiger als die aktuelle Stunde.
  const dayStatus = worst(model.dayStatus, currentHourStatus);
  let empfehlung = model.empfehlung;
  const nowLab = forecastLabels[0];
  if (nowLab) {
    empfehlung = nowLab.hoursAhead > 0
      ? `⚠️ ${nowLab.ev} in ~${nowLab.hoursAhead}h — Bots rechtzeitig pausieren. ${empfehlung}`
      : `⚠️ ${nowLab.ev} jetzt im aktuellen Stundenfenster — Bots pausieren. ${empfehlung}`;
  }

  return {
    generatedAt: now.toISOString(),
    appVersion: APP_VERSION,
    status: dayStatus,
    dayStatus,
    currentHourStatus,
    statusText: model.statusText.slice(0, 60),
    empfehlung,
    headline: model.headline.slice(0, 120),
    body: model.body,
    confidence: model.confidence,
    quellen: model.quellen.map((q) => ({ titel: q.titel.slice(0, 120), url: q.url })),
    rueckblickSummary: model.rueckblickSummary,
    rueckblick,
    ausblickSummary: model.ausblickSummary,
    forecast,
    forecastDetail,
    termine,
  };
}

function buildSignal(statusJson) {
  const effective = statusJson.currentHourStatus;
  return {
    generatedAt: statusJson.generatedAt,
    appVersion: APP_VERSION,
    effectiveStatus: effective,
    pause: effective === 'rot',
    caution: effective === 'gelb',
    dayStatus: statusJson.dayStatus,
    currentHourStatus: effective,
    statusText: statusJson.statusText,
    empfehlung: statusJson.empfehlung,
    source: 'nq-pause-board',
  };
}

// ---------------------------------------------------------------------------
// Push-Benachrichtigung (ntfy und/oder Telegram; optional)
// ---------------------------------------------------------------------------

async function sendPush(title, message, tag) {
  const tasks = [];
  const ntfyTopic = process.env.NTFY_TOPIC;
  if (ntfyTopic) {
    const server = process.env.NTFY_SERVER || 'https://ntfy.sh';
    tasks.push(
      fetch(`${server}/${ntfyTopic}`, {
        method: 'POST',
        headers: { Title: title, Click: BOARD_URL, Tags: tag, Priority: 'high' },
        body: message,
      }).then((r) => { if (!r.ok) throw new Error('ntfy ' + r.status); })
    );
  }
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChat = process.env.TELEGRAM_CHAT_ID;
  if (tgToken && tgChat) {
    tasks.push(
      fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: tgChat,
          text: `${title}\n\n${message}\n\n${BOARD_URL}`,
          disable_web_page_preview: true,
        }),
      }).then((r) => { if (!r.ok) throw new Error('telegram ' + r.status); })
    );
  }
  if (!tasks.length) {
    log('Push übersprungen: keine Kanäle konfiguriert (NTFY_TOPIC / TELEGRAM_*).');
    return;
  }
  const results = await Promise.allSettled(tasks);
  results.forEach((r) => { if (r.status === 'rejected') log('Push-Fehler: ' + r.reason.message); });
  log(`Push versendet (${results.filter((r) => r.status === 'fulfilled').length}/${tasks.length} Kanäle).`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function writeSnapshotAtomically(files) {
  mkdirSync(DATA_DIR, { recursive: true });
  const token = `${process.pid}-${Date.now()}`;
  const prepared = files.map(({ path, value }) => ({
    path,
    value,
    temp: `${path}.${token}.tmp`,
    backup: `${path}.${token}.bak`,
    hadOriginal: existsSync(path),
  }));
  const movedOriginals = [];
  const installed = [];

  try {
    for (const file of prepared) {
      writeFileSync(file.temp, JSON.stringify(file.value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    }
    for (const file of prepared) {
      if (file.hadOriginal) {
        renameSync(file.path, file.backup);
        movedOriginals.push(file);
      }
    }
    for (const file of prepared) {
      renameSync(file.temp, file.path);
      installed.push(file);
    }
  } catch (err) {
    for (const file of installed.reverse()) {
      if (existsSync(file.path)) rmSync(file.path, { force: true });
    }
    for (const file of movedOriginals.reverse()) {
      if (existsSync(file.backup)) renameSync(file.backup, file.path);
    }
    throw err;
  } finally {
    for (const file of prepared) {
      if (existsSync(file.temp)) rmSync(file.temp, { force: true });
    }
  }

  for (const file of movedOriginals) {
    if (existsSync(file.backup)) rmSync(file.backup, { force: true });
  }
}

async function main() {
  let eventPreHours;
  try {
    eventPreHours = parseEventPreHours(process.env.EVENT_PRE_HOURS);
  } catch (err) {
    log(`FEHLER: ${err.message}. Dateien bleiben unverändert.`);
    throw err;
  }
  if (!API_KEY) {
    log('FEHLER: ANTHROPIC_API_KEY ist nicht gesetzt. Dateien bleiben unverändert.');
    throw new Error('ANTHROPIC_API_KEY fehlt');
  }

  const now = new Date();
  let model;
  try {
    model = await fetchWithRetry(buildPrompt(now), now);
  } catch (err) {
    log(`FEHLER: Alle ${MAX_ATTEMPTS} Versuche fehlgeschlagen (${err.message}).`);
    log('Bestehende Dateien bleiben unverändert. Der Workflow wird als fehlgeschlagen markiert.');
    throw err;
  }

  try {
    const statusJson = buildStatusJson(model, now, eventPreHours);
    const signal = buildSignal(statusJson);
    const effective = signal.effectiveStatus;

    // Vorherigen Zustand für Transition-Erkennung lesen.
    const prevEffective = readJsonSafe(SIGNAL_PATH)?.effectiveStatus || null;

    // Verlauf behält seine bisherige Tages-/Gesamtstatus-Semantik; alte Einträge
    // werden weder umgeschrieben noch nachträglich neu interpretiert.
    const previousHistory = readJsonSafe(HISTORY_PATH);
    const history = Array.isArray(previousHistory) ? previousHistory : [];
    history.push({ generatedAt: now.toISOString(), status: statusJson.dayStatus });

    // Alle drei zusammengehörigen Dateien werden erst nach vollständigem Aufbau
    // als ein Snapshot installiert. Bei einem Fehler werden die Originale restauriert.
    writeSnapshotAtomically([
      { path: STATUS_PATH, value: statusJson },
      { path: SIGNAL_PATH, value: signal },
      { path: HISTORY_PATH, value: history.slice(-HISTORY_MAX) },
    ]);

    log(`OK: geschrieben (Tag=${statusJson.dayStatus}, aktuelle Stunde=${effective}, vorher=${prevEffective ?? 'n/a'}).`);

    // Push nur bei Zustandswechsel.
    if (effective === 'rot' && prevEffective !== 'rot') {
      await sendPush(
        'NQ Pause-Board: ROT',
        `⚠️ ${statusJson.headline}\n\nEmpfehlung: ${statusJson.empfehlung}`,
        'rotating_light'
      );
    } else if (prevEffective === 'rot' && effective !== 'rot') {
      await sendPush(
        'NQ Pause-Board: Entwarnung',
        `✅ Lage entspannt (${effective}). ${statusJson.statusText}`,
        'white_check_mark'
      );
    }
  } catch (err) {
    log(`FEHLER beim Aufbau/Schreiben: ${err.message}`);
    log('Bestehende Dateien bleiben unverändert; der Workflow wird als fehlgeschlagen markiert.');
    throw err;
  }
}

export {
  applyCrossCheck,
  buildPrompt,
  buildSignal,
  buildStatusJson,
  exactEventAtSlot,
  fetchWithRetry,
  parseTermine,
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.exitCode = 1; });
}
