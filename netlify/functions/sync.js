const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    // 1. Get Token
    const authRes = await fetch('https://api.flipkart.net/oauth-service/oauth/token?grant_type=client_credentials', {
      method: 'GET',
      headers: { 'Authorization': 'Basic ' + Buffer.from(process.env.FLIPKART_CONSUMER_ID + ':' + process.env.FLIPKART_CONSUMER_SECRET).toString('base64') }
    });
    const authData = await authRes.json();
    const token = authData.access_token;

    // 2. Ask Flipkart for preDispatch orders using the exact array format from their docs
    const today = new Date();
    const past = new Date(); past.setDate(today.getDate() - 15);
    
    const body = {
      filter: {
        type: "preDispatch",
        states: ["APPROVED", "PACKING_IN_PROGRESS", "PACKED", "READY_TO_DISPATCH"],
        orderDate: {
          from: past.toISOString().split('T')[0],
          to: today.toISOString().split('T')[0]
        }
      },
      pagination: { pageSize: 20 }
    };

    const orderRes = await fetch('https://api.flipkart.net/sellers/v3/shipments/filter/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify(body)
    });

    const text = await orderRes.text();

    // 3. Save the EXACT response to your database so we can read it
    await client.from('sync_debug').insert({
      source: 'DIAGNOSTIC-TEST',
      request_info: JSON.stringify(body),
      response_status: orderRes.status,
      response_body: text.substring(0, 4000)
    });

    return { statusCode: 200, body: 'Test complete. Check sync_debug table.' };

  } catch (err) {
    return { statusCode: 500, body: 'Error: ' + err.message };
  }
};
