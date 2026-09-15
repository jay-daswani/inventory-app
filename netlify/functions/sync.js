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

function daysAgoYMD(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

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
  } catch (e) {}
}

// ============================================================
// FLIPKART AUTH
// ============================================================
async function getFlipkartToken(client) {
  const consumerId = process.env.FLIPKART_CONSUMER_ID;
  const consumerSecret = process.env.FLIPKART_CONSUMER_SECRET;

  if (!consumerId || !consumerSecret) return null;

  try {
    const response = await fetch(
      'https://api.flipkart.net/oauth-service/oauth/token?grant_type=client_credentials',
      {
        method: 'GET',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(consumerId + ':' + consumerSecret).toString('base64'),
          'User-Agent': 'InventoryApp/1.0'
        }
      }
    );
    const text = await response.text();
    if (!response.ok) {
      await saveDebug(client, 'flipkart-auth', 'FAILED', response.status, text);
      return null;
    }
    const data = JSON.parse(text);
    return data.access_token;
  } catch (err) {
    await saveDebug(client, 'flipkart-auth', 'Exception', 0, err.message);
    return null;
  }
}

// ============================================================
// TRY MULTIPLE FILTER FORMATS TO FIND THE RIGHT ONE
// ============================================================
async function tryFetchShipments(client, token, filterBody, label) {
  const url = 'https://api.flipkart.net/sellers/v3/shipments/filter/';
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
      'User-Agent': 'InventoryApp/1.0'
    },
    body: JSON.stringify(filterBody)
  });

  const text = await response.text();
  await saveDebug(client, 'flipkart-orders-TEST-' + label, JSON.stringify(filterBody), response.status, text);

  if (!response.ok) {
    return { success: false, shipments: [] };
  }

  const data = JSON.parse(text);
  let shipments = [];

  if (Array.isArray(data)) shipments = data;
  else if (data.shipments && Array.isArray(data.shipments)) shipments = data.shipments;
  else if (data.orderItems && Array.isArray(data.orderItems)) shipments = data.orderItems;
  else if (data.orders && Array.isArray(data.orders)) shipments = data.orders;
  else if (data.data && Array.isArray(data.data)) shipments = data.data;
  else if (data.shipmentItems && Array.isArray(data.shipmentItems)) shipments = data.shipmentItems;

  if (shipments.length === 0) {
    await saveDebug(client, 'flipkart-parse-' + label,
      'Keys in response: ' + Object.keys(data).join(', '),
      200, JSON.stringify(data).substring(0, 3000));
  }

  return { success: true, shipments };
}

async function fetchFlipkartOrders(client, token) {
  if (!token) return [];

  const toDate = new Date();
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - 7);

  const toDateISO = toDate.toISOString();
  const fromDateISO = fromDate.toISOString();
  const toDateYMD = toDate.toISOString().split('T')[0];
  const fromDateYMD = fromDate.toISOString().split('T')[0];

  // Try 4 different filter structures - one of them must work!
  const tests = [
    {
      label: 'empty',
      body: { filter: {} }
    },
    {
      label: 'from-to-YMD',
      body: {
        filter: {
          orderDate: { from: fromDateYMD, to: toDateYMD }
        }
      }
    },
    {
      label: 'fromDate-toDate-YMD',
      body: {
        filter: {
          orderDate: { fromDate: fromDateYMD, toDate: toDateYMD }
        }
      }
    },
    {
      label: 'fromDate-toDate-ISO',
      body: {
        filter: {
          orderDate: { fromDate: fromDateISO, toDate: toDateISO }
        }
      }
    }
  ];

  for (const test of tests) {
    try {
      const result = await tryFetchShipments(client, token, test.body, test.label);
      
      if (result.success && result.shipments.length > 0) {
        // FOUND WORKING FORMAT!
        await saveDebug(client, 'flipkart-orders-WORKING',
          'Format that worked: ' + test.label,
          200, 'Found ' + result.shipments.length + ' shipments');

        return result.shipments.flatMap(shipment => {
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
      }
    } catch (err) {
      await saveDebug(client, 'flipkart-orders-test-error', test.label, 0, err.message);
    }
  }

  // All tests failed
  await saveDebug(client, 'flipkart-orders-all-failed',
    'None of the 4 filter formats worked',
    0, 'Check the flipkart-orders-TEST-* rows above to see Flipkart responses');
  return [];
}

// ============================================================
// AMAZON (placeholder)
// ============================================================
async function fetchAmazonOrders(client) {
  const clientId = process.env.AMAZON_CLIENT_ID;
  const clientSecret = process.env.AMAZON_CLIENT_SECRET;
  const refreshToken = process.env.AMAZON_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    await saveDebug(client, 'amazon-auth', 'Not configured', 0, 'Skipping');
    return [];
  }
  await saveDebug(client, 'amazon-auth', 'Configured but not fetching orders yet', 0, 'OK');
  return [];
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
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'DB failed: ' + err.message }) };
  }

  try {
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
          if (error) errors.push('FK order ' + order.order_id + ': ' + error.message);
          else if (data && data.new) importedOrders++;
        } catch (e) {
          errors.push('FK insert: ' + e.message);
        }
      }
    } else {
      errors.push('Flipkart auth failed');
    }

    const amzOrders = await fetchAmazonOrders(client);
    // (Amazon orders not implemented yet)

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
    } catch (logErr) {}

    return {
      statusCode: errors.length ? 207 : 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ importedOrders, importedReturns, errors: errors.slice(0, 20) })
    };
  } catch (err) {
    try {
      if (client) {
        await client.from('sync_logs').insert({
          platform: 'All', status: 'error', records_imported: 0,
          error: err.message || String(err), started_at: started, finished_at: new Date().toISOString()
        });
      }
    } catch (e) {}
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message || String(err) }) };
  }
};
