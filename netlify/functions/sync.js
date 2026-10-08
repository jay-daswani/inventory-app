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
// FETCH SHIPMENTS WITH CORRECT FORMAT
// ============================================================
async function fetchShipments(client, token, filterType, statesArray, dateDays, cancellationType = null) {
  const url = 'https://api.flipkart.net/sellers/v3/shipments/filter/';
  const fromDate = daysAgoYMD(dateDays);
  const toDate = daysAgoYMD(0);

  const filterBody = {
    filter: {
      type: filterType,
      states: statesArray,
      orderDate: { from: fromDate, to: toDate }
    },
    pagination: {
      pageSize: 20
    }
  };

  if (filterType === 'cancelled' && cancellationType) {
    filterBody.filter.cancellationType = cancellationType;
  }

  try {
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
    await saveDebug(client, 'flipkart-' + filterType, JSON.stringify(filterBody), response.status, text);

    if (!response.ok) return [];

    const data = JSON.parse(text);
    let shipments = [];

    if (Array.isArray(data)) shipments = data;
    else if (data.shipments && Array.isArray(data.shipments)) shipments = data.shipments;
    else if (data.orderItems && Array.isArray(data.orderItems)) shipments = data.orderItems;

    return shipments;
  } catch (err) {
    await saveDebug(client, 'flipkart-' + filterType + '-error', 'Exception', 0, err.message);
    return [];
  }
}

// ============================================================
// PROCESS SHIPMENTS - USE SHIPMENT ID FOR DEDUPLICATION
// ============================================================
function processShipments(shipments, defaultDispatchStatus, seenShipmentIds) {
  const orders = [];

  for (const shipment of shipments) {
    const shipmentId = String(shipment.shipmentId || shipment.orderId || '');
    
    // Skip if we've already processed this shipment in this sync run
    if (seenShipmentIds.has(shipmentId)) {
      continue;
    }
    seenShipmentIds.add(shipmentId);

    const orderItems = shipment.orderItems || [shipment];
    const shipmentStatus = String(shipment.shipmentStatus || shipment.status || '').toUpperCase();

    let dispatchStatus = defaultDispatchStatus;
    if (['SHIPPED', 'DELIVERED', 'PICKUP_COMPLETE', 'DISPATCHED'].includes(shipmentStatus)) {
      dispatchStatus = 'Dispatched';
    }

    let isCancelled = false;
    if (['CANCELLED', 'CUSTOMER_CANCELLED', 'FORM_FAILED'].some(s => shipmentStatus.includes(s))) {
      isCancelled = true;
    }

    for (const item of orderItems) {
      orders.push({
        platform: 'Flipkart',
        shipment_id: shipmentId,
        order_id: String(shipment.orderId || item.orderId || shipmentId),
        order_line_id: String(item.orderItemId || item.fsn || item.sku || shipmentId),
        order_date: parseDate(item.orderDate || shipment.dispatchAfterDate || shipment.createdAt),
        platform_sku_id: String(item.sku || ''),
        product_name: item.listingId || item.sku || shipment.productName || '',
        quantity: Number(item.quantity || 1),
        selling_price: item.priceComponents ? item.priceComponents.sellingPrice : null,
        region: shipment.locationId || null,
        status: item.status || shipment.shipmentStatus || 'Pending',
        dispatch_status: dispatchStatus,
        is_cancelled_pre_dispatch: isCancelled,
        cancellation_date: item.cancellationDate || null
      });
    }
  }

  return orders;
}

// ============================================================
// FETCH ALL FLIPKART ORDERS
// ============================================================
async function fetchFlipkartOrders(client, token) {
  if (!token) return [];

  try {
    // Track which shipments we've seen to prevent duplicates
    const seenShipmentIds = new Set();

    // 1. Orders ready to pack (preDispatch)
    const preDispatch = await fetchShipments(client, token, 'preDispatch',
      ['APPROVED', 'PACKING_IN_PROGRESS', 'PACKED', 'READY_TO_DISPATCH'], 7);
    const preDispatchOrders = processShipments(preDispatch, 'Pending', seenShipmentIds);

    // 2. Already shipped orders (postDispatch)
    const postDispatch = await fetchShipments(client, token, 'postDispatch',
      ['SHIPPED', 'DELIVERED', 'PICKUP_COMPLETE'], 30);
    const postDispatchOrders = processShipments(postDispatch, 'Dispatched', seenShipmentIds);

    // 3. Cancelled orders
    const cancelledMarketplace = await fetchShipments(client, token, 'cancelled',
      ['CANCELLED'], 30, 'marketplaceCancellation');
    const cancelledSeller = await fetchShipments(client, token, 'cancelled',
      ['CANCELLED'], 30, 'sellerCancellation');
    const cancelledBuyer = await fetchShipments(client, token, 'cancelled',
      ['CANCELLED'], 30, 'buyerCancellation');

    const cancelled = [...cancelledMarketplace, ...cancelledSeller, ...cancelledBuyer];
    const cancelledOrders = processShipments(cancelled, 'Pending', seenShipmentIds);

    await saveDebug(client, 'flipkart-summary',
      'PreDispatch: ' + preDispatch.length + ', PostDispatch: ' + postDispatch.length + ', Cancelled: ' + cancelled.length,
      200, 'Total unique orders: ' + (preDispatchOrders.length + postDispatchOrders.length + cancelledOrders.length));

    return [...preDispatchOrders, ...postDispatchOrders, ...cancelledOrders];
  } catch (err) {
    await saveDebug(client, 'flipkart-orders-error', 'Exception', 0, err.message);
    return [];
  }
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
            p_shipment_id: order.shipment_id,
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
          if (error) errors.push('FK ' + order.shipment_id + ': ' + error.message);
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
