'use strict';

/**
 * Decides WHICH downloads to do. Every download is a "task": one question to Flipkart (a state or list, plus a
 * date window) that is followed page by page. Tasks are saved in the database so a long download can stop and resume.
 */

const DAY = 86400000;
const IST_MS = 330 * 60 * 1000;
const POST_STATES = ['SHIPPED', 'DELIVERED', 'PICKUP_COMPLETE'];
const CANCEL_TYPES = ['buyerCancellation', 'sellerCancellation', 'marketplaceCancellation'];
const RETURN_SOURCES = ['customer_return', 'courier_return'];

/** Indian-time text without a zone, the way Flipkart's order search wants it: 2026-10-24T13:05:00 */
const istNaive = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 19);

/** Start of the Indian calendar day that contains `ms`. */
const istDayStart = (ms) => Math.floor((ms + IST_MS) / DAY) * DAY - IST_MS;

/** Splits [fromMs, toMs) into pieces of `stepDays`, newest piece first. */
function windows(fromMs, toMs, stepDays) {
  const out = [];
  for (let end = toMs; end > fromMs; end -= stepDays * DAY) {
    out.push({ from: Math.max(fromMs, end - stepDays * DAY), to: end });
  }
  return out;
}

const task = (kind, source, field, win) => ({
  kind, source, field: field || null,
  window_from: win ? new Date(win.from).toISOString() : null,
  window_to: win ? new Date(win.to).toISOString() : null
});

function ordersTasks(nowMs, days, states = POST_STATES) {
  const out = [];
  const from = istDayStart(nowMs - days * DAY);
  const to = istDayStart(nowMs) + DAY;         // end of today
  for (const win of windows(from, to, 7)) for (const s of states) out.push(task('orders', s, 'orderDate', win));
  return out;
}
const cancelTasks = (nowMs, days) => {
  const out = [];
  const from = istDayStart(nowMs - days * DAY);
  const to = istDayStart(nowMs) + DAY;
  for (const win of windows(from, to, 14)) for (const t of CANCEL_TYPES) out.push(task('cancelled', t, 'cancellationDate', win));
  return out;
};
const returnTasks = (nowMs, days, field) => {
  const out = [];
  const from = istDayStart(nowMs - days * DAY);
  const to = istDayStart(nowMs) + DAY;
  for (const win of windows(from, to, 7)) for (const s of RETURN_SOURCES) out.push(task('returns', s, field, win));
  return out;
};

/** Everything Flipkart still has (about 3 months). Used the first time, and as a weekly safety re-read. */
function planHistory(nowMs, historyDays = 130) {
  return [
    task('orders', 'preDispatch', null, null),
    ...ordersTasks(nowMs, historyDays),
    ...cancelTasks(nowMs, historyDays),
    ...returnTasks(nowMs, historyDays, 'created'),
    task('resolve', 'returns', null, null)
  ];
}

/** Every 30 minutes: only what can have changed in the last hours. */
function planLight(nowMs) {
  return [
    task('orders', 'preDispatch', null, null),
    ...ordersTasks(nowMs, 4, ['SHIPPED']),
    ...cancelTasks(nowMs, 3),
    ...returnTasks(nowMs, 2, 'created'),
    ...returnTasks(nowMs, 2, 'modified'),
    task('resolve', 'returns', null, null)
  ];
}

/** A few times a day, and for the "Update now" button: the last three weeks, including deliveries. */
function planUpdate(nowMs) {
  return [
    task('orders', 'preDispatch', null, null),
    ...ordersTasks(nowMs, 21),
    ...cancelTasks(nowMs, 21),
    ...returnTasks(nowMs, 21, 'created'),
    ...returnTasks(nowMs, 7, 'modified'),
    task('resolve', 'returns', null, null)
  ];
}

/** Which kind of run the 30-minute timer should start right now (Indian time). */
function modeForTimer(date) {
  const ist = new Date(date.getTime() + IST_MS);
  const hour = ist.getUTCHours();
  const minute = ist.getUTCMinutes();
  const weekday = ist.getUTCDay();             // 0 = Sunday
  if (minute < 30) {
    if (weekday === 0 && hour === 3) return 'history';
    if (hour % 6 === 3) return 'update';       // 03:00, 09:00, 15:00, 21:00
  }
  return 'light';
}

function planFor(mode, nowMs) {
  if (mode === 'history') return planHistory(nowMs);
  if (mode === 'update') return planUpdate(nowMs);
  return planLight(nowMs);
}

/** The search body Flipkart wants for an orders / cancelled task. */
function shipmentFilter(task) {
  const win = task.window_from && task.window_to
    ? { from: istNaive(Date.parse(task.window_from)), to: istNaive(Date.parse(task.window_to)) }
    : null;
  if (task.kind === 'cancelled') {
    return { type: 'cancelled', states: ['CANCELLED'], cancellationType: task.source, cancellationDate: win };
  }
  if (task.source === 'preDispatch') {
    return { type: 'preDispatch', states: ['APPROVED', 'PACKING_IN_PROGRESS', 'PACKED', 'FORM_FAILED', 'READY_TO_DISPATCH'] };
  }
  return { type: 'postDispatch', states: [task.source], orderDate: win };
}

module.exports = {
  DAY, POST_STATES, CANCEL_TYPES, RETURN_SOURCES, istNaive, istDayStart, windows,
  planHistory, planLight, planUpdate, planFor, modeForTimer, shipmentFilter
};
