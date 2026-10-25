'use strict';

/**
 * The downloader. Netlify answers "202 accepted" immediately and lets this keep working for up to 15 minutes.
 * It works through the saved download tasks and, if time runs out, starts itself again to carry on.
 */

const { isAuthorised } = require('./lib/auth');
const { missingEnv } = require('./lib/config');
const { createSupabaseStore } = require('./lib/store');
const { createFlipkart } = require('./lib/flipkart');
const { runTasks } = require('./lib/runner');
const { triggerBackground, siteUrl } = require('./lib/trigger');

const BUDGET_MS = Number(process.env.SYNC_BUDGET_MS) || 12 * 60 * 1000;

exports.handler = async (event) => {
  const env = process.env;
  if (!isAuthorised(event.headers, env) || missingEnv(env).length) return;
  const log = (msg) => console.log('[sync]', msg);
  try {
    const store = createSupabaseStore(env);
    const fk = createFlipkart({ consumerId: env.FLIPKART_CONSUMER_ID, consumerSecret: env.FLIPKART_CONSUMER_SECRET });
    const result = await runTasks({ store, fk, budgetMs: BUDGET_MS, log });
    log(`finished a round: ${JSON.stringify(result)}`);
    // More to do and nothing else is running: carry on right away (otherwise the 30-minute timer picks it up).
    if (result.ran && result.remaining > 0 && result.pages > 0) {
      await triggerBackground({ baseUrl: siteUrl(env), password: env.APP_PASSWORD });
    }
  } catch (err) {
    console.error('[sync] stopped:', err.message);
  }
};
