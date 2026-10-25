'use strict';

const { isAuthorised } = require('./lib/auth');
const { missingEnv } = require('./lib/config');
const { createSupabaseStore } = require('./lib/store');
const { handleAction, InputError } = require('./lib/api-core');
const { triggerBackground } = require('./lib/trigger');

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.handler = async (event) => {
  const env = process.env;
  if (event.httpMethod !== 'POST') return json(405, { error: 'Use POST' });
  const missing = missingEnv(env);
  if (missing.length) return json(500, { error: 'Setup is not finished. Missing in Netlify: ' + missing.join(', ') });
  if (!isAuthorised(event.headers, env)) {
    await sleep(600);                              // slows down password guessing
    return json(401, { error: 'Wrong password' });
  }
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Unreadable request' }); }
  try {
    const store = createSupabaseStore(env);
    const host = (event.headers && (event.headers['x-forwarded-host'] || event.headers.host)) || '';
    const baseUrl = host ? `https://${host}` : env.URL;
    const trigger = () => triggerBackground({ baseUrl, password: env.APP_PASSWORD });
    return json(200, await handleAction(body, { store, trigger }));
  } catch (err) {
    if (err instanceof InputError) return json(400, { error: err.message });
    console.error('[api]', err.message);
    return json(500, { error: err.message });
  }
};
