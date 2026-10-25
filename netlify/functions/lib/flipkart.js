'use strict';

/**
 * Flipkart Seller API client. READ-ONLY: it only searches and fetches; it never changes anything on the account.
 * What we learned from the live tests:
 *   - shipments search needs ONE state per request for postDispatch (several at once return nothing)
 *   - "next page" links are followed with GET:   https://api.flipkart.net/sellers  + nextPageUrl
 *   - returns:  GET /sellers/v2/returns?source=customer_return|courier_return&createdAfter=...  (date-level filtering)
 *     and the next page of returns is  https://api.flipkart.net/sellers/v2  + nextUrl
 */

const API = 'https://api.flipkart.net';
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FlipkartError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'FlipkartError';
    this.status = status;
    this.body = body;
  }
}

function errorText(status, text) {
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data.errors) && data.errors[0]) {
      const e = data.errors[0];
      return typeof e === 'string' ? e : `${e.code || ''} ${e.message || ''}`.trim();
    }
    if (data.message) return String(data.message);
  } catch (e) { /* not JSON */ }
  return String(text || '').slice(0, 200) || `HTTP ${status}`;
}

function joinPath(prefix, next) {
  if (/^https?:\/\//i.test(next)) {
    if (new URL(next).hostname !== 'api.flipkart.net') throw new FlipkartError('Unexpected host in next-page link', 0);
    return next;
  }
  return API + prefix + (next.startsWith('/') ? next : '/' + next);
}

function createFlipkart({ consumerId, consumerSecret, fetchImpl = fetch, sleep = defaultSleep }) {
  let token = null;

  async function login() {
    const basic = Buffer.from(`${consumerId}:${consumerSecret}`).toString('base64');
    const res = await fetchImpl(`${API}/oauth-service/oauth/token?grant_type=client_credentials&scope=Seller_Api`, {
      method: 'GET', headers: { Authorization: 'Basic ' + basic }
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { /* ignore */ }
    if (!res.ok || !data || !data.access_token) {
      throw new FlipkartError('Flipkart did not give an access token (' + errorText(res.status, text) + '). Check the Flipkart keys in Netlify.', res.status);
    }
    token = data.access_token;
    return token;
  }

  async function request(method, url, body) {
    if (!token) await login();
    let refreshed = false;
    let lastError;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const res = await fetchImpl(url, {
          method,
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body)
        });
        const text = await res.text();
        if (res.status === 401 && !refreshed) { refreshed = true; await login(); continue; }
        if (res.status === 429 || res.status >= 500) {
          lastError = new FlipkartError(`Flipkart error ${res.status}: ${errorText(res.status, text)}`, res.status, text);
          await sleep(1500 * attempt);
          continue;
        }
        if (!res.ok) throw new FlipkartError(`Flipkart refused the request (${res.status}): ${errorText(res.status, text)}`, res.status, text);
        let data;
        try { data = JSON.parse(text); } catch (e) { throw new FlipkartError('Flipkart answered with something unreadable', res.status, text); }
        return data;
      } catch (err) {
        if (err instanceof FlipkartError && err.status && err.status < 500 && err.status !== 429) throw err;
        lastError = err;
        await sleep(1500 * attempt);
      }
    }
    throw lastError || new FlipkartError('Flipkart did not answer', 0);
  }

  return {
    searchShipments: (filter, pageSize = 20) =>
      request('POST', `${API}/sellers/v3/shipments/filter/`, { filter, pagination: { pageSize } }),
    nextShipments: async (nextPageUrl) => request('GET', joinPath('/sellers', nextPageUrl)),
    shipmentsByItemIds: (ids) => request('GET', `${API}/sellers/v3/shipments?orderItemIds=${ids.map(encodeURIComponent).join(',')}`),
    /** field: 'created' or 'modified'. after/before are Date objects (Flipkart only looks at the date part). */
    returnsPage: ({ source, field, after, before }) => {
      const q = [`source=${encodeURIComponent(source)}`];
      if (after) q.push(`${field}After=${encodeURIComponent(after.toISOString())}`);
      if (before) q.push(`${field}Before=${encodeURIComponent(before.toISOString())}`);
      return request('GET', `${API}/sellers/v2/returns?${q.join('&')}`);
    },
    nextReturns: async (nextUrl) => request('GET', joinPath('/sellers/v2', nextUrl))
  };
}

module.exports = { createFlipkart, FlipkartError, API };
