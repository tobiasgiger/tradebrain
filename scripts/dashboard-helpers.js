(function attachTradebrainHelpers(root, factory) {
  const helpers = factory();
  if (typeof module === 'object' && module.exports) module.exports = helpers;
  if (root) root.TradebrainHelpers = helpers;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createTradebrainHelpers() {
  'use strict';

  const HOUR = 3600000;
  const VALID_STATUSES = new Set(['gruen', 'gelb', 'rot']);

  function normStatus(value) {
    return VALID_STATUSES.has(value) ? value : 'unbekannt';
  }

  function validDate(value) {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function filterFutureEvents(events, now = new Date()) {
    const nowDate = validDate(now);
    if (!nowDate || !Array.isArray(events)) return [];
    return events
      .map((event) => ({ event, date: event && validDate(event.ts) }))
      .filter(({ date }) => date && date.getTime() > nowDate.getTime())
      .sort((a, b) => a.date.getTime() - b.date.getTime())
      .map(({ event }) => event);
  }

  function selectCurrentHourlySlot(slots, now = new Date()) {
    const nowDate = validDate(now);
    if (!nowDate || !Array.isArray(slots)) return null;
    const nowMs = nowDate.getTime();
    return slots.find((slot) => {
      const start = slot && validDate(slot.ts);
      return start && start.getTime() <= nowMs && nowMs < start.getTime() + HOUR;
    }) || null;
  }

  function generationsMatch(status, signal) {
    return Boolean(
      status
      && signal
      && typeof status.generatedAt === 'string'
      && status.generatedAt.length
      && status.generatedAt === signal.generatedAt
    );
  }

  function expectedSignalStatus(status) {
    if (!status) return 'unbekannt';
    const explicit = normStatus(status.currentHourStatus);
    if (explicit !== 'unbekannt') return explicit;
    const generatedAt = validDate(status.generatedAt);
    const slot = generatedAt && selectCurrentHourlySlot(status.forecast, generatedAt);
    return normStatus(slot && slot.status);
  }

  function signalInvariantValid(status, signal) {
    const expected = expectedSignalStatus(status);
    const actual = normStatus(signal && signal.effectiveStatus);
    if (expected === 'unbekannt' || actual === 'unbekannt' || expected !== actual) return false;
    const currentValue = signal && Object.prototype.hasOwnProperty.call(signal, 'currentHourStatus')
      ? signal.currentHourStatus
      : signal.effectiveStatus;
    return signal.pause === (actual === 'rot')
      && signal.caution === (actual === 'gelb')
      && normStatus(currentValue) === actual;
  }

  function snapshotCoherent(status, signal) {
    return generationsMatch(status, signal) && signalInvariantValid(status, signal);
  }

  async function loadCoherentSnapshot(fetchJson, { retries = 2 } = {}) {
    let status = await fetchJson('status');
    let signal;
    try { signal = await fetchJson('signal'); } catch { signal = null; }

    async function refresh(name, current) {
      try { return await fetchJson(name); } catch { return current; }
    }

    for (let attempt = 0; attempt < retries && !snapshotCoherent(status, signal); attempt++) {
      const statusTime = Date.parse(status && status.generatedAt);
      const signalTime = Date.parse(signal && signal.generatedAt);
      if (!signal || (Number.isFinite(statusTime) && Number.isFinite(signalTime) && statusTime > signalTime)) {
        signal = await refresh('signal', signal);
      } else if (Number.isFinite(statusTime) && Number.isFinite(signalTime) && signalTime > statusTime) {
        status = await refresh('status', status);
      } else {
        status = await refresh('status', status);
        signal = await refresh('signal', signal);
      }
    }

    return { status, signal, coherent: snapshotCoherent(status, signal) };
  }

  function cacheBustedUrl(url, token = Date.now()) {
    const separator = String(url).includes('?') ? '&' : '?';
    return `${url}${separator}tb=${encodeURIComponent(String(token))}`;
  }

  return {
    HOUR,
    cacheBustedUrl,
    expectedSignalStatus,
    filterFutureEvents,
    generationsMatch,
    loadCoherentSnapshot,
    normStatus,
    selectCurrentHourlySlot,
    signalInvariantValid,
    snapshotCoherent,
  };
}));
