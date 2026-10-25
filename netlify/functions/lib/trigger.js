'use strict';

/** Starts the background downloader (it answers instantly and keeps working for up to ~15 minutes). */
async function triggerBackground({ baseUrl, password, fetchImpl = fetch }) {
  if (!baseUrl) return { ok: false, reason: 'no site address known' };
  try {
    const res = await fetchImpl(`${String(baseUrl).replace(/\/$/, '')}/.netlify/functions/sync-background`, {
      method: 'POST',
      headers: { 'x-app-password': password, 'Content-Type': 'application/json' },
      body: '{}'
    });
    return { ok: res.status === 202 || res.ok, status: res.status };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

const siteUrl = (env) => env.URL || env.DEPLOY_PRIME_URL || env.DEPLOY_URL || '';

module.exports = { triggerBackground, siteUrl };
