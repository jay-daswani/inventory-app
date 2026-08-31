const { createClient } = require('@supabase/supabase-js');

exports.schedule = '*/2 * * * *';

function getClient() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

function parseDate(value) {
  if (!value) return new Date().toISOString();
  const d = new Date(value);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function daysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

// ============================================================
// FLIPKART API
// ============================================================
async function getFlipkartToken() {
  const consumerId = process.env.FLIPKART_CONSUMER_ID;
  const consumerSecret = process.env.FLIPKART_CONSUMER_SECRET;

  if (!consumerId || !consumerSecret) {
    return null;
  }

  try {
    const response = await fetch('https://api.flipkart.net/sellers/v2/auth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(consumerId + ':' + consumerSecret).toString('base64')
      },
      body: 'grant_type=client_credentials&scope=Seller_Api'
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Flipkart auth failed:', response.status, errorText);
      return null;
    }

    const data = await response.json();
    return data.access_token;
  } catch (err) {
    console.error('Flipkart auth error:', err.message);
    return null;
  }
}

async function fetchFlipkartOrders(token) {
  if (!token) return [];

  try {
    const fromDate = daysAgo(3);
    const response = await fetch('https://api.flipkart.net/sellers/v3/orders/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({
        filter: {
          orderDate: {
            fromDate: fromDate,
            toDate: new Date().toISOString()
          }
        },
        sort: { orderDate: 'desc' },
        paging: { pageSize: 100 }
      })
    });

    if (!response.ok) {
      console.error('Flipkart orders failed:', response.status);
      return [];
    }

    const data = await response.json();
    const orders = data.orderItems || data.orders || [];

    return orders.map(order => ({
      platform: 'Flipkart',
      order_id: String(order.orderId || order.order_id || ''),
      order_line_id: String(order.orderItemId || order.order_item_id || order.orderId || ''),
      order_date: parseDate(order.orderDate || order.order_date),
      platform_sku_id: String(order.sellerSku || order.seller_sku || order.sku || ''),
      product_name: order.productName || order.product_name || '',
      quantity: Number(order.quantity || order.qty || 1),
      selling_price: order.sellingPrice || order.selling_price || null,
      region: order.shippingRegion || order.region || order.state || null,
      status: order.orderStatus || order.status || 'Pending',
      dispatch_status: order.fulfilmentType || 'Pending',
      is_cancelled_pre_dispatch: ['CANCELLED', 'CUSTOMER_CANCELLED'].includes(
        String(order.orderStatus || '').toUpperCase()
      ),
      cancellation_date: order.cancellationDate || null
    }));
  } catch (err) {
    console.error('Flipkart orders error:', err.message);
    return [];
  }
}

async function fetchFlipkartReturns(token) {
  if (!token) return [];

  try {
    const fromDate = daysAgo(30);
    const response = await fetch('https://api.flipkart.net/sellers/v3/returns/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({
        filter: {
          returnCreationDate: {
            fromDate: fromDate,
            toDate: new Date().toISOString()
          }
        },
        sort: { returnCreationDate: 'desc' },
        paging: { pageSize: 100 }
      })
    });

    if (!response.ok) {
      console.error('Flipkart returns failed:', response.status);
      return [];
    }

    const data = await response.json();
    const returns = data.returnItems || data.returns || [];

    return returns.map(ret => ({
      platform: 'Flipkart',
      return_id: String(ret.returnId || ret.return_id || ''),
      order_id: String(ret.orderId || ret.order_id || ''),
      return_date: parseDate(ret.returnCreationDate || ret.return_date),
      order_date: ret.orderDate ? parseDate(ret.orderDate) : null,
      platform_sku_id: String(ret.sellerSku || ret.seller_sku || ret.sku || ''),
      product_name: ret.productName || '',
      quantity: Number(ret.quantity || ret.qty || 1),
      region: ret.shippingRegion || null,
      major_reason: ret.returnReason || ret.reason || null,
      minor_reason: ret.returnSubReason || null,
      status: ret.returnStatus || 'Pending'
    }));
  } catch (err) {
    console.error('Flipkart returns error:', err.message);
    return [];
  }
}

// ============================================================
// AMAZON API (simplified - token exchange only)
// ============================================================
async function fetchAmazonOrders() {
  const clientId = process.env.AMAZON_CLIENT_ID;
  const clientSecret = process.env.AMAZON_CLIENT_SECRET;
  const refreshToken = process.env.AMAZON_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    return [];
  }

  try {
    const tokenResponse = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret
      })
    });

    if (!tokenResponse.ok) {
      console.error('Amazon auth failed:', tokenResponse.status);
      return [];
    }

    const tokenData = await tokenResponse.json();
    console.log('Amazon token obtained successfully');

    // NOTE: Full Amazon SP-API requires AWS Signature V4 signing.
    // For now, we log that auth works.
    // Full order fetching will be added once Flipkart is confirmed working.
    return [];
  } catch (err) {
    console.error('Amazon error:', err.message);
    return [];
  }
}

// ============================================================
// MAIN SYNC
// ============================================================
exports.handler = async (event) => {
  const started = new Date().toISOString();
  let importedOrders = 0;
  let importedReturns = 0;
  const errors = [];

  let client = null;

  try {
    client = getClient();
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Database connection failed: ' + err.message })
    };
  }

  try {
    // ---- FLIPKART ----
    const fkToken = await getFlipkartToken();

    if (fkToken) {
      const fkOrders = await fetchFlipkartOrders(fkToken);
      for (const order of fkOrders) {
        try {
          const { data, error } = await client.rpc('import_order', {
            p_platform: order.platform,
            p_order_id: order.order_id,
            p_order_line_id: order.order_line_id,
            p_order_date: order.order_date,
            p_platform_sku_id: order.platform_sku_id,
            p_product_name: order.product_name,
            p_quantity: order.quantity,
            p_selling_price: order.selling_price,
            p_region: order.region,
            p_status: order.status,
            p_dispatch_status: order.dispatch_status,
            p_is_cancelled_pre_dispatch: order.is_cancelled_pre_dispatch,
            p_cancellation_date: order.cancellation_date
          });
          if (error) errors.push('FK order ' + order.order_id + ': ' + error.message);
          else if (data && data.new) importedOrders++;
        } catch (e) {
          errors.push('FK order insert error: ' + e.message);
        }
      }

      const fkReturns = await fetchFlipkartReturns(fkToken);
      for (const ret of fkReturns) {
        try {
          const { data, error } = await client.rpc('import_return', {
            p_platform: ret.platform,
            p_return_id: ret.return_id,
            p_order_id: ret.order_id,
            p_return_date: ret.return_date,
            p_order_date: ret.order_date,
            p_platform_sku_id: ret.platform_sku_id,
            p_product_name: ret.product_name,
            p_quantity: ret.quantity,
            p_region: ret.region,
            p_major_reason: ret.major_reason,
            p_minor_reason: ret.minor_reason,
            p_status: ret.status
          });
          if (error) errors.push('FK return ' + ret.return_id + ': ' + error.message);
          else if (data && data.new) importedReturns++;
        } catch (e) {
          errors.push('FK return insert error: ' + e.message);
        }
      }
    } else {
      errors.push('Flipkart: No credentials or auth failed');
    }

    // ---- AMAZON ----
    const amzOrders = await fetchAmazonOrders();
    for (const order of amzOrders) {
      try {
        const { data, error } = await client.rpc('import_order', {
          p_platform: order.platform,
          p_order_id: order.order_id,
          p_order_line_id: order.order_line_id,
          p_order_date: order.order_date,
          p_platform_sku_id: order.platform_sku_id,
          p_product_name: order.product_name,
          p_quantity: order.quantity,
          p_selling_price: order.selling_price,
          p_region: order.region,
          p_status: order.status,
          p_dispatch_status: order.dispatch_status,
          p_is_cancelled_pre_dispatch: order.is_cancelled_pre_dispatch,
          p_cancellation_date: order.cancellation_date
        });
        if (error) errors.push('AMZ order ' + order.order_id + ': ' + error.message);
        else if (data && data.new) importedOrders++;
      } catch (e) {
        errors.push('AMZ order insert error: ' + e.message);
      }
    }

    // ---- WRITE LOG ----
    const status = errors.length ? 'partial' : 'success';
    try {
      await client.from('sync_logs').insert({
        platform: 'All',
        status: status,
        records_imported: importedOrders + importedReturns,
        error: errors.length ? errors.slice(0, 10).join(' | ') : null,
        started_at: started,
        finished_at: new Date().toISOString()
      });
    } catch (logErr) {
      console.error('Failed to write sync log:', logErr.message);
    }

    return {
      statusCode: errors.length ? 207 : 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        importedOrders,
        importedReturns,
        errors: errors.slice(0, 20)
      })
    };

  } catch (err) {
    // Try to log even if everything failed
    try {
      if (client) {
        await client.from('sync_logs').insert({
          platform: 'All',
          status: 'error',
          records_imported: 0,
          error: err.message || String(err),
          started_at: started,
          finished_at: new Date().toISOString()
        });
      }
    } catch (e) {
      console.error('Could not write error log:', e.message);
    }

    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message || String(err) })
    };
  }
};
