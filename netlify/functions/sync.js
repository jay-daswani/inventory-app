const { createClient } = require('@supabase/supabase-js');

exports.schedule = '*/2 * * * *';

function getClient() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

function parseDate(value) {
  if (!value) return new Date().toISOString();
  const d = new Date(value);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
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
      response_body: typeof responseBody === 'string' ? responseBody.substring(0, 5000) : JSON.stringify(responseBody).substring(0, 5000)
    });
  } catch (e) {}
}

async function getFlipkartToken(client) {
  const consumerId = process.env.FLIPKART_CONSUMER_ID;
  const consumerSecret = process.env.FLIPKART_CONSUMER_SECRET;
  if (!consumerId || !consumerSecret) return null;
  try {
    const response = await fetch('https://api.flipkart.net/oauth-service/oauth/token?grant_type=client_credentials', {
      method: 'GET',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(consumerId + ':' + consumerSecret).toString('base64'),
        'User-Agent': 'InventoryApp/1.0'
      }
    });
    const text = await response.text();
    if (!response.ok) {
      await saveDebug(client, 'flipkart-auth', 'FAILED', response.status, text);
      return null;
    }
    return JSON.parse(text).access_token;
  } catch (err) {
    await saveDebug(client, 'flipkart-auth', 'Exception', 0, err.message);
    return null;
  }
}

// ============================================================
// TRY MULTIPLE REQUEST FORMATS TO FIND THE WORKING ONE
// ============================================================
async function tryFlipkartRequest(client, token, label, body) {
  const url = 'https://api.flipkart.net/sellers/v3/shipments/filter/';
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
        'User-Agent': 'InventoryApp/1.0'
      },
      body: JSON.stringify(body)
    });

    const text = await response.text();
    await saveDebug(client, 'flipkart-TEST-' + label, JSON.stringify(body), response.status, text);

    if (!response.ok) return { success: false, shipments: [] };

    const data = JSON.parse(text);
    let shipments = [];

    if (Array.isArray(data)) shipments = data;
    else if (data.shipments && Array.isArray(data.shipments)) shipments = data.shipments;
    else if (data.orderItems && Array.isArray(data.orderItems)) shipments = data.orderItems;
    else if (data.orders && Array.isArray(data.orders)) shipments = data.orders;
    else if (data.data && Array.isArray(data.data)) shipments = data.data;
    else if (data.shipmentItems && Array.isArray(data.shipmentItems)) shipments = data.shipmentItems;

    if (shipments.length === 0) {
      await saveDebug(client, 'flipkart-PARSE-' + label, 'Response keys: ' + Object.keys(data).join(', '), 200, JSON.stringify(data).substring(0, 3000));
    }

    return { success: true, shipments, label };
  } catch (err) {
    await saveDebug(client, 'flipkart-TEST-' + label, 'Exception', 0, err.message);
    return { success: false, shipments: [] };
  }
}

async function fetchFlipkartOrders(client, token) {
  if (!token) return [];

  const fromDate = daysAgoYMD(7);
  const toDate = daysAgoYMD(0);

  // TEST 1: states as comma-separated string, no sort/paging
  const test1 = await tryFlipkartRequest(client, token, 'states-string-no-sort', {
    filter: {
      type: 'preDispatch',
      states: 'APPROVED,PACKING_IN_PROGRESS,PACKED,READY_TO_DISPATCH',
      orderDate: { from: fromDate, to: toDate }
    }
  });
  if (test1.success && test1.shipments.length > 0) return processShipments(test1.shipments);

  // TEST 2: states as array, no sort/paging
  const test2 = await tryFlipkartRequest(client, token, 'states-array-no-sort', {
    filter: {
      type: 'preDispatch',
      states: ['APPROVED', 'PACKING_IN_PROGRESS', 'PACKED', 'READY_TO_DISPATCH'],
      orderDate: { from: fromDate, to: toDate }
    }
  });
  if (test2.success && test2.shipments.length > 0) return processShipments(test2.shipments);

  // TEST 3: states as string, with sort/paging inside filter
  const test3 = await tryFlipkartRequest(client, token, 'states-string-sort-inside', {
    filter: {
      type: 'preDispatch',
      states: 'APPROVED,PACKING_IN_PROGRESS,PACKED,READY_TO_DISPATCH',
      orderDate: { from: fromDate, to: toDate },
      sort: { orderDate: 'desc' },
      paging: { pageSize: 25 }
    }
  });
  if (test3.success && test3.shipments.length > 0) return processShipments(test3.shipments);

  // TEST 4: states as string, sort/paging at top level
  const test4 = await tryFlipkartRequest(client, token, 'states-string-sort-outside', {
    filter: {
      type: 'preDispatch',
      states: 'APPROVED,PACKING_IN_PROGRESS,PACKED,READY_TO_DISPATCH',
      orderDate: { from: fromDate, to: toDate }
    },
    sort: { orderDate: 'desc' },
    paging: { pageSize: 25 }
  });
  if (test4.success && test4.shipments.length > 0) return processShipments(test4.shipments);

  // TEST 5: minimal - just type and states string, no dates
  const test5 = await tryFlipkartRequest(client, token, 'minimal-no-dates', {
    filter: {
      type: 'preDispatch',
      states: 'APPROVED,PACKING_IN_PROGRESS,PACKED,READY_TO_DISPATCH'
    }
  });
  if (test5.success && test5.shipments.length > 0) return processShipments(test5.shipments);

  // TEST 6: postDispatch with states string
  const test6 = await tryFlipkartRequest(client, token, 'postDispatch-states-string', {
    filter: {
      type: 'postDispatch',
      states: 'SHIPPED,DELIVERED',
      orderDate: { from: daysAgoYMD(30), to: toDate }
    }
  });
  if (test6.success && test6.shipments.length > 0) return processShipments(test6.shipments);

  await saveDebug(client, 'flipkart-all-failed', 'All 6 formats failed', 0, 'Check flipkart-TEST-* rows');
  return [];
}

function processShipments(shipments) {
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
      dispatch_status: shipment.fulfilmentType || shipment.dispatchStatus || (shipment.shipmentStatus || ''),
      is_cancelled_pre_dispatch: ['CANCELLED', 'CUSTOMER_CANCELLED', 'CANCEL', 'FORM_FAILED'].some(
        s => String(shipment.shipmentStatus || shipment.status || '').toUpperCase().includes(s)
      ),
      cancellation_date: shipment.cancellationDate || null
    }));
  });
}

// ============================================================
// MAIN SYNC
// ============================================================
exports.handler = async (event) => {
  const started = new Date().toISOString();
  let importedOrders = 0;
  const errors = [];

  let client = null;
  try { client = getClient(); } catch (err) {
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
          if (error) errors.push('FK ' + order.order_id + ': ' + error.message);
          else if (data && data.new) importedOrders++;
        } catch (e) { errors.push('FK: ' + e.message); }
      }
    } else {
      errors.push('Flipkart auth failed');
    }

    const status = errors.length ? 'partial' : 'success';
    try {
      await client.from('sync_logs').insert({
        platform: 'All', status, records_imported: importedOrders,
        error: errors.length ? errors.slice(0, 10).join(' | ') : null,
        started_at: started, finished_at: new Date().toISOString()
      });
    } catch (e) {}

    return { statusCode: errors.length ? 207 : 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ importedOrders, errors: errors.slice(0, 20) }) };
  } catch (err) {
    try {
      if (client) await client.from('sync_logs').insert({ platform: 'All', status: 'error', records_imported: 0, error: err.message, started_at: started, finished_at: new Date().toISOString() });
    } catch (e) {}
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message || String(err) }) };
  }
};
