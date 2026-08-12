const STATUS_VALUES = new Set(['gruen', 'gelb', 'rot']);
const CONFIDENCE_VALUES = new Set(['niedrig', 'mittel', 'hoch']);
const IMPACT_VALUES = new Set(['hoch', 'mittel']);
const CODE_TO_STATUS = { G: 'gruen', Y: 'gelb', R: 'rot' };
const DEFAULT_EVENT_PRE_HOURS = 2;
const MAX_EVENT_PRE_HOURS = 168;
const TIMEZONE = 'Europe/Zurich';

function fail(message) {
  throw new Error(`Ungültige Modellantwort: ${message}`);
}

function requiredString(value, field) {
  if (typeof value !== 'string') fail(`${field} muss ein String sein`);
  const trimmed = value.trim();
  if (!trimmed) fail(`${field} darf nicht leer sein`);
  return trimmed;
}

function validCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  return date.getUTCFullYear() === +match[1]
    && date.getUTCMonth() === +match[2] - 1
    && date.getUTCDate() === +match[3];
}

function tzOffsetMin(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return (Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - date.getTime()) / 60000;
}

export function zurichInstantFromModelTerm(term) {
  const [year, month, day] = term.datum.split('-').map(Number);
  const [hour, minute] = term.zeitZurich.split(':').map(Number);
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  return new Date(naive - tzOffsetMin(new Date(naive), TIMEZONE) * 60000);
}

export function validateRiskCodes(value, field = 'Codes') {
  if (typeof value !== 'string') fail(`${field} muss ein primitiver String sein`);
  const trimmed = value.trim();
  if (!/^[GYR]{24}$/.test(trimmed)) {
    fail(`${field} muss nach dem Trimmen exakt 24 Zeichen aus G/Y/R enthalten`);
  }
  return trimmed;
}

export function parseEventPreHours(value, { defaultValue = DEFAULT_EVENT_PRE_HOURS, max = MAX_EVENT_PRE_HOURS } = {}) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return defaultValue;
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0 || parsed > max) {
    throw new Error(`EVENT_PRE_HOURS muss eine ganze Zahl zwischen 0 und ${max} sein`);
  }
  return parsed;
}

function validateSources(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 4) {
    fail('quellen muss 2 bis 4 Einträge enthalten');
  }
  return value.map((source, index) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) fail(`quellen[${index}] muss ein Objekt sein`);
    const titel = requiredString(source.titel, `quellen[${index}].titel`);
    const url = requiredString(source.url, `quellen[${index}].url`);
    let parsed;
    try { parsed = new URL(url); } catch { fail(`quellen[${index}].url ist keine gültige URL`); }
    if (!['http:', 'https:'].includes(parsed.protocol)) fail(`quellen[${index}].url muss http oder https verwenden`);
    return { titel, url };
  });
}

function validateTerms(value, now) {
  if (!Array.isArray(value)) fail('termine muss ein Array sein');
  return value.map((term, index) => {
    if (!term || typeof term !== 'object' || Array.isArray(term)) fail(`termine[${index}] muss ein Objekt sein`);
    const name = requiredString(term.name, `termine[${index}].name`);
    const datum = requiredString(term.datum, `termine[${index}].datum`);
    const zeitZurich = requiredString(term.zeitZurich, `termine[${index}].zeitZurich`);
    const impact = requiredString(term.impact, `termine[${index}].impact`);
    if (!validCalendarDate(datum)) fail(`termine[${index}].datum ist kein gültiges YYYY-MM-DD-Datum`);
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(zeitZurich)) fail(`termine[${index}].zeitZurich muss HH:MM sein`);
    if (!IMPACT_VALUES.has(impact)) fail(`termine[${index}].impact muss hoch oder mittel sein`);
    const normalized = { name, datum, zeitZurich, impact };
    const instant = zurichInstantFromModelTerm(normalized);
    if (!Number.isFinite(instant.getTime())) fail(`termine[${index}] hat keinen gültigen Zeitpunkt`);
    if (instant.getTime() <= now.getTime()) fail(`termine[${index}] liegt nicht in der Zukunft`);
    if (instant.getTime() > now.getTime() + 7 * 86400_000) fail(`termine[${index}] liegt außerhalb des 7-Tage-Horizonts`);
    return normalized;
  });
}

function zurichClockMinutes(date) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return +parts.hour * 60 + +parts.minute;
}

const AFTERMATH_WORDS = /\b(?:nach|seit|bereits|veröffentlicht|erschienen|erschien|vergangen|vorbei|erfolgte|reagiert|reaktion|nachwirkung|folgen|post[- ]?event|aftermath|war|kam)\b/i;
const MACRO_NAME = /\b(?:core\s+)?(?:cpi|ppi|pce|nfp|fomc)\b|\bretail\s+sales\b|\bjobless\s+claims\b/ig;

function matchingFutureTerm(terms, macroName) {
  const needle = macroName.toLowerCase().replace(/\s+/g, ' ').trim();
  return terms.find((term) => term.name.toLowerCase().replace(/\s+/g, ' ').includes(needle));
}

export function validateCurrentNarrative(model, now, terms) {
  const fields = ['statusText', 'empfehlung', 'headline', 'body', 'ausblickSummary'];
  const passages = fields.map((field) => ({ field, text: model[field] }))
    .concat(model.forecastKommentare.map((text, index) => ({ field: `forecastKommentare[${index}]`, text })));
  const nowMinutes = zurichClockMinutes(now);

  for (const { field, text } of passages) {
    const sentences = text.split(/(?<=[.!?])\s+|\n+/);
    for (const sentence of sentences) {
      if (/\bheute\b/i.test(sentence)) {
        const times = [...sentence.matchAll(/\b(?:um\s*)?([01]?\d|2[0-3]):([0-5]\d)\b/g)];
        for (const match of times) {
          const eventMinutes = +match[1] * 60 + +match[2];
          if (eventMinutes < nowMinutes && !AFTERMATH_WORDS.test(sentence)) {
            fail(`${field} beschreibt einen bereits vergangenen heutigen Zeitpunkt als aktuell/zukünftig`);
          }
        }
      }

      for (const countdown of sentence.matchAll(/\bin\s*[~≈]?\s*(\d+(?:[.,]\d+)?)\s*(?:h|std\.?|stunden)\b/ig)) {
        const contextStart = Math.max(0, countdown.index - 90);
        const context = sentence.slice(contextStart, countdown.index);
        const names = [...context.matchAll(MACRO_NAME)];
        if (!names.length) continue;
        const macroName = names.at(-1)[0];
        const term = matchingFutureTerm(terms, macroName);
        if (!term) fail(`${field} nennt einen Countdown für ${macroName}, aber keinen passenden künftigen Termin`);
        const claimedHours = Number(countdown[1].replace(',', '.'));
        const actualHours = (zurichInstantFromModelTerm(term).getTime() - now.getTime()) / 3600_000;
        if (Math.abs(actualHours - claimedHours) > 2) {
          fail(`${field} nennt einen unplausiblen Countdown für ${macroName}`);
        }
      }
    }
  }
}

export function validateModelResponse(value, now = new Date()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Antwort muss ein JSON-Objekt sein');
  if (!STATUS_VALUES.has(value.status)) fail('status muss gruen, gelb oder rot sein');
  if (!STATUS_VALUES.has(value.dayStatus)) fail('dayStatus muss gruen, gelb oder rot sein');
  if (!CONFIDENCE_VALUES.has(value.confidence)) fail('confidence muss niedrig, mittel oder hoch sein');

  const normalized = {
    ...value,
    statusText: requiredString(value.statusText, 'statusText'),
    empfehlung: requiredString(value.empfehlung, 'empfehlung'),
    headline: requiredString(value.headline, 'headline'),
    body: requiredString(value.body, 'body'),
    rueckblickSummary: requiredString(value.rueckblickSummary, 'rueckblickSummary'),
    ausblickSummary: requiredString(value.ausblickSummary, 'ausblickSummary'),
    rueckblickCodes: validateRiskCodes(value.rueckblickCodes, 'rueckblickCodes'),
    forecastCodes: validateRiskCodes(value.forecastCodes, 'forecastCodes'),
    quellen: validateSources(value.quellen),
  };

  if (!Array.isArray(value.forecastKommentare) || value.forecastKommentare.length !== 6) {
    fail('forecastKommentare muss genau 6 Einträge enthalten');
  }
  normalized.forecastKommentare = value.forecastKommentare.map((comment, index) => {
    if (typeof comment !== 'string') fail(`forecastKommentare[${index}] muss ein primitiver String sein`);
    return comment.trim();
  });
  normalized.termine = validateTerms(value.termine, now);

  const forecastNow = CODE_TO_STATUS[normalized.forecastCodes[0]];
  if (normalized.status !== forecastNow) {
    fail(`status (${normalized.status}) widerspricht forecastCodes[0] (${forecastNow})`);
  }
  validateCurrentNarrative(normalized, now, normalized.termine);
  return normalized;
}

export { CODE_TO_STATUS, DEFAULT_EVENT_PRE_HOURS, MAX_EVENT_PRE_HOURS, STATUS_VALUES };
