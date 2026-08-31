const { createClient } = require('@supabase/supabase-js');

exports.schedule = '*/2 * * * *';

// ============================================================
// SUPABASE CLIENT
// ============================================================
function getClient() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================
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
// FLIPKART API INTEGRATION
// ============================================================
async function getFlipkartToken() {
  const consumerId = process.env.FLIPKART_CONSUMER_ID;
  const consumerSecret = process.env.FLIPKART_CONSUMER_SECRET;

  if (!consumerId || !consumerSecret) {
    console.log('Flipkart credentials not configured, skipping');
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
        sort: {
          orderDate: 'desc'
        },
        paging: {
          pageSize: 100
        }
      })
    });

    if (!response.ok) {
      console.error('Flipkart orders fetch failed:', response.status);
      return [];
    }

    const data = await response.json();
    const orders = data.orderItems || data.orders || [];

    return orders.map(order => ({
      platform: 'Flipkart',
      order_id: order.orderId || order.order_id || '',
      order_line_id: order.orderItemId || order.order_item_id || order.orderId || '',
      order_date: order.orderDate || order.order_date || new Date().toISOString(),
      platform_sku_id: order.sellerSku || order.seller_sku || order.sku || '',
      product_name: order.productName || order.product_name || '',
      quantity: order.quantity || order.qty || 1,
      selling_price: order.sellingPrice || order.selling_price || order.price || null,
      region: order.shippingRegion || order.region || order.state || null,
      status: order.orderStatus || order.status || 'Pending',
      dispatch_status: order.fulfilmentType || order.dispatch_status || 'Pending',
      is_cancelled_pre_dispatch: ['CANCELLED', 'CUSTOMER_CANCELLED'].includes(
        (order.orderStatus || '').toUpperCase()
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
        sort: {
          returnCreationDate: 'desc'
        },
        paging: {
          pageSize: 100
        }
      })
    });

    if (!response.ok) {
      console.error('Flipkart returns fetch failed:', response.status);
      return [];
    }

    const data = await response.json();
    const returns = data.returnItems || data.returns || [];

    return returns.map(ret => ({
      platform: 'Flipkart',
      return_id: ret.returnId || ret.return_id || '',
      order_id: ret.orderId || ret.order_id || '',
      return_date: ret.returnCreationDate || ret.return_date || new Date().toISOString(),
      order_date: ret.orderDate || null,
      platform_sku_id: ret.sellerSku || ret.seller_sku || ret.sku || '',
      product_name: ret.productName || ret.product_name || '',
      quantity: ret.quantity || ret.qty || 1,
      region: ret.shippingRegion || ret.region || null,
      major_reason: ret.returnReason || ret.reason || ret.major_reason || null,
      minor_reason: ret.returnSubReason || ret.sub_reason || ret.minor_reason || null,
      status: ret.returnStatus || ret.status || 'Pending'
    }));
  } catch (err) {
    console.error('Flipkart returns error:', err.message);
    return [];
  }
}

// ============================================================
// AMAZON SP-API INTEGRATION
// ============================================================
async function fetchAmazonOrders() {
  const clientId = process.env.AMAZON_CLIENT_ID;
  const clientSecret = process.env.AMAZON_CLIENT_SECRET;
  const refreshToken = process.env.AMAZON_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    console.log('Amazon credentials not configured, skipping');
    return [];
  }

  try {
    // Step 1: Get access token from Login with Amazon
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
    const accessToken = tokenData.access_token;

    // Step 2: Fetch orders from the last 3 days
    const createdAfter = daysAgo(3);
    const region = process.env.AMAZON_MARKETPLACE_REGION || 'na';
    
    let endpoint = '';
    if (region === 'na') {
      endpoint = 'https://sellingpartnerapi-na.amazon.com';
    } else if (region === 'eu') {
      endpoint = 'https://sellingpartnerapi-eu.amazon.com';
    } else if (region === 'fe') {
      endpoint = 'https://sellingpartnerapi-fe.amazon.com';
    }

    // NOTE: Amazon SP-API requires AWS Signature V4 for request signing.
    // This is a simplified version. For production, use the amazon-sp-api package.
    // The amazon-sp-api package handles signing automatically.
    
    try {
      const AmazonSpApi = require('amazon-sp-api');
      
      const amazon = new AmazonSpApi({
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        region: region === 'na' ? 'us' : region
      });

      const orders = await amazon.getOrders({
        CreatedAfter: createdAfter,
        MarketplaceIds: [process.env.AMAZON_MARKETPLACE_ID || 'A21TJRUUN4KGV']
      });

      if (!orders || !orders.length) return [];

      const orderItems = [];
      for (const order of orders.slice(0, 20)) {
        try {
          const items = await amazon.getOrderItems(order.AmazonOrderId);
          for (const item of items) {
            orderItems.push({
              platform: 'Amazon',
              order_id: order.AmazonOrderId,
              order_line_id: item.OrderItemId || order.AmazonOrderId,
              order_date: order.PurchaseDate || order.CreatedAfter || new Date().toISOString(),
              platform_sku_id: item.SellerSKU || item.ASIN || '',
              product_name: item.Title || '',
              quantity: item.QuantityOrdered || 1,
              selling_price: item.ItemPrice ? item.ItemPrice.Amount : null,
              region: order.ShippingAddress ? order.ShippingAddress.StateOrRegion : null,
              status: order.OrderStatus || 'Pending',
              dispatch_status: order.FulfillmentChannel || 'Pending',
              is_cancelled_pre_dispatch: order.OrderStatus === 'Canceled',
              cancellation_date: order.EarliestDeliveryDate || null
            });
          }
        } catch (itemErr) {
          console.error('Error fetching items for order', order.AmazonOrderId, itemErr.message);
        }
      }

      return orderItems;
    } catch (apiErr) {
      console.error('Amazon SP-API error:', apiErr.message);
      return [];
    }

  } catch (err) {
    console.error('Amazon orders error:', err.message);
    return [];
  }
}

async function fetchAmazonReturns() {
  const clientId = process.env.AMAZON_CLIENT_ID;
  const clientSecret = process.env.AMAZON_CLIENT_SECRET;
  const refreshToken = process.env.AMAZON_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) return [];

  try {
    const region = process.env.AMAZON_MARKETPLACE_REGION || 'na';
    
    try {
      const AmazonSpApi = require('amazon-sp-api');
      
      const amazon = new AmazonSpApi({
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        region: region === 'na' ? 'us' : region
      });

      const fromDate = daysAgo(30);
      const returns = await amazon.getReturns({
        MarketplaceIds: [process.env.AMAZON_MARKETPLACE_ID || 'A21TJRUUN4KGV'],
        ReturnDateFrom: fromDate
      });

      if (!returns || !returns.length) return [];

      return returns.map(ret => ({
        platform: 'Amazon',
        return_id: ret.ReturnId || ret.return_id || '',
        order_id: ret.OrderId || ret.order_id || '',
        return_date: ret.ReturnDate || ret.return_date || new Date().toISOString(),
        order_date: ret.OrderDate || null,
        platform_sku_id: ret.SellerSku || ret.sku || '',
        product_name: ret.ProductName || ret.title || '',
        quantity: ret.Quantity || ret.quantity || 1,
        region: ret.Region || null,
        major_reason: ret.Reason || ret.reason || null,
        minor_reason: ret.ReasonDescription || ret.reason_description || null,
        status: ret.Status || ret.status || 'Pending'
      }));
    } catch (apiErr) {
      console.error('Amazon SP-API returns error:', apiErr.message);
      return [];
    }

  } catch (err) {
    console.error('Amazon returns error:', err.message);
    return [];
  }
}

// ============================================================
// MAIN SYNC HANDLER
// ============================================================
exports.handler = async (event) => {
  const started = new Date().toISOString();
  let importedOrders = 0;
  let importedReturns = 0;
  const errors = [];

  try {
    const client = getClient();

    // ---- FLIPKART ----
    try {
      const fkToken = await getFlipkartToken();
      
      if (fkToken) {
        const fkOrders = await fetchFlipkartOrders(fkToken);
        for (const order of fkOrders) {
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
          if (error) errors.push('Flipkart order ' + order.order_id + ': ' + error.message);
          else if (data && data.new) importedOrders++;
        }

        const fkReturns = await fetchFlipkartReturns(fkToken);
        for (const ret of fkReturns) {
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
          if (error) errors.push('Flipkart return ' + ret.return_id + ': ' + error.message);
          else if (data && data.new) importedReturns++;
        }
      }
    } catch (fkErr) {
      errors.push('Flipkart sync error: ' + fkErr.message);
    }

    // ---- AMAZON ----
    try {
      const amzOrders = await fetchAmazonOrders();
      for (const order of amzOrders) {
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
        if (error) errors.push('Amazon order ' + order.order_id + ': ' + error.message);
        else if (data && data.new) importedOrders++;
      }

      const amzReturns = await fetchAmazonReturns();
      for (const ret of amzReturns) {
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
        if (error) errors.push('Amazon return ' + ret.return_id + ': ' + error.message);
        else if (data && data.new) importedReturns++;
      }
    } catch (amzErr) {
      errors.push('Amazon sync error: ' + amzErr.message);
    }

    // ---- LOG THE RESULT ----
    const status = errors.length ? 'partial' : 'success';
    await client.from('sync_logs').insert({
      platform: 'All',
      status: status,
      records_imported: importedOrders + importedReturns,
      error: errors.length ? errors.slice(0, 10).join(' | ') : null,
      started_at: started,
      finished_at: new Date().toISOString()
    });

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
      const client = getClient();
      await client.from('sync_logs').insert({
        platform: 'All',
        status: 'error',
        records_imported: 0,
        error: err.message || String(err),
        started_at: started,
        finished_at: new Date().toISOString()
      });
    } catch (logErr) {
      console.error('Failed to log sync error:', logErr);
    }

    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message || String(err) })
    };
  }
};{\rtf1\ansi\ansicpg1252\cocoartf2868
\cocoatextscaling0\cocoaplatform0{\fonttbl\f0\fswiss\fcharset0 Helvetica;}
{\colortbl;\red255\green255\blue255;}
{\*\expandedcolortbl;;}
\paperw11900\paperh16840\margl1440\margr1440\vieww11520\viewh8400\viewkind0
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0

\f0\fs24 \cf0 const \{ createClient \} = require('@supabase/supabase-js');\
\
exports.schedule = '*/2 * * * *';\
\
function getClient() \{\
  const url = process.env.SUPABASE_URL;\
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;\
\
  if (!url || !serviceKey) \{\
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.');\
  \}\
\
  return createClient(url, serviceKey, \{\
    auth: \{\
      persistSession: false\
    \}\
  \});\
\}\
\
function toBool(value) \{\
  if (value === true || value === false) return value;\
  if (value === null || value === undefined) return false;\
\
  const s = String(value).trim().toLowerCase();\
  return ['true', '1', 'yes', 'y', 'cancelled', 'canceled'].includes(s);\
\}\
\
function parseDate(value) \{\
  if (!value) return new Date().toISOString();\
  const d = new Date(value);\
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();\
\}\
\
function mapOrder(o, defaultPlatform) \{\
  const platform = o.platform || defaultPlatform || 'Amazon';\
  const orderId = String(o.order_id || o.orderId || o.order_id_raw || '');\
  const orderLineId = String(o.order_line_id || o.order_item_id || o.orderItemId || o.order_line_id_raw || orderId);\
\
  let cancelled = o.is_cancelled_pre_dispatch ?? o.cancelled_pre_dispatch ?? o.pre_dispatch_cancellation ?? o.is_cancelled ?? null;\
\
  if (cancelled === null || cancelled === undefined) \{\
    const status = String(o.status || '').toLowerCase();\
    const dispatch = String(o.dispatch_status || '').toLowerCase();\
    cancelled = status.includes('cancel') && !dispatch.includes('ship') && !dispatch.includes('dispatch');\
  \} else \{\
    cancelled = toBool(cancelled);\
  \}\
\
  return \{\
    p_platform: platform,\
    p_order_id: orderId,\
    p_order_line_id: orderLineId,\
    p_order_date: parseDate(o.order_date || o.orderDate || o.purchase_date),\
    p_platform_sku_id: String(o.platform_sku_id || o.sku || o.seller_sku || ''),\
    p_product_name: o.product_name || o.productName || o.title || null,\
    p_quantity: Number(o.quantity || o.Quantity || 1) || 1,\
    p_selling_price: o.selling_price || o.price || o.sellingPrice || null,\
    p_region: o.region || o.state || o.customer_region || null,\
    p_status: o.status || 'Pending',\
    p_dispatch_status: o.dispatch_status || o.dispatchStatus || 'Pending',\
    p_is_cancelled_pre_dispatch: cancelled,\
    p_cancellation_date: o.cancellation_date ? parseDate(o.cancellation_date) : null\
  \};\
\}\
\
function mapReturn(r, defaultPlatform) \{\
  return \{\
    p_platform: r.platform || defaultPlatform || 'Amazon',\
    p_return_id: String(r.return_id || r.returnId || ''),\
    p_order_id: String(r.order_id || r.orderId || ''),\
    p_return_date: parseDate(r.return_date || r.returnDate || r.created_date),\
    p_order_date: r.order_date ? parseDate(r.order_date) : null,\
    p_platform_sku_id: String(r.platform_sku_id || r.sku || r.seller_sku || ''),\
    p_product_name: r.product_name || r.productName || r.title || null,\
    p_quantity: Number(r.quantity || r.Quantity || 1) || 1,\
    p_region: r.region || r.state || r.customer_region || null,\
    p_major_reason: r.major_reason || r.majorReason || r.reason || null,\
    p_minor_reason: r.minor_reason || r.minorReason || r.detailed_reason || null,\
    p_status: r.status || 'Pending'\
  \};\
\}\
\
async function fetchJsonOrEmpty(url) \{\
  if (!url) return [];\
\
  const controller = new AbortController();\
  const timeout = setTimeout(() => controller.abort(), 20000);\
\
  try \{\
    const res = await fetch(url, \{ signal: controller.signal \});\
\
    if (res.status === 404) \{\
      return [];\
    \}\
\
    if (!res.ok) \{\
      throw new Error(`HTTP $\{res.status\} while fetching $\{url\}`);\
    \}\
\
    return await res.json();\
  \} finally \{\
    clearTimeout(timeout);\
  \}\
\}\
\
function extractArray(payload, key) \{\
  if (!payload) return [];\
  if (Array.isArray(payload)) return payload;\
  if (Array.isArray(payload[key])) return payload[key];\
  if (Array.isArray(payload.data)) return payload.data;\
  return [];\
\}\
\
exports.handler = async (event) => \{\
  const started = new Date().toISOString();\
  const manual = event?.queryStringParameters?.manual === '1';\
\
  let importedOrders = 0;\
  let importedReturns = 0;\
  const errors = [];\
\
  try \{\
    const client = getClient();\
    const baseUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || '';\
\
    const sources = [\
      \{\
        platform: 'Amazon',\
        ordersUrl: process.env.AMAZON_ORDERS_JSON_URL || (baseUrl ? `$\{baseUrl\}/data/amazon-orders.json` : null),\
        returnsUrl: process.env.AMAZON_RETURNS_JSON_URL || (baseUrl ? `$\{baseUrl\}/data/amazon-returns.json` : null)\
      \},\
      \{\
        platform: 'Flipkart',\
        ordersUrl: process.env.FLIPKART_ORDERS_JSON_URL || (baseUrl ? `$\{baseUrl\}/data/flipkart-orders.json` : null),\
        returnsUrl: process.env.FLIPKART_RETURNS_JSON_URL || (baseUrl ? `$\{baseUrl\}/data/flipkart-returns.json` : null)\
      \}\
    ];\
\
    for (const source of sources) \{\
      try \{\
        const ordersPayload = await fetchJsonOrEmpty(source.ordersUrl);\
        const orders = extractArray(ordersPayload, 'orders');\
\
        for (const order of orders) \{\
          const mapped = mapOrder(order, source.platform);\
          const \{ data, error \} = await client.rpc('import_order', mapped);\
\
          if (error) \{\
            errors.push(`$\{source.platform\} order $\{mapped.p_order_id\}: $\{error.message\}`);\
          \} else if (data && data.new) \{\
            importedOrders += 1;\
          \}\
        \}\
      \} catch (err) \{\
        errors.push(`$\{source.platform\} orders: $\{err.message\}`);\
      \}\
\
      try \{\
        const returnsPayload = await fetchJsonOrEmpty(source.returnsUrl);\
        const returns = extractArray(returnsPayload, 'returns');\
\
        for (const ret of returns) \{\
          const mapped = mapReturn(ret, source.platform);\
          const \{ data, error \} = await client.rpc('import_return', mapped);\
\
          if (error) \{\
            errors.push(`$\{source.platform\} return $\{mapped.p_return_id\}: $\{error.message\}`);\
          \} else if (data && data.new) \{\
            importedReturns += 1;\
          \}\
        \}\
      \} catch (err) \{\
        errors.push(`$\{source.platform\} returns: $\{err.message\}`);\
      \}\
    \}\
\
    const status = errors.length ? 'partial' : 'success';\
\
    await client.from('sync_logs').insert(\{\
      platform: 'All',\
      status,\
      records_imported: importedOrders + importedReturns,\
      error: errors.length ? errors.slice(0, 20).join(' | ') : null,\
      started_at: started,\
      finished_at: new Date().toISOString()\
    \});\
\
    return \{\
      statusCode: errors.length ? 207 : 200,\
      headers: \{ 'Content-Type': 'application/json' \},\
      body: JSON.stringify(\{\
        manual,\
        importedOrders,\
        importedReturns,\
        errors: errors.slice(0, 20)\
      \})\
    \};\
  \} catch (err) \{\
    try \{\
      const client = getClient();\
      await client.from('sync_logs').insert(\{\
        platform: 'All',\
        status: 'error',\
        records_imported: 0,\
        error: err.message || String(err),\
        started_at: started,\
        finished_at: new Date().toISOString()\
      \});\
    \} catch (logError) \{\
      console.error('Failed to write sync error log', logError);\
    \}\
\
    return \{\
      statusCode: 500,\
      headers: \{ 'Content-Type': 'application/json' \},\
      body: JSON.stringify(\{\
        error: err.message || String(err)\
      \})\
    \};\
  \}\
\};}
