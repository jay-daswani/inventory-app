'use strict';

/**
 * Runs every 30 minutes (see netlify.toml). It only decides what to download and starts the downloader.
 * Netlify allows scheduled functions just a few seconds, so the real work happens in sync-background.
 */

const { missingEnv } = require('./lib/config');
const { createSupabaseStore } = require('./lib/store');
const { planFor, modeForTimer } = require('./lib/plan');
const { triggerBackground, siteUrl } = require('./lib/trigger');

exports.handler = async () => {
  const env = process.env;
  const missing = missingEnv(env);
  if (missing.length) { console.log('[timer] not set up yet, missing:', missing.join(', ')); return { statusCode: 200 }; }
  try {
    const store = createSupabaseStore(env);
    const open = await store.countOpenTasks();
    if (open.pending + open.running === 0) {
      const now = new Date();
      const mode = modeForTimer(now);
      const id = await store.createBatch(mode, planFor(mode, now.getTime()), 'started by the 30-minute timer');
      console.log(`[timer] started ${mode} download (batch ${id})`);
    } else {
      console.log(`[timer] ${open.pending} download steps still waiting; continuing them`);
    }
    const t = await triggerBackground({ baseUrl: siteUrl(env), password: env.APP_PASSWORD });
    console.log('[timer] downloader started:', JSON.stringify(t));
  } catch (err) {
    console.error('[timer] problem:', err.message);
  }
  return { statusCode: 200 };
};
