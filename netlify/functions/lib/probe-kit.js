'use strict';

/**
 * Shared helpers for the read-only Flipkart probes.
 * Everything saved goes through redact(): names, addresses, phone numbers, e-mails, cities and pincodes
 * are replaced by "[removed]". The access token is never saved.
 */

const { createClient } = require('@supabase/supabase-js');

const API = 'https://api.flipkart.net';
const DAY = 86400000;
const MAX_BODY_CHARS = 400000;

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

/** One short summary per test, for the DONE row. */
function describe(text) {
  const data = safeJson(text);
  if (!data) return { json: false, chars: String(text || '').length, head: String(text || '').slice(0, 160) };
  const info = { json: true, chars: String(text).length, topLevelKeys: Object.keys(data).slice(0, 12) };
  for (const [k, v] of Object.entries(data)) if (Array.isArray(v)) info[`count_${k}`] = v.length;
  if ('hasMore' in data) info.hasMore = data.hasMore;
  if (Array.isArray(data.errors) && data.errors[0]) info.error = `${data.errors[0].code}: ${String(data.errors[0].message).slice(0, 120)}`;
  const statuses = {};
  findAll(data, 'status').forEach((s) => { if (typeof s === 'string') statuses[s] = (statuses[s] || 0) + 1; });
  if (Object.keys(statuses).length) info.statuses = statuses;
  for (const key of ['orderDate', 'createdDate', 'cancellationDate', 'updatedDate', 'updatedAt']) {
    const v = findAll(data, key).filter((d) => typeof d === 'string').sort();
    if (v.length) info[key] = `${v[0]} .. ${v[v.length - 1]}`;
  }
  return info;
}

/** Makes a path from Flipkart's "next page" link into a full address. `prefix` is what goes before the path. */
function nextAddress(next, prefix) {
  if (/^https?:\/\//i.test(next)) {
    if (new URL(next).hostname !== 'api.flipkart.net') throw new Error('unexpected host in next page link');
    return next;
  }
  return API + prefix + (next.startsWith('/') ? next : '/' + next);
}

function createKit(env, fetchImpl = fetch) {
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const runId = new Date().toISOString();
  const summary = {};
  const kit = { API, DAY, runId, summary, token: null };

  kit.window = (fromDaysAgo, toDaysAgo, withOffset = false) => {
    const f = (d) => toIst(new Date(Date.now() - d * DAY)) + (withOffset ? '.000+05:30' : '');
    return { from: f(fromDaysAgo), to: f(toDaysAgo) };
  };
  kit.utc = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();

  kit.save = async (name, request, status, text) => {
    const parsed = safeJson(text);
    let body = parsed ? JSON.stringify(redact(parsed)) : String(text || '');
    if (body.length > MAX_BODY_CHARS) body = body.slice(0, MAX_BODY_CHARS) + ' ...[cut]';
    const { error } = await client.from('raw_api_log').insert({
      run_id: runId, call_name: name, request_info: request, response_status: status, response_body: body
    });
    if (error) console.error('could not save', name, error.message);
  };

  kit.http = async (method, url, body) => {
    let last = 'no attempt made';
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetchImpl(url, {
          method,
          headers: { Authorization: 'Bearer ' + kit.token, 'Content-Type': 'application/json', Accept: 'application/json' },
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
  };

  /** Runs one test, saves the raw answer, never throws. */
  kit.test = async (name, method, url, body) => {
    try {
      const r = await kit.http(method, url, body);
      await kit.save(name, `${method} ${url}${body ? ' ' + JSON.stringify(body) : ''}${r.attempts > 1 ? ` (took ${r.attempts} attempts)` : ''}`, r.status, r.text);
      summary[name] = { http: r.status, ...describe(r.text) };
      return { ...r, data: safeJson(r.text) };
    } catch (e) {
      await kit.save(name, `${method} ${url}`, -1, 'probe error: ' + e.message);
      summary[name] = { error: e.message };
      return { status: -1, text: '', data: null };
    }
  };

  kit.shipmentSearch = (name, filter, pageSize = 20, extra = {}) =>
    kit.test(name, 'POST', `${API}/sellers/v3/shipments/filter/`, { filter, pagination: { pageSize }, ...extra });

  kit.login = async () => {
    const basic = Buffer.from(`${env.FLIPKART_CONSUMER_ID}:${env.FLIPKART_CONSUMER_SECRET}`).toString('base64');
    const res = await fetchImpl(`${API}/oauth-service/oauth/token?grant_type=client_credentials&scope=Seller_Api`, {
      method: 'GET', headers: { Authorization: 'Basic ' + basic }
    });
    const data = safeJson(await res.text());
    await kit.save('T0_token', 'GET oauth token (token not saved)', res.status, data && data.access_token ? 'token received' : 'NO TOKEN');
    if (data && data.access_token) kit.token = data.access_token;
    return Boolean(kit.token);
  };

  return kit;
}

const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'FLIPKART_CONSUMER_ID', 'FLIPKART_CONSUMER_SECRET'];

module.exports = { API, DAY, REQUIRED_ENV, enc, redact, findAll, safeJson, describe, nextAddress, createKit };
