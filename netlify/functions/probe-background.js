'use strict';

/**
 * READ-ONLY probe of Flipkart's order and returns APIs.
 *
 * It only ever asks Flipkart for information (it never changes anything on your seller account) and saves
 * the answers into the Supabase table raw_api_log so we can see the REAL data formats. Customer names,
 * addresses, phone numbers, e-mails, cities and pincodes are replaced by "[removed]" before saving.
 *
 * Start it:   /.netlify/functions/probe-background?key=YOUR_PROBE_KEY
 * Check it:   /.netlify/functions/probe-status?key=YOUR_PROBE_KEY
 *
 * This is a "background function": Netlify answers instantly and lets it keep working for a few minutes.
 */

const { createClient } = require('@supabase/supabase-js');

const API = 'https://api.flipkart.net';
const DAY = 86400000;
const POST_STATES = ['SHIPPED', 'DELIVERED', 'PICKUP_COMPLETE'];
const CANCEL_TYPES = ['marketplaceCancellation', 'sellerCancellation', 'buyerCancellation'];
const MAX_BODY_CHARS = 400000;

// Personal details: never saved.
const REDACT = new Set([
  'firstname', 'lastname', 'buyername', 'customername', 'sellername',
  'addressline1', 'addressline2', 'landmark', 'contactnumber', 'phone', 'mobile', 'email', 'pincode', 'city'
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const toIst = (date) => new Date(date.getTime() + 330 * 60 * 1000).toISOString().slice(0, 19);
const enc = encodeURIComponent;

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = REDACT.has(k.toLowerCase()) ? '[removed]' : redact(v);
    return out;
  }
  return value;
}

/** Finds every value stored under `key`, anywhere inside a parsed JSON value. */
function findAll(value, key, found = []) {
  if (Array.isArray(value)) value.forEach((v) => findAll(v, key, found));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === key) found.push(v);
      findAll(v, key, found);
    }
  }
  return found;
}

function safeJson(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

/** One short line per test, for the DONE row. */
function describe(text) {
  const data = safeJson(text);
  if (!data) return { json: false, chars: String(text || '').length };
  const info = { json: true, chars: String(text).length, topLevelKeys: Object.keys(data).slice(0, 12) };
  for (const [k, v] of Object.entries(data)) if (Array.isArray(v)) info[`count_${k}`] = v.length;
  if ('hasMore' in data) info.hasMore = data.hasMore;
  const statuses = {};
  findAll(data, 'status').forEach((s) => { if (typeof s === 'string') statuses[s] = (statuses[s] || 0) + 1; });
  if (Object.keys(statuses).length) info.statuses = statuses;
  const dates = findAll(data, 'orderDate').filter((d) => typeof d === 'string').sort();
  if (dates.length) { info.oldestOrderDate = dates[0]; info.newestOrderDate = dates[dates.length - 1]; }
  return info;
}

function absolute(next) {
  if (/^https?:\/\//i.test(next)) {
    if (new URL(next).hostname !== 'api.flipkart.net') throw new Error('unexpected host in next page link');
    return next;
  }
  const path = next.startsWith('/') ? next : '/' + next;
  return API + (path.startsWith('/sellers/') ? '' : '/sellers') + path;
}

async function run(env, fetchImpl = fetch) {
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const runId = new Date().toISOString();
  const summary = {};
  let token = null;

  async function save(name, request, status, text) {
    const parsed = safeJson(text);
    let body = parsed ? JSON.stringify(redact(parsed)) : String(text || '');
    if (body.length > MAX_BODY_CHARS) body = body.slice(0, MAX_BODY_CHARS) + ' ...[cut]';
    const { error } = await client.from('raw_api_log').insert({
      run_id: runId, call_name: name, request_info: request, response_status: status, response_body: body
    });
    if (error) console.error('could not save', name, error.message);
  }

  async function http(method, url, body) {
    let last = 'no attempt made';
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetchImpl(url, {
          method,
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body)
        });
        const text = await res.text();
        if (res.status >= 500 && attempt < 3) { await sleep(1500 * attempt); continue; }
        return { status: res.status, text, attempts: attempt };
      } catch (e) {
        last = e.message;
        await sleep(1500 * attempt);
      }
    }
    return { status: 0, text: 'network error: ' + last, attempts: 3 };
  }

  /** Runs one test, saves the raw answer, never throws. */
  async function test(name, method, url, body) {
    try {
      const r = await http(method, url, body);
      await save(name, `${method} ${url}${body ? ' ' + JSON.stringify(body) : ''}${r.attempts > 1 ? ` (took ${r.attempts} attempts)` : ''}`, r.status, r.text);
      summary[name] = { http: r.status, ...describe(r.text) };
      return r;
    } catch (e) {
      await save(name, `${method} ${url}`, -1, 'probe error: ' + e.message);
      summary[name] = { error: e.message };
      return { status: -1, text: '' };
    }
  }

  const shipmentSearch = (name, filter, pageSize = 20) =>
    test(name, 'POST', `${API}/sellers/v3/shipments/filter/`, { filter, pagination: { pageSize } });
  const window = (fromDaysAgo, toDaysAgo) => ({
    from: toIst(new Date(Date.now() - fromDaysAgo * DAY)),
    to: toIst(new Date(Date.now() - toDaysAgo * DAY))
  });

  await save('START', 'probe started', 0, 'probe started');

  // ---- token (the token itself is never saved) ----
  const basic = Buffer.from(`${env.FLIPKART_CONSUMER_ID}:${env.FLIPKART_CONSUMER_SECRET}`).toString('base64');
  const tokenRes = await fetchImpl(`${API}/oauth-service/oauth/token?grant_type=client_credentials&scope=Seller_Api`, {
    method: 'GET', headers: { Authorization: 'Basic ' + basic }
  });
  const tokenData = safeJson(await tokenRes.text());
  await save('T0_token', 'GET oauth token (token not saved)', tokenRes.status, tokenData && tokenData.access_token ? 'token received' : 'NO TOKEN');
  if (!tokenData || !tokenData.access_token) {
    await save('DONE', 'probe finished early', 0, JSON.stringify({ problem: 'Flipkart gave no access token. Check the Flipkart keys in Netlify.' }));
    return { ok: false, summary };
  }
  token = tokenData.access_token;

  // ---- A. delivered / shipped orders, and how paging to page 2 really works ----
  const postFilter = { type: 'postDispatch', states: POST_STATES, orderDate: window(3, 0) };
  const first = await shipmentSearch('A1_postDispatch_last3days', postFilter);
  const firstData = safeJson(first.text);
  if (firstData && firstData.hasMore && firstData.nextPageUrl) {
    const next = absolute(firstData.nextPageUrl);
    await test('A2_page2_via_GET', 'GET', next);
    await test('A3_page2_via_POST_empty_body', 'POST', next, {});
    await test('A4_page2_via_POST_original_body', 'POST', next, { filter: postFilter, pagination: { pageSize: 20 } });
  }

  // ---- B. cancelled orders: both spellings of the state, all three cancellation types ----
  for (const type of CANCEL_TYPES) {
    for (const state of ['CANCELLED', 'Cancelled']) {
      await shipmentSearch(`B_cancelled_${type}_${state}`, {
        type: 'cancelled', states: [state], cancellationType: type, cancellationDate: window(14, 0)
      });
    }
  }

  // ---- C. how far back does the API reach? (one order per window) ----
  for (const d of [30, 60, 90, 180, 270, 365, 540, 730]) {
    await shipmentSearch(`C_depth_${d}days_ago`, { type: 'postDispatch', states: POST_STATES, orderDate: window(d + 1, d) }, 1);
  }
  await shipmentSearch('C_wide_window_400days', { type: 'postDispatch', states: POST_STATES, orderDate: window(400, 0) }, 1);

  // ---- D. returns ----
  const returnsUrl = (source, field, daysAgo, style) => {
    const when = style === 'ist' ? toIst(new Date(Date.now() - daysAgo * DAY)) : new Date(Date.now() - daysAgo * DAY).toISOString();
    return `${API}/sellers/v2/returns?source=${source}&${field}=${enc(when)}`;
  };
  const d1 = await test('D1_returns_customer_created90d_utc', 'GET', returnsUrl('customer_return', 'createdAfter', 90, 'utc'));
  await test('D2_returns_customer_created90d_ist', 'GET', returnsUrl('customer_return', 'createdAfter', 90, 'ist'));
  await test('D3_returns_courier_created90d_utc', 'GET', returnsUrl('courier_return', 'createdAfter', 90, 'utc'));
  await test('D4_returns_customer_modified30d_utc', 'GET', returnsUrl('customer_return', 'modifiedAfter', 30, 'utc'));
  await test('D5_returns_customer_created365d_utc', 'GET', returnsUrl('customer_return', 'createdAfter', 365, 'utc'));
  await test('D6_returns_courier_created365d_utc', 'GET', returnsUrl('courier_return', 'createdAfter', 365, 'utc'));
  const d1Data = safeJson(d1.text);
  const nextUrl = d1Data && findAll(d1Data, 'nextUrl').find((v) => typeof v === 'string' && v);
  if (nextUrl) await test('D7_returns_page2_via_GET', 'GET', absolute(nextUrl));

  // ---- E. what status does Flipkart give a returned item? (3 items, personal details removed on saving) ----
  const ids = d1Data ? [...new Set(findAll(d1Data, 'orderItemId').map(String))].slice(0, 3) : [];
  if (ids.length) await test('E1_shipment_details_of_returned_items', 'GET', `${API}/sellers/v3/shipments?orderItemIds=${ids.join(',')}`);

  await save('DONE', 'probe finished', 0, JSON.stringify(summary, null, 1));
  return { ok: true, summary };
}

exports.run = run;

// Netlify has already answered "202 accepted" by the time this code runs (background function), so a wrong
// key cannot show a message here. That is why probe-status checks the key and setup first.
exports.handler = async (event) => {
  const env = process.env;
  const key = (event.queryStringParameters || {}).key;
  if (!env.PROBE_KEY || key !== env.PROBE_KEY) return;
  for (const name of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'FLIPKART_CONSUMER_ID', 'FLIPKART_CONSUMER_SECRET']) {
    if (!env[name]) return;
  }
  try {
    await run(env);
  } catch (err) {
    console.error('probe failed:', err.message);
  }
};
