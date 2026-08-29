{\rtf1\ansi\ansicpg1252\cocoartf2868
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