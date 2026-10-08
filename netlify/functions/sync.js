const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  
  const { data: logData } = await client.from('sync_logs').insert({
    platform: 'Flipkart',
    status: 'Started',
    started_at: new Date().toISOString()
  }).select('id').single();

  const logId = logData ? logData.id : null;

  try {
    // 1. Get Token
    const authRes = await fetch('https://api.flipkart.net/oauth-service/oauth/token?grant_type=client_credentials&scope=Seller_Api', {
      method: 'GET',
      headers: { 
        'Authorization': 'Basic ' + Buffer.from(process.env.FLIPKART_CONSUMER_ID + ':' + process.env.FLIPKART_CONSUMER_SECRET).toString('base64')
      }
    });
    
    if (!authRes.ok) throw new Error('Failed to get Flipkart token: ' + await authRes.text());
    
    const authData = await authRes.json();
    const token = authData.access_token;
    if (!token) throw new Error('No access token received from Flipkart');

    // 2. Fetch Orders
    // FIX: Removed trailing slash from the URL
    let url = 'https://api.flipkart.net/sellers/v3/shipments/filter';
    let method = 'POST';
    
    const body = JSON.stringify({
      filter: {
        type: "preDispatch",
        states: ["APPROVED", "PACKING_IN_PROGRESS", "PACKED", "READY_TO_DISPATCH"]
      },
      pagination: { pageSize: 20 }
    });

    let allShipments = [];
    let hasMore = true;
    let pageNum = 1;

    while (hasMore) {
      const options = {
        method: method,
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      };
      
      if (method === 'POST') {
        options.body = body;
      }

      console.log(`Fetching page ${pageNum} using ${method} ${url}`);
      
      const res = await fetch(url, options);
      const text = await res.text();
      
      await client.from('sync_debug').insert({
        source: `Flipkart-Sync-Page-${pageNum}`,
        request_info: `${method} ${url}`,
        response_status: res.status,
        response_body: text.substring(0, 4000)
      });

      if (!res.ok) {
        throw new Error(`Flipkart API error on page ${pageNum} (${method} ${url}): ${res.status} ${res.statusText} | ${text}`);
      }

      const data = JSON.parse(text);
      
      if (data.shipments) {
        allShipments.push(...data.shipments);
      }
      
      hasMore = data.hasMore === true;
      if (hasMore && data.nextPageUrl) {
        // Flipkart usually returns a full URL or a relative path
        if (data.nextPageUrl.startsWith('http')) {
          url = data.nextPageUrl;
        } else {
          url = 'https://api.flipkart.net' + data.nextPageUrl;
        }
        method = 'GET'; // Subsequent pages are fetched via GET
        pageNum++;
      } else {
        hasMore = false; // Stop if no nextPageUrl
      }
    }

    // 3. Process and Upsert to Supabase
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
