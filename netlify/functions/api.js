const { createClient } = require('@supabase/supabase-js');

function getClient() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

function resp(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    },
    body: JSON.stringify(body)
  };
}

exports.handler = async (event, context) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return resp(200, {});
  }

  try {
    const client = getClient();
    const q = event.queryStringParameters || {};
    const body = event.body ? JSON.parse(event.body) : {};

    // ===== GET REQUESTS =====
    if (event.httpMethod === 'GET') {
      const resource = q.resource;

      if (resource === 'dashboard') {
        const { data, error } = await client.rpc('dashboard_summary');
        if (error) throw new Error('Dashboard: ' + error.message);
        return resp(200, data || [{}]);
      }

      if (resource === 'packing-queue') {
        const { data, error } = await client
          .from('orders').select('*')
          .eq('is_cancelled_pre_dispatch', false)
          .order('order_date', { ascending: false }).limit(300);
        if (error) throw new Error('Packing queue: ' + error.message);
        
        // Only show orders that actually need packing
        const packingQueue = (data || []).filter(r => {
          const dispatch = (r.dispatch_status || '').toLowerCase();
          const status = (r.status || '').toUpperCase();
          
          // Hide if already dispatched
          if (dispatch === 'dispatched') return false;
          
          // Hide if Flipkart says it's shipped/delivered/cancelled
          if (['SHIPPED', 'DELIVERED', 'PICKUP_COMPLETE', 'CANCELLED', 'CUSTOMER_CANCELLED'].includes(status)) return false;
          
          return true;
        });
        
        return resp(200, packingQueue);
      }

      if (resource === 'returns-pending') {
        const { data, error } = await client
          .from('returns')
          .select('*')
          .eq('condition', 'pending')
          .order('return_date', { ascending: false })
          .limit(200);
        if (error) throw new Error('Returns: ' + error.message);
        return resp(200, data || []);
      }

      if (resource === 'inventory') {
        const { data, error } = await client
          .from('inventory_balances')
          .select('*, sku_master(*)')
          .order('master_sku_id');
        if (error) throw new Error('Inventory: ' + error.message);
        return resp(200, data || []);
      }

      if (resource === 'manufacturing-plan') {
        const { data, error } = await client.rpc('get_manufacturing_plan', {
          p_horizon_weeks: Number(q.weeks || 4),
          p_method: q.method || '13W'
        });
        if (error) throw new Error('Manufacturing: ' + error.message);
        return resp(200, data || []);
      }

      if (resource === 'sku-master') {
        const { data, error } = await client
          .from('sku_master')
          .select('*')
          .order('master_sku_id');
        if (error) throw new Error('SKU master: ' + error.message);
        return resp(200, data || []);
      }

      if (resource === 'exceptions') {
        const [negative, unmapped] = await Promise.all([
          client.from('inventory_balances').select('*').lt('sellable_stock', 0),
          client.from('unmapped_skus').select('*').order('last_seen', { ascending: false }).limit(200)
        ]);
        if (negative.error) throw new Error('Negative inventory: ' + negative.error.message);
        if (unmapped.error) throw new Error('Unmapped SKUs: ' + unmapped.error.message);
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
          .limit(50);
        if (error) throw new Error('Sync logs: ' + error.message);
        return resp(200, data || []);
      }

      return resp(404, { error: 'Unknown resource: ' + resource });
    }

    // ===== POST REQUESTS =====
    if (event.httpMethod === 'POST') {
      const action = body.action || q.action;

      if (action === 'classify-return') {
        const { error } = await client.rpc('classify_return', {
          p_return_db_id: Number(body.return_db_id),
          p_classification: body.classification,
          p_user: body.user || 'web'
        });
        if (error) throw new Error('Classify return: ' + error.message);
        return resp(200, { ok: true });
      }

      if (action === 'mark-dispatched') {
        const { error } = await client
          .from('orders')
          .update({ dispatch_status: 'Dispatched' })
          .eq('id', Number(body.order_db_id));
        if (error) throw new Error('Mark dispatched: ' + error.message);
        return resp(200, { ok: true });
      }

      if (action === 'add-inventory') {
        const { error } = await client.rpc('add_manual_inventory', {
          p_master_sku_id: body.master_sku_id,
          p_quantity: Number(body.quantity || 0),
          p_note: body.note || '',
          p_user: body.user || 'web'
        });
        if (error) throw new Error('Add inventory: ' + error.message);
        return resp(200, { ok: true });
      }

      if (action === 'process-to-sellable') {
        const { error } = await client.rpc('mark_processing_sellable', {
          p_master_sku_id: body.master_sku_id,
          p_quantity: Number(body.quantity || 0),
          p_user: body.user || 'web'
        });
        if (error) throw new Error('Process to sellable: ' + error.message);
        return resp(200, { ok: true });
      }

      if (action === 'add-manufacturing') {
        const { error } = await client.rpc('add_manufacturing_stock', {
          p_master_sku_id: body.master_sku_id,
          p_quantity: Number(body.quantity || 0),
          p_user: body.user || 'web'
        });
        if (error) throw new Error('Add manufacturing: ' + error.message);
        return resp(200, { ok: true });
      }

      if (action === 'map-sku') {
        const { error } = await client.rpc('map_platform_sku', {
          p_platform: body.platform,
          p_platform_sku_id: body.platform_sku_id,
          p_master_sku_id: body.master_sku_id,
          p_user: body.user || 'web'
        });
        if (error) throw new Error('Map SKU: ' + error.message);
        return resp(200, { ok: true });
      }

      if (action === 'import-orders') {
        const orders = body.orders || [];
        let imported = 0;
        const errors = [];
        for (const order of orders) {
          try {
            const { data, error } = await client.rpc('import_order', {
              p_platform: order.platform || 'Amazon',
              p_order_id: String(order.order_id || ''),
              p_order_line_id: String(order.order_line_id || order.order_id || ''),
              p_order_date: order.order_date || new Date().toISOString(),
              p_platform_sku_id: String(order.platform_sku_id || ''),
              p_product_name: order.product_name || null,
              p_quantity: Number(order.quantity || 1),
              p_selling_price: order.selling_price || null,
              p_region: order.region || null,
              p_status: order.status || 'Pending',
              p_dispatch_status: order.dispatch_status || 'Pending',
              p_is_cancelled_pre_dispatch: order.is_cancelled_pre_dispatch === true,
              p_cancellation_date: order.cancellation_date || null
            });
            if (error) errors.push(order.order_id + ': ' + error.message);
            else if (data && data.new) imported++;
          } catch (e) {
            errors.push(order.order_id + ': ' + e.message);
          }
        }
        return resp(200, { imported, errors: errors.slice(0, 20) });
      }

      if (action === 'import-returns') {
        const returns = body.returns || [];
        let imported = 0;
        const errors = [];
        for (const ret of returns) {
          try {
            const { data, error } = await client.rpc('import_return', {
              p_platform: ret.platform || 'Amazon',
              p_return_id: String(ret.return_id || ''),
              p_order_id: String(ret.order_id || ''),
              p_return_date: ret.return_date || new Date().toISOString(),
              p_order_date: ret.order_date || null,
              p_platform_sku_id: String(ret.platform_sku_id || ''),
              p_product_name: ret.product_name || null,
              p_quantity: Number(ret.quantity || 1),
              p_region: ret.region || null,
              p_major_reason: ret.major_reason || null,
              p_minor_reason: ret.minor_reason || null,
              p_status: ret.status || 'Pending'
            });
            if (error) errors.push(ret.return_id + ': ' + error.message);
            else if (data && data.new) imported++;
          } catch (e) {
            errors.push(ret.return_id + ': ' + e.message);
          }
        }
        return resp(200, { imported, errors: errors.slice(0, 20) });
      }

      return resp(404, { error: 'Unknown action: ' + action });
    }

    return resp(405, { error: 'Method not allowed: ' + event.httpMethod });

  } catch (err) {
    // CATCH ALL - never let the function crash with unhandled error
    return resp(500, { error: err.message || String(err) });
  }
};
