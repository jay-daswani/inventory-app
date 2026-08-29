const { createClient } = require('@supabase/supabase-js');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

function getClient() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.');
  }

  return createClient(url, serviceKey, {
    auth: {
      persistSession: false
    }
  });
}

function resp(statusCode, body) {
  return {
    statusCode,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  };
}

function toBool(value) {
  if (value === true || value === false) return value;
  if (value === null || value === undefined) return false;

  const s = String(value).trim().toLowerCase();
  return ['true', '1', 'yes', 'y', 'cancelled', 'canceled'].includes(s);
}

function parseDate(value) {
  if (!value) return new Date().toISOString();
  const d = new Date(value);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function mapOrder(o, defaultPlatform) {
  const platform = o.platform || defaultPlatform || 'Amazon';
  const orderId = String(o.order_id || o.orderId || o.order_id_raw || '');
  const orderLineId = String(o.order_line_id || o.order_item_id || o.orderItemId || o.order_line_id_raw || orderId);

  let cancelled = o.is_cancelled_pre_dispatch ?? o.cancelled_pre_dispatch ?? o.pre_dispatch_cancellation ?? o.is_cancelled ?? null;

  if (cancelled === null || cancelled === undefined) {
    const status = String(o.status || '').toLowerCase();
    const dispatch = String(o.dispatch_status || '').toLowerCase();
    cancelled = status.includes('cancel') && !dispatch.includes('ship') && !dispatch.includes('dispatch');
  } else {
    cancelled = toBool(cancelled);
  }

  return {
    p_platform: platform,
    p_order_id: orderId,
    p_order_line_id: orderLineId,
    p_order_date: parseDate(o.order_date || o.orderDate || o.purchase_date),
    p_platform_sku_id: String(o.platform_sku_id || o.sku || o.seller_sku || ''),
    p_product_name: o.product_name || o.productName || o.title || null,
    p_quantity: Number(o.quantity || o.Quantity || 1) || 1,
    p_selling_price: o.selling_price || o.price || o.sellingPrice || null,
    p_region: o.region || o.state || o.customer_region || null,
    p_status: o.status || 'Pending',
    p_dispatch_status: o.dispatch_status || o.dispatchStatus || 'Pending',
    p_is_cancelled_pre_dispatch: cancelled,
    p_cancellation_date: o.cancellation_date ? parseDate(o.cancellation_date) : null
  };
}

function mapReturn(r, defaultPlatform) {
  return {
    p_platform: r.platform || defaultPlatform || 'Amazon',
    p_return_id: String(r.return_id || r.returnId || ''),
    p_order_id: String(r.order_id || r.orderId || ''),
    p_return_date: parseDate(r.return_date || r.returnDate || r.created_date),
    p_order_date: r.order_date ? parseDate(r.order_date) : null,
    p_platform_sku_id: String(r.platform_sku_id || r.sku || r.seller_sku || ''),
    p_product_name: r.product_name || r.productName || r.title || null,
    p_quantity: Number(r.quantity || r.Quantity || 1) || 1,
    p_region: r.region || r.state || r.customer_region || null,
    p_major_reason: r.major_reason || r.majorReason || r.reason || null,
    p_minor_reason: r.minor_reason || r.minorReason || r.detailed_reason || null,
    p_status: r.status || 'Pending'
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return resp(200, {});
  }

  try {
    const client = getClient();
    const q = event.queryStringParameters || {};
    const body = event.body ? JSON.parse(event.body) : {};

    if (event.httpMethod === 'GET') {
      const resource = q.resource;

      if (resource === 'dashboard') {
        const { data, error } = await client.rpc('dashboard_summary');
        if (error) throw new Error(error.message);
        return resp(200, data);
      }

      if (resource === 'packing-queue') {
        const { data, error } = await client
          .from('orders')
          .select('*')
          .eq('is_cancelled_pre_dispatch', false)
          .order('order_date', { ascending: false })
          .limit(300);

        if (error) throw new Error(error.message);

        const rows = (data || []).filter(row => {
          return String(row.dispatch_status || '').toLowerCase() !== 'dispatched';
        });

        return resp(200, rows);
      }

      if (resource === 'returns-pending') {
        const { data, error } = await client
          .from('returns')
          .select('*')
          .eq('condition', 'pending')
          .order('return_date', { ascending: false })
          .limit(300);

        if (error) throw new Error(error.message);
        return resp(200, data || []);
      }

      if (resource === 'inventory') {
        const { data, error } = await client
          .from('inventory_balances')
          .select('*, sku_master(*)')
          .order('master_sku_id');

        if (error) throw new Error(error.message);
        return resp(200, data || []);
      }

      if (resource === 'manufacturing-plan') {
        const { data, error } = await client.rpc('get_manufacturing_plan', {
          p_horizon_weeks: Number(q.weeks || 4),
          p_method: q.method || '13W'
        });

        if (error) throw new Error(error.message);
        return resp(200, data || []);
      }

      if (resource === 'sku-master') {
        const { data, error } = await client
          .from('sku_master')
          .select('*')
          .order('master_sku_id');

        if (error) throw new Error(error.message);
        return resp(200, data || []);
      }

      if (resource === 'exceptions') {
        const [negative, unmapped] = await Promise.all([
          client.from('inventory_balances').select('*').lt('sellable_stock', 0),
          client.from('unmapped_skus').select('*').order('last_seen', { ascending: false }).limit(200)
        ]);

        if (negative.error) throw new Error(negative.error.message);
        if (unmapped.error) throw new Error(unmapped.error.message);

        return resp(200, {
          negative_inventory: negative.data || [],
          unmapped_skus: unmapped.data || []
        });
      }

      if (resource === 'sync-logs') {
        const { data, error } = await client
          .from('sync_logs')
          .select('*')
          .order('started_at', { ascending: false })
          .limit(100);

        if (error) throw new Error(error.message);
        return resp(200, data || []);
      }

      return resp(404, { error: 'Unknown resource' });
    }

    if (event.httpMethod === 'POST') {
      const action = body.action || q.action;

      if (action === 'classify-return') {
        const { error } = await client.rpc('classify_return', {
          p_return_db_id: Number(body.return_db_id),
          p_classification: body.classification,
          p_user: body.user || 'web'
        });

        if (error) throw new Error(error.message);
        return resp(200, { ok: true });
      }

      if (action === 'mark-dispatched') {
        const { error } = await client
          .from('orders')
          .update({ dispatch_status: 'Dispatched' })
          .eq('id', Number(body.order_db_id));

        if (error) throw new Error(error.message);
        return resp(200, { ok: true });
      }

      if (action === 'add-inventory') {
        const { error } = await client.rpc('add_manual_inventory', {
          p_master_sku_id: body.master_sku_id,
          p_quantity: Number(body.quantity || 0),
          p_note: body.note || '',
          p_user: body.user || 'web'
        });

        if (error) throw new Error(error.message);
        return resp(200, { ok: true });
      }

      if (action === 'process-to-sellable') {
        const { error } = await client.rpc('mark_processing_sellable', {
          p_master_sku_id: body.master_sku_id,
          p_quantity: Number(body.quantity || 0),
          p_user: body.user || 'web'
        });

        if (error) throw new Error(error.message);
        return resp(200, { ok: true });
      }

      if (action === 'add-manufacturing') {
        const { error } = await client.rpc('add_manufacturing_stock', {
          p_master_sku_id: body.master_sku_id,
          p_quantity: Number(body.quantity || 0),
          p_user: body.user || 'web'
        });

        if (error) throw new Error(error.message);
        return resp(200, { ok: true });
      }

      if (action === 'map-sku') {
        const { error } = await client.rpc('map_platform_sku', {
          p_platform: body.platform,
          p_platform_sku_id: body.platform_sku_id,
          p_master_sku_id: body.master_sku_id,
          p_user: body.user || 'web'
        });

        if (error) throw new Error(error.message);
        return resp(200, { ok: true });
      }

      if (action === 'import-orders') {
        const orders = body.orders || [];
        let imported = 0;
        const errors = [];

        for (const order of orders) {
          const mapped = mapOrder(order, order.platform || 'Amazon');
          const { data, error } = await client.rpc('import_order', mapped);

          if (error) {
            errors.push(`${mapped.p_order_id}: ${error.message}`);
          } else if (data && data.new) {
            imported += 1;
          }
        }

        return resp(200, { imported, errors: errors.slice(0, 20) });
      }

      if (action === 'import-returns') {
        const returns = body.returns || [];
        let imported = 0;
        const errors = [];

        for (const ret of returns) {
          const mapped = mapReturn(ret, ret.platform || 'Amazon');
          const { data, error } = await client.rpc('import_return', mapped);

          if (error) {
            errors.push(`${mapped.p_return_id}: ${error.message}`);
          } else if (data && data.new) {
            imported += 1;
          }
        }

        return resp(200, { imported, errors: errors.slice(0, 20) });
      }

      return resp(404, { error: 'Unknown action' });
    }

    return resp(405, { error: 'Method not allowed' });
  } catch (err) {
    return resp(500, { error: err.message || String(err) });
  }
};
