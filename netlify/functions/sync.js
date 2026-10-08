const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  
  // 1. Log the start of the sync
  const { data: logData } = await client.from('sync_logs').insert({
    platform: 'Flipkart',
    status: 'Started',
    started_at: new Date().toISOString()
  }).select('id').single();

  const logId = logData ? logData.id : null;

  try {
    // 2. Get Flipkart Token (Fixed: Added required scope=Seller_Api)
    const authRes = await fetch('https://api.flipkart.net/oauth-service/oauth/token?grant_type=client_credentials&scope=Seller_Api', {
      method: 'GET',
      headers: { 
        'Authorization': 'Basic ' + Buffer.from(process.env.FLIPKART_CONSUMER_ID + ':' + process.env.FLIPKART_CONSUMER_SECRET).toString('base64')
      }
    });
    
    if (!authRes.ok) throw new Error('Failed to get Flipkart token: ' + authRes.statusText);
    
    const authData = await authRes.json();
    const token = authData.access_token;
    if (!token) throw new Error('No access token received from Flipkart');

    // 3. Fetch ALL active preDispatch orders (Fixed: Removed date filter, Added Pagination)
    let url = 'https://api.flipkart.net/sellers/v3/shipments/filter/';
    let method = 'POST';
    const body = JSON.stringify({
      filter: {
        type: "preDispatch",
        states: ["APPROVED", "PACKING_IN_PROGRESS", "PACKED", "READY_TO_DISPATCH"]
        // We intentionally DO NOT filter by orderDate here. 
        // We want ALL orders that Flipkart says are waiting to be dispatched.
      },
      pagination: { pageSize: 20 }
    });

    let allShipments = [];
    let hasMore = true;

    while (hasMore) {
      const options = {
        method: method,
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json'
        }
      };
      
      if (method === 'POST') {
        options.body = body;
      }

      const res = await fetch(url, options);
      
      // Save raw response to debug table just in case we need to troubleshoot later
      const text = await res.text();
      await client.from('sync_debug').insert({
        source: 'Flipkart-Sync-Page',
        request_info: url,
        response_status: res.status,
        response_body: text.substring(0, 4000)
      });

      if (!res.ok) throw new Error('Flipkart API error: ' + res.statusText + ' | ' + text);

      const data = JSON.parse(text);
      
      if (data.shipments) {
        allShipments.push(...data.shipments);
      }
      
      hasMore = data.hasMore === true;
      if (hasMore && data.nextPageUrl) {
        // Flipkart returns a relative URL for the next page (e.g., /sellers/v3/shipments/...)
        if (data.nextPageUrl.startsWith('http')) {
          url = data.nextPageUrl;
        } else {
          url = 'https://api.flipkart.net' + data.nextPageUrl;
        }
        method = 'GET'; // Subsequent pages are fetched via GET
      }
    }

    // 4. Process and Upsert to Supabase
    let recordsImported = 0;
    const ordersToUpsert = [];

    for (const shipment of allShipments) {
      if (!shipment.orderItems) continue;
      
      for (const item of shipment.orderItems) {
        ordersToUpsert.push({
          platform: 'Flipkart',
          order_id: item.orderId,
          order_line_id: item.orderItemId,
          order_date: new Date(item.orderDate).toISOString(),
          platform_sku_id: item.sku || 'UNKNOWN_SKU',
          quantity: item.quantity || 1,
          selling_price: item.priceComponents ? item.priceComponents.sellingPrice : null,
          status: item.status,
          dispatch_status: item.status, 
          shipment_id: shipment.shipmentId,
          updated_at: new Date().toISOString()
        });
      }
    }

    if (ordersToUpsert.length > 0) {
      // SMART LOCK: Check which orders are already manually marked as Dispatched/Cancelled by you
      const orderIds = ordersToUpsert.map(o => o.order_id);
      const { data: existingOrders } = await client
        .from('orders')
        .select('order_id, order_line_id, dispatch_status')
        .in('order_id', orderIds);

      const finalizedOrders = new Set(
        (existingOrders || [])
          .filter(o => o.dispatch_status === 'Dispatched' || o.dispatch_status === 'Cancelled' || o.dispatch_status === 'Completed' || o.dispatch_status === 'Shipped')
          .map(o => `${o.order_id}-${o.order_line_id}`)
      );

      // Filter out orders you have already finished processing so they don't reappear as "Pending"
      const ordersToActuallyUpsert = ordersToUpsert.filter(o => !finalizedOrders.has(`${o.order_id}-${o.order_line_id}`));

      if (ordersToActuallyUpsert.length > 0) {
        const { error: upsertError } = await client
          .from('orders')
          .upsert(ordersToActuallyUpsert, { onConflict: 'platform,order_id,order_line_id' });

        if (upsertError) {
          throw new Error('Supabase upsert failed: ' + upsertError.message);
        }
        recordsImported = ordersToActuallyUpsert.length;
      }
    }

    // 5. Update Sync Log with Success
    if (logId) {
      await client.from('sync_logs').update({
        status: 'Completed',
        records_imported: recordsImported,
        finished_at: new Date().toISOString()
      }).eq('id', logId);
    }

    return { 
      statusCode: 200, 
      body: JSON.stringify({ message: 'Success', orders: recordsImported }) 
    };

  } catch (err) {
    // Log any errors that occurred
    if (logId) {
      await client.from('sync_logs').update({
        status: 'Failed',
        error: err.message,
        finished_at: new Date().toISOString()
      }).eq('id', logId);
    }

    return { 
      statusCode: 500, 
      body: JSON.stringify({ error: err.message }) 
    };
  }
};
