'use strict';

/**
 * Everything the screens can ask for. Each action validates its input and calls one database function.
 * Dates from the screens are Indian calendar days ("2026-10-24"); `to` is inclusive.
 */

const { planFor } = require('./plan');

const STAGES = ['to_dispatch', 'in_transit', 'delivered', 'returned', 'cancelled', 'rto'];
const CONDITIONS = ['sellable', 'damaged', 'dry_clean', 'press'];
const RETURN_TYPES = ['customer_return', 'courier_return'];

class InputError extends Error {}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function dayStart(day) {
  if (day == null || day === '') return null;
  if (!DAY_RE.test(String(day)) || Number.isNaN(Date.parse(day))) throw new InputError('Bad date: ' + day);
  return `${day}T00:00:00+05:30`;
}
function dayAfter(day) {
  if (day == null || day === '') return null;
  if (!DAY_RE.test(String(day)) || Number.isNaN(Date.parse(day))) throw new InputError('Bad date: ' + day);
  const d = new Date(Date.parse(`${day}T00:00:00Z`) + 86400000);
  return `${d.toISOString().slice(0, 10)}T00:00:00+05:30`;
}
const oneOf = (value, list, label) => {
  if (value == null || value === '') return null;
  if (!list.includes(value)) throw new InputError(`Unknown ${label}: ${value}`);
  return value;
};
const text = (v, max = 80) => (v == null ? null : String(v).slice(0, max));
const page = (body) => ({
  limit: Math.min(200, Math.max(1, Number(body.pageSize) || 50)),
  offset: Math.max(0, (Number(body.page) || 0) * Math.min(200, Math.max(1, Number(body.pageSize) || 50)))
});

const ITEM_FIELDS = {
  name: (v) => text(v, 120), design: (v) => text(v, 80), colour: (v) => text(v, 60), size: (v) => text(v, 20), notes: (v) => text(v, 500),
  unit_cost: (v) => {
    if (v === '' || v == null) return '';
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1000000) throw new InputError('Cost must be a number');
    return String(n);
  },
  lead_time_days: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 365) throw new InputError('Lead time must be a whole number of days');
    return String(n);
  },
  opening_stock: (v) => {
    if (v === '' || v == null) return '';
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 1000000) throw new InputError('Stock must be a whole number');
    return String(n);
  },
  active: (v) => String(Boolean(v)),
  needs_review: (v) => String(Boolean(v))
};

async function handleAction(body, deps) {
  const { store, now = () => Date.now(), trigger } = deps;
  const action = body && body.action;
  switch (action) {
    case 'ping':
      return { ok: true };

    case 'overview': {
      const from = dayStart(body.from) || '2020-01-01T00:00:00+05:30';
      const to = dayAfter(body.to) || '2100-01-01T00:00:00+05:30';
      return store.rpc('overview', { p_from: from, p_to: to });
    }

    case 'orders': {
      const { limit, offset } = page(body);
      return store.rpc('api_orders', {
        p_from: dayStart(body.from), p_to: dayAfter(body.to), p_stage: oneOf(body.stage, STAGES, 'stage'),
        p_q: text(body.q, 60), p_limit: limit, p_offset: offset
      });
    }

    case 'returns': {
      const { limit, offset } = page(body);
      return store.rpc('api_returns', {
        p_from: dayStart(body.from), p_to: dayAfter(body.to), p_type: oneOf(body.type, RETURN_TYPES, 'return type'),
        p_status: text(body.status, 30), p_condition: oneOf(body.condition, [...CONDITIONS, 'none'], 'condition'),
        p_q: text(body.q, 60), p_limit: limit, p_offset: offset
      });
    }

    case 'catalogue':
      return { items: await store.rpc('api_catalogue') };

    case 'save_item': {
      const id = Number(body.id);
      if (!Number.isInteger(id) || id <= 0) throw new InputError('Missing item');
      const patch = {};
      for (const [k, v] of Object.entries(body.fields || {})) {
        if (!ITEM_FIELDS[k]) throw new InputError('You cannot change: ' + k);
        patch[k] = ITEM_FIELDS[k](v);
      }
      return { item: await store.rpc('api_save_item', { p_id: id, p_patch: patch }) };
    }

    case 'design_cost': {
      const cost = Number(body.unit_cost);
      if (!body.design || !Number.isFinite(cost) || cost < 0) throw new InputError('Need a design and a cost');
      return { updated: await store.rpc('api_design_cost', { p_design: text(body.design, 80), p_cost: cost }) };
    }

    case 'design_checked': {
      if (!body.design) throw new InputError('Need a design');
      return { updated: await store.rpc('api_design_checked', { p_design: text(body.design, 80), p_checked: body.checked !== false }) };
    }

    case 'set_condition': {
      const id = Number(body.id);
      if (!Number.isInteger(id) || id <= 0) throw new InputError('Missing return');
      const condition = body.condition == null || body.condition === '' ? '' : oneOf(body.condition, CONDITIONS, 'condition');
      return store.rpc('api_set_condition', { p_id: id, p_condition: condition });
    }

    case 'export': {
      const what = body.what === 'returns' ? 'returns' : 'orders';
      return { rows: await store.rpc('api_export', { p_what: what, p_from: dayStart(body.from), p_to: dayAfter(body.to) }) };
    }

    case 'sync_status':
      return store.rpc('sync_overview');

    case 'start_sync': {
      const mode = body.mode === 'history' ? 'history' : 'update';
      const open = await store.countOpenTasks();
      let created = null;
      if (open.pending + open.running === 0) {
        created = await store.createBatch(mode, planFor(mode, now()), 'started from the Sync screen');
      }
      const t = trigger ? await trigger() : { ok: false, reason: 'no trigger' };
      return { started: Boolean(created), continued: created === null, trigger: t };
    }

    default:
      throw new InputError('Unknown request: ' + action);
  }
}

module.exports = { handleAction, InputError };
