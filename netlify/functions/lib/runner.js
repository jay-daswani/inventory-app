'use strict';

/**
 * Works through the saved download tasks, page by page, for as long as the time budget allows.
 * It can be stopped at any moment: progress is saved after every page and the next run continues from there.
 */

const { shipmentFilter } = require('./plan');
const { mapShipments, mapReturns } = require('./mapping');

const PLATFORM = 'flipkart';

async function savePageOfShipments(store, known, shipments, cancelType) {
  const { lines, listings } = mapShipments(shipments, { cancelType });
  const fresh = listings.filter((l) => !known.has(`${l.platform}|${l.listing_id}`));
  if (fresh.length) {
    await store.rpc('register_listings', { p_rows: fresh });
    fresh.forEach((l) => known.add(`${l.platform}|${l.listing_id}`));
  }
  if (lines.length) await store.rpc('upsert_order_lines', { p_rows: lines });
  return lines.length;
}

/** Follows one task. Returns 'done', or 'paused' when the time budget ran out (progress is saved). */
async function processTask(task, ctx) {
  const { store, fk, known, outOfTime, log } = ctx;
  let pages = task.pages_done || 0;
  let rows = task.rows_done || 0;

  if (task.kind === 'resolve') return resolveReturns(task, ctx);

  const isReturns = task.kind === 'returns';
  const first = () => {
    if (isReturns) {
      const field = task.field === 'modified' ? 'modified' : 'created';
      return fk.returnsPage({ source: task.source, field, after: new Date(task.window_from), before: new Date(task.window_to) });
    }
    return fk.searchShipments(shipmentFilter(task), 20);
  };
  const next = (url) => (isReturns ? fk.nextReturns(url) : fk.nextShipments(url));

  let page;
  if (task.next_url) {
    try { page = await next(task.next_url); }
    catch (err) {
      log(`task ${task.id}: saved next-page link no longer works (${err.message}); starting this task again`);
      page = await first();
      pages = 0; rows = 0;
    }
  } else {
    page = await first();
  }

  for (;;) {
    const n = isReturns
      ? await saveReturns(store, page, task)
      : await savePageOfShipments(store, known, page.shipments, task.kind === 'cancelled' ? task.source : undefined);
    pages += 1; rows += n;
    if (ctx.stats) ctx.stats.pages += 1;
    const nextUrl = isReturns ? page.nextUrl : page.nextPageUrl;
    const more = Boolean(page.hasMore && nextUrl);
    await store.updateTask(task.id, { pages_done: pages, rows_done: rows, next_url: more ? nextUrl : null });
    if (!more) return 'done';
    if (outOfTime()) return 'paused';
    page = await next(nextUrl);
  }
}

async function saveReturns(store, page, task) {
  const rows = mapReturns(page.returnItems, task.source);
  if (rows.length) await store.rpc('upsert_return_lines', { p_rows: rows });
  return rows.length;
}

/** Matches returns to products. Returns whose order we do not have yet are looked up by order item id. */
async function resolveReturns(task, ctx) {
  const { store, fk, known } = ctx;
  let linked = await store.rpc('link_return_listings');
  const missing = await store.orphanReturnItemIds(300);
  let added = 0;
  for (let i = 0; i < missing.length; i += 100) {
    const ids = missing.slice(i, i + 100);
    const data = await fk.shipmentsByItemIds(ids);
    added += await savePageOfShipments(store, known, data.shipments || [], undefined);
  }
  if (missing.length) {
    await store.rpc('mark_lookup_tried', { p_ids: missing });   // never ask again for ids Flipkart could not tell us about
    linked += await store.rpc('link_return_listings');
  }
  await store.updateTask(task.id, { rows_done: (linked || 0) + added, pages_done: 1, next_url: null });
  return 'done';
}

/**
 * @returns {{processed:number, failed:number, remaining:number, ran:boolean}}
 */
async function runTasks({ store, fk, budgetMs = 12 * 60 * 1000, now = Date.now, holder = 'runner-' + Math.random().toString(36).slice(2), log = () => {} }) {
  const started = now();
  const got = await store.rpc('acquire_lease', { p_holder: holder, p_seconds: Math.ceil(budgetMs / 1000) + 180 });
  if (!got) {
    log('another download is already running');
    return { ran: false, processed: 0, failed: 0, remaining: -1 };
  }
  let processed = 0, failed = 0;
  const stats = { pages: 0 };
  try {
    await store.resetRunningTasks();
    const known = await store.knownListings();
    const outOfTime = () => now() - started > budgetMs;
    for (;;) {
      if (outOfTime()) break;
      const task = await store.nextPendingTask();
      if (!task) break;
      await store.updateTask(task.id, { status: 'running', attempts: (task.attempts || 0) + 1 });
      try {
        const result = await processTask(task, { store, fk, known, outOfTime, log, stats });
        if (result === 'done') {
          await store.updateTask(task.id, { status: 'done', finished_at: new Date(now()).toISOString(), last_error: null });
          processed += 1;
        } else {
          await store.updateTask(task.id, { status: 'pending' });   // paused: continues from the saved page
        }
      } catch (err) {
        failed += 1;
        const giveUp = (task.attempts || 0) + 1 >= 3;
        log(`task ${task.id} (${task.kind} ${task.source}) problem: ${err.message}`);
        await store.updateTask(task.id, { status: giveUp ? 'failed' : 'pending', last_error: String(err.message).slice(0, 500) });
      }
    }
    await store.closeFinishedBatches();
    const open = await store.countOpenTasks();
    return { ran: true, processed, failed, pages: stats.pages, remaining: open.pending + open.running };
  } finally {
    await store.rpc('release_lease', { p_holder: holder }).catch(() => {});
  }
}

module.exports = { runTasks, processTask };
