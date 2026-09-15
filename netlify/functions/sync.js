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

function daysAgoISO(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

// Save debug info to Supabase so we can see it without Netlify logs
async function saveDebug(client, source, requestInfo, responseStatus, responseBody) {
  try {
    await client.from('sync_debug').insert({
      source: source,
      request_info: typeof requestInfo === 'string' ? requestInfo : JSON.stringify(requestInfo),
      response_status: responseStatus,
      response_body: typeof responseBody === 'string'
        ? responseBody.substring(0, 5000)
        : JSON.stringify(responseBody).substring(0, 5000)
    });
  } catch (e) {
    console.error('Failed to save debug:', e.message);
  }
}

// ============================================================
// FLIPKART AUTH
// ============================================================
async function getFlipkartToken(client) {
  const consumerId = process.env.FLIPKART_CONSUMER_ID;
  const consumerSecret = process.env.FLIPKART_CONSUMER_SECRET;

  if (!consumerId || !consumerSecret) {
    await saveDebug(client, 'flipkart-auth', 'No credentials set', 0, 'FLIPKART_CONSUMER_ID or FLIPKART_CONSUMER_SECRET is missing from environment variables');
    return null;
  }

  try {
    const url = 'https://api.flipkart.net/oauth-service/oauth/token?grant_type=client_credentials';

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(consumerId + ':' + consumerSecret).toString('base64'),
        'User-Agent': 'InventoryApp/1.0'
      }
    });

    const responseText = await response.text();

    await saveDebug(client, 'flipkart-auth', url, response.status, responseText);

    if (!response.ok) {
      return null;
    }

    const data = JSON.parse(responseText);
    return data.access_token;
  } catch (err) {
    await saveDebug(client, 'flipkart-auth', 'Exception', 0, err.message);
    return null;
  }
}

// ============================================================
// FLIPKART ORDERS
// ============================================================
async function fetchFlipkartOrders(client, token) {
  if (!token) return [];

  try {
    const fromDate = daysAgoISO(7);
    const toDate = new Date().toISOString();

    const requestBody = {
      filter: {
        orderDate: {
          fromDate: fromDate,
          toDate: toDate
        }
      },
      sort: {
        orderDate: 'desc'
      },
      paging: {
        pageSize: 100
      }
    };

    const url = 'https://api.flipkart.net/sellers/v3/shipments/filter/';

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
        'User-Agent': 'InventoryApp/1.0'
      },
      body: JSON.stringify(requestBody)
    });

    const responseText = await response.text();

    // Save the raw response so we can see exactly what Flipkart sent
    await saveDebug(client, 'flipkart-orders', JSON.stringify(requestBody), response.status, responseText);

    if (!response.ok) {
      return [];
    }

    const data = JSON.parse(responseText);

    // Try every possible response structure Flipkart might use
    let shipments = [];

    if (Array.isArray(data)) {
      shipments = data;
    } else if (data.shipments && Array.isArray(data.shipments)) {
      shipments = data.shipments;
    } else if (data.orderItems && Array.isArray(data.orderItems)) {
      shipments = data.orderItems;
    } else if (data.orders && Array.isArray(data.orders)) {
      shipments = data.orders;
    } else if (data.data && Array.isArray(data.data)) {
      shipments = data.data;
    } else if (data.shipmentItems && Array.isArray(data.shipmentItems)) {
      shipments = data.shipmentItems;
    }

    // If still empty, save what keys exist so we can debug
    if (shipments.length === 0) {
      await saveDebug(client, 'flipkart-orders-parse',
        'Could not find orders array. Top-level keys: ' + Object.keys(data).join(', '),
        200,
        JSON.stringify(data).substring(0, 3000)
      );
      return [];
    }

    return shipments.flatMap(shipment => {
      const orderItems = shipment.orderItems || shipment.items || shipment.shipmentItems || [shipment];

      return orderItems.map(item => ({
        platform: 'Flipkart',
        order_id: String(shipment.orderId || shipment.fsnId || item.orderId || ''),
        order_line_id: String(item.orderItemId || item.sku || item.orderId || shipment.orderId || ''),
        order_date: parseDate(shipment.orderDate || shipment.createdAt || item.orderDate),
        platform_sku_id: String(item.sellerSku || item.sku || shipment.sku || ''),
        product_name: item.productName || item.title || shipment.productName || '',
        quantity: Number(item.quantity || shipment.quantity || item.qty || 1),
        selling_price: item.sellingPrice || item.price || shipment.sellingPrice || null,
        region: shipment.shippingRegion || shipment.region || shipment.customerRegion || null,
        status: shipment.shipmentStatus || shipment.status || item.status || 'Pending',
        dispatch_status: shipment.fulfilmentType || shipment.dispatchStatus || 'Pending',
        is_cancelled_pre_dispatch: ['CANCELLED', 'CUSTOMER_CANCELLED', 'CANCEL'].some(
          s => String(shipment.shipmentStatus || shipment.status || '').toUpperCase().includes(s)
        ),
        cancellation_date: shipment.cancellationDate || null
      }));
    });
  } catch (err) {
    await saveDebug(client, 'flipkart-orders-error', 'Exception', 0, err.message);
    return [];
  }
}

// ============================================================
// AMAZON (placeholder)
// ============================================================
async function fetchAmazonOrders(client) {
  const clientId = process.env.AMAZON_CLIENT_ID;
  const clientSecret = process.env.AMAZON_CLIENT_SECRET;
  const refreshToken = process.env.AMAZON_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    await saveDebug(client, 'amazon-auth', 'Amazon credentials not set', 0, 'Skipping Amazon');
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

    const tokenText = await tokenResponse.text();
    await saveDebug(client, 'amazon-auth', 'Token request', tokenResponse.status, tokenText);

    if (!tokenResponse.ok) return [];
    return [];
  } catch (err) {
    await saveDebug(client, 'amazon-auth', 'Exception', 0, err.message);
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
    const fkToken = await getFlipkartToken(client);

    if (fkToken) {
      const fkOrders = await fetchFlipkartOrders(client, fkToken);

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
          if (error) {
            errors.push('FK order ' + order.order_id + ': ' + error.message);
            await saveDebug(client, 'flipkart-import-error', order.order_id, 0, error.message);
          } else if (data && data.new) {
            importedOrders++;
          }
        } catch (e) {
          errors.push('FK order insert error: ' + e.message);
        }
      }
    } else {
      errors.push('Flipkart: Auth failed or credentials missing');
    }

    // ---- AMAZON ----
    const amzOrders = await fetchAmazonOrders(client);
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
    } catch (e) {}

    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message || String(err) })
    };
  }
};
