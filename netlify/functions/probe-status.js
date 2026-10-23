'use strict';

/**
 * Plain-text status page for the probe. Open it BEFORE starting the probe (to check the setup) and
 * again afterwards (to see whether it has finished).
 *   /.netlify/functions/probe-status?key=YOUR_PROBE_KEY
 */

const { createClient } = require('@supabase/supabase-js');

const text = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  body
});

exports.handler = async (event) => {
  const env = process.env;
  if (!env.PROBE_KEY) {
    return text(500, 'PROBE_KEY is not set in Netlify yet.\nAdd an environment variable named PROBE_KEY (any made-up word), then publish a new deploy.');
  }
  if ((event.queryStringParameters || {}).key !== env.PROBE_KEY) {
    return text(403, 'The key in the address does not match PROBE_KEY.\nUse: ...probe-status?key=THE_WORD_YOU_CHOSE');
  }

  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'FLIPKART_CONSUMER_ID', 'FLIPKART_CONSUMER_SECRET'].filter((n) => !env[n]);
  if (missing.length) return text(500, 'Missing Netlify environment variables: ' + missing.join(', '));

  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data, error } = await client
    .from('raw_api_log')
    .select('id, created_at, run_id, call_name, response_status')
    .order('id', { ascending: false })
    .limit(300);
  if (error) {
    return text(500, 'Could not read the table raw_api_log: ' + error.message + '\nHave you run the SQL that creates it?');
  }

  const lines = ['Setup check: OK (key matches, all Netlify variables present, table raw_api_log found)', ''];
  if (!data.length) {
    lines.push('No probe has been run yet. Next: open  .../probe-background?key=YOUR_KEY');
    return text(200, lines.join('\n'));
  }
  const runId = data[0].run_id;
  const mine = data.filter((r) => r.run_id === runId);
  const done = mine.find((r) => r.call_name === 'DONE');
  lines.push(`Latest run started: ${runId}`);
  lines.push(`Tests saved so far: ${mine.filter((r) => r.call_name !== 'START' && r.call_name !== 'DONE').length}`);
  lines.push(done ? 'FINISHED. You can now export the table raw_api_log as CSV and send it to me.' : 'Still running (or stopped early). Refresh this page in a minute.');
  lines.push('');
  for (const r of [...mine].reverse()) lines.push(`  ${String(r.call_name).padEnd(52)} HTTP ${r.response_status}`);
  return text(200, lines.join('\n'));
};
