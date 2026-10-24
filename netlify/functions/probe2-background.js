'use strict';

/**
 * READ-ONLY probe, round 2. It only ASKS Flipkart for information; it never changes anything on your seller account.
 *
 * Goals:
 *   1. Find a way to list shipped / delivered orders (round 1 got an empty list).
 *   2. Find the page-2 address for the returns list.
 *   3. Find how far back each list reaches.
 *
 * Start it:   /.netlify/functions/probe2-background?key=YOUR_PROBE_KEY
 * Check it:   /.netlify/functions/probe-status?key=YOUR_PROBE_KEY      (same status page as round 1)
 *
 * Answers are saved into the table raw_api_log (names, addresses, phones, e-mails, cities, pincodes removed).
 */

const { API, REQUIRED_ENV, enc, findAll, safeJson, nextAddress, createKit } = require('./lib/probe-kit');

const POST_STATES = ['SHIPPED', 'DELIVERED', 'PICKUP_COMPLETE'];
const ALL_STATES = [
  'APPROVED', 'PACKING_IN_PROGRESS', 'PACKED', 'FORM_FAILED', 'READY_TO_DISPATCH',
  'SHIPPED', 'DELIVERED', 'PICKUP_COMPLETE', 'COMPLETED', 'RETURN_REQUESTED', 'RETURNED', 'CANCELLED'
];

const count = (r) => (r && r.data && Array.isArray(r.data.shipments) ? r.data.shipments.length : 0);

async function run(env, fetchImpl = fetch) {
  const kit = createKit(env, fetchImpl);
  const { summary } = kit;
  await kit.save('START', 'probe 2 started', 0, 'probe 2 started');

  if (!(await kit.login())) {
    await kit.save('DONE', 'probe 2 finished early', 0, JSON.stringify({ problem: 'Flipkart gave no access token. Check the Flipkart keys in Netlify.' }));
    return { ok: false, summary };
  }

  // ---------- P. Which request finds shipped / delivered orders? ----------
  const winners = [];
  const tryPost = async (name, filter, pageSize = 20, extra = {}) => {
    const r = await kit.shipmentSearch(name, filter, pageSize, extra);
    if (count(r) > 0) winners.push({ name, filter, extra });
    return r;
  };

  // P00: control. Orders waiting to be packed are known to work; also gives us the shop location id.
  const control = await kit.shipmentSearch('P00_control_preDispatch', {
    type: 'preDispatch', states: ['APPROVED', 'PACKING_IN_PROGRESS', 'PACKED', 'FORM_FAILED', 'READY_TO_DISPATCH']
  }, 1);
  const locationId = control.data ? findAll(control.data, 'locationId').find((v) => typeof v === 'string') : undefined;

  const post = (extra = {}) => ({ type: 'postDispatch', ...extra });
  await tryPost('P01_state_DELIVERED_nodates', post({ states: ['DELIVERED'] }));
  await tryPost('P02_state_SHIPPED_nodates', post({ states: ['SHIPPED'] }));
  await tryPost('P03_state_PICKUP_COMPLETE_nodates', post({ states: ['PICKUP_COMPLETE'] }));
  await tryPost('P04_state_COMPLETED_nodates', post({ states: ['COMPLETED'] }));
  await tryPost('P05_state_RETURN_REQUESTED_nodates', post({ states: ['RETURN_REQUESTED'] }));
  await tryPost('P06_state_RETURNED_nodates', post({ states: ['RETURNED'] }));
  await tryPost('P07_three_states_nodates', post({ states: POST_STATES }));
  await tryPost('P08_three_states_modifiedDate_3d', post({ states: POST_STATES, modifiedDate: kit.window(3, 0) }));
  await tryPost('P09_three_states_orderDate_plus0530', post({ states: POST_STATES, orderDate: kit.window(10, 0, true) }));
  const dayOnly = (d) => new Date(Date.now() + 330 * 60000 - d * 86400000).toISOString().slice(0, 10);
  await tryPost('P09b_three_states_orderDate_dateonly', post({ states: POST_STATES, orderDate: { from: dayOnly(10), to: dayOnly(-1) } }));
  await tryPost('P09c_three_states_orderDate_utc_Z', post({ states: POST_STATES, orderDate: { from: kit.utc(10), to: kit.utc(0) } }));
  // guesses at other date filter names; a wrong name should produce an error message that lists the right ones
  for (const field of ['dispatchedDate', 'deliveredDate', 'shippedDate', 'deliveryDate']) {
    await tryPost(`P09d_three_states_${field}_10d`, post({ states: POST_STATES, [field]: kit.window(10, 0) }));
  }
  await tryPost('P10_three_states_dispatchByDate_10d', post({ states: POST_STATES, dispatchByDate: kit.window(10, -2) }));
  await tryPost('P11_three_states_dispatchAfterDate_10d', post({ states: POST_STATES, dispatchAfterDate: kit.window(10, 0) }));
  await tryPost('P12_NORMAL_NON_FBF', post({ states: POST_STATES, shipmentTypes: ['NORMAL'], serviceProfiles: ['NON_FBF'] }));
  await tryPost('P12b_NORMAL_Seller_Fulfilment', post({ states: POST_STATES, shipmentTypes: ['NORMAL'], serviceProfiles: ['Seller_Fulfilment'] }));
  await tryPost('P13_all_12_states_nodates', post({ states: ALL_STATES }));
  await tryPost('P14_no_states_field', post({}));
  await tryPost('P14b_no_states_orderDate_30d', post({ orderDate: kit.window(30, 0) }));
  if (locationId) await tryPost('P15_with_locationId', post({ states: POST_STATES, locationId }));
  await tryPost('P16_sorted_newest_first', post({ states: POST_STATES }), 20, { sort: { field: 'orderDate', order: 'desc' } });
  await tryPost('P17_type_preDispatch_with_post_states', { type: 'preDispatch', states: POST_STATES });

  // P18: the older order search address (read-only search)
  const old = await kit.test('P18_old_orders_search', 'POST', `${API}/sellers/v2/orders/search`, {
    filter: { type: 'postDispatch', states: ['DELIVERED'] }, pagination: { pageSize: 20 }
  });
  const oldCount = old.data ? findAll(old.data, 'orderItems').length : 0;
  if (oldCount > 0) winners.push({ name: 'P18_old_orders_search', filter: null, extra: {} });

  // P19: for returned items, the shipment lookup shows their status. Look at a handful of other statuses by id lookup later (E-tests).

  // If anything worked: how many pages does it give, and how far back does it go?
  if (winners.length) {
    const win = winners[0];
    summary.WINNER = { test: win.name, filter: win.filter };
    if (win.filter) {
      const base = { ...win.filter };
      delete base.orderDate;
      const page1 = await kit.shipmentSearch('W1_winner_page1', base, 20, win.extra);
      if (page1.data && page1.data.hasMore && page1.data.nextPageUrl) {
        await kit.test('W2_winner_page2_GET', 'GET', nextAddress(page1.data.nextPageUrl, '/sellers'));
      }
      for (const d of [30, 90, 180, 365, 540]) {
        await kit.shipmentSearch(`W3_winner_depth_${d}d`, { ...base, orderDate: kit.window(d + 1, d) }, 1, win.extra);
      }
    }
  }

  // ---------- Q. How far back do cancelled orders go? ----------
  for (const type of ['buyerCancellation', 'marketplaceCancellation']) {
    for (const d of [30, 60, 90, 180, 365, 540]) {
      await kit.shipmentSearch(`Q_cancelled_${type}_${d}d`, {
        type: 'cancelled', states: ['CANCELLED'], cancellationType: type, cancellationDate: kit.window(d + 1, d)
      }, 1);
    }
  }

  // ---------- M. Does the "changed since" filter work? (would make the 30-minute sync light) ----------
  await kit.shipmentSearch('M1_cancelled_modifiedDate_2d', { type: 'cancelled', states: ['CANCELLED'], cancellationType: 'buyerCancellation', modifiedDate: kit.window(2, 0) }, 5);
  await kit.shipmentSearch('M2_preDispatch_modifiedDate_2d', {
    type: 'preDispatch', states: ['APPROVED', 'PACKING_IN_PROGRESS', 'PACKED', 'FORM_FAILED', 'READY_TO_DISPATCH'], modifiedDate: kit.window(2, 0)
  }, 5);

  // ---------- R. Returns: window filters, depth and paging ----------
  const retUrl = (source, field, from, to) =>
    `${API}/sellers/v2/returns?source=${source}&${field}After=${enc(kit.utc(from))}&${field}Before=${enc(kit.utc(to))}`;
  const r1 = await kit.test('R1_customer_created_window_3d_to_2d', 'GET', retUrl('customer_return', 'created', 3, 2));
  await kit.test('R2_customer_modified_window_3d_to_2d', 'GET', retUrl('customer_return', 'modified', 3, 2));
  for (const d of [30, 90, 180, 365, 540]) {
    await kit.test(`R3_customer_created_depth_${d}d`, 'GET', retUrl('customer_return', 'created', d + 1, d));
  }
  for (const d of [30, 90, 180, 365]) {
    await kit.test(`R4_courier_created_depth_${d}d`, 'GET', retUrl('courier_return', 'created', d + 1, d));
  }

  // Paging: page 1 gave a "nextUrl" like /returns/search/<token>. Try every sensible way to open it.
  const bigPage = await kit.test('RP0_returns_page1_for_paging', 'GET',
    `${API}/sellers/v2/returns?source=customer_return&createdAfter=${enc(kit.utc(60))}`);
  const nextUrl = bigPage.data && findAll(bigPage.data, 'nextUrl').find((v) => typeof v === 'string' && v);
  if (nextUrl) {
    const path = nextUrl.startsWith('/') ? nextUrl : '/' + nextUrl;
    await kit.test('RP1_GET_sellers_v2_plus_next', 'GET', API + '/sellers/v2' + path);
    await kit.test('RP2_GET_next_only', 'GET', API + path);
    await kit.test('RP3_POST_empty_sellers_plus_next', 'POST', API + '/sellers' + path, {});
    await kit.test('RP4_GET_sellers_plus_next_retry', 'GET', API + '/sellers' + path);
    await kit.test('RP5_GET_sellers_v2_returns_next_token_style', 'GET',
      `${API}/sellers/v2/returns?next_token=${enc(path.replace('/returns/search/', ''))}`);
  }

  // ---------- E. Old order lookup by item id, using ids from a returns answer ----------
  const ids = r1.data ? [...new Set(findAll(r1.data, 'orderItemId').map(String))].slice(0, 3) : [];
  const ids2 = bigPage.data ? [...new Set(findAll(bigPage.data, 'orderItemId').map(String))].slice(0, 3) : [];
  const useIds = ids.length ? ids : ids2;
  if (useIds.length) await kit.test('E2_old_orders_lookup', 'GET', `${API}/sellers/v2/orders/?orderItemIds=${useIds.join(',')}`);

  await kit.save('DONE', 'probe 2 finished', 0, JSON.stringify(summary, null, 1));
  return { ok: true, summary };
}

exports.run = run;

// Netlify has already answered "202 accepted" before this runs (background function), so a wrong key cannot
// show a message here. probe-status checks the key and setup first.
exports.handler = async (event) => {
  const env = process.env;
  const key = (event.queryStringParameters || {}).key;
  if (!env.PROBE_KEY || key !== env.PROBE_KEY) return;
  for (const name of REQUIRED_ENV) if (!env[name]) return;
  try {
    await run(env);
  } catch (err) {
    console.error('probe 2 failed:', err.message);
  }
};
