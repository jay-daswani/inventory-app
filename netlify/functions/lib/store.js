'use strict';

/**
 * The database layer. Every database call the downloader needs is one small method here, so the same downloader
 * code can run against Supabase (live) or against a test database.
 */

const { createClient } = require('@supabase/supabase-js');

function fail(what, error) {
  throw new Error(`Database problem (${what}): ${error.message || error}`);
}

function createSupabaseStore(env, injectedClient) {
  // This app never uses Supabase's live-update feature. The library still wants a "WebSocket" to exist on
  // older Node versions, so hand it an empty stand-in there instead of letting the function crash at start-up.
  const noLive = typeof WebSocket === 'undefined' ? { transport: class NoLiveUpdates {} } : {};
  const client = injectedClient || createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false }, realtime: noLive });

  async function rpc(name, args) {
    const { data, error } = await client.rpc(name, args || {});
    if (error) fail(name, error);
    return data;
  }

  return {
    client,
    rpc,

    async knownListings() {
      const known = new Set();
      for (let from = 0; ; from += 1000) {
        const { data, error } = await client.from('listings').select('platform, listing_id').order('id').range(from, from + 999);
        if (error) fail('read listings', error);
        data.forEach((r) => known.add(`${r.platform}|${r.listing_id}`));
        if (data.length < 1000) break;
      }
      return known;
    },

    async nextPendingTask() {
      const { data, error } = await client.from('sync_tasks').select('*').eq('status', 'pending').order('id').limit(1);
      if (error) fail('read tasks', error);
      return data[0] || null;
    },

    async updateTask(id, patch) {
      const { error } = await client.from('sync_tasks').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
      if (error) fail('update task', error);
    },

    async resetRunningTasks() {
      const { error } = await client.from('sync_tasks').update({ status: 'pending' }).eq('status', 'running');
      if (error) fail('reset tasks', error);
    },

    async countOpenTasks() {
      const count = async (status) => {
        const { count: n, error } = await client.from('sync_tasks').select('id', { count: 'exact', head: true }).eq('status', status);
        if (error) fail('count tasks', error);
        return n || 0;
      };
      return { pending: await count('pending'), running: await count('running') };
    },

    async createBatch(mode, tasks, note) {
      const { data, error } = await client.from('sync_batches').insert({ mode, note: note || null }).select('id').single();
      if (error) fail('create batch', error);
      for (let i = 0; i < tasks.length; i += 200) {
        const chunk = tasks.slice(i, i + 200).map((t) => ({ ...t, batch_id: data.id }));
        const { error: e2 } = await client.from('sync_tasks').insert(chunk);
        if (e2) fail('create tasks', e2);
      }
      return data.id;
    },

    closeFinishedBatches: () => rpc('close_finished_batches'),

    async orphanReturnItemIds(limit) {
      const { data, error } = await client.from('return_lines').select('order_item_id').is('listing_id', null).is('lookup_tried_at', null).limit(limit);
      if (error) fail('read returns', error);
      return [...new Set(data.map((r) => r.order_item_id))];
    }
  };
}

module.exports = { createSupabaseStore };
