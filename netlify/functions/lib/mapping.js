'use strict';

const { redact } = require('./redact');
const { guessItem } = require('./catalogue');

const PLATFORM = 'flipkart';
const PRE_DISPATCH_STATES = ['APPROVED', 'PACKING_IN_PROGRESS', 'PACKED', 'FORM_FAILED', 'READY_TO_DISPATCH'];

const clean = (s) => (s == null ? null : String(s).trim() || null);
const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/** Flipkart sometimes sends times without a zone; those are Indian time. */
function withZone(value) {
  if (!value) return null;
  const s = String(value);
  return /(Z|[+-]\d\d:?\d\d)$/.test(s) ? s : s + '+05:30';
}

/** Our own simple stage, from Flipkart's item status. */
function stageOf(item) {
  const status = String(item.status || '').toUpperCase();
  if (status === 'CANCELLED') return item.courierReturn ? 'rto' : 'cancelled';
  if (PRE_DISPATCH_STATES.includes(status)) return 'to_dispatch';
  if (status === 'SHIPPED' || status === 'PICKUP_COMPLETE') return 'in_transit';
  if (status === 'DELIVERED') return 'delivered';
  if (status === 'RETURN_REQUESTED' || status === 'RETURNED') return 'returned';
  return 'other';
}

/** One shipment can hold several items. Returns { lines, listings } ready for the database. */
function mapShipment(shipment, { cancelType } = {}) {
  const lines = [];
  const listings = [];
  const pkg = shipment.subShipments && shipment.subShipments[0] && shipment.subShipments[0].packages && shipment.subShipments[0].packages[0];
  for (const item of shipment.orderItems || []) {
    if (!item.orderItemId) continue;
    const stage = stageOf(item);
    const price = item.priceComponents || {};
    const sku = clean(item.sku);
    lines.push({
      platform: PLATFORM,
      order_item_id: String(item.orderItemId),
      order_id: clean(item.orderId),
      shipment_id: clean(shipment.shipmentId),
      listing_id: clean(item.listingId),
      sku_text: sku,
      fsn: clean(item.fsn),
      quantity: Number(item.quantity) || 1,
      order_date: withZone(item.orderDate),
      platform_status: clean(item.status),
      stage,
      payment_type: clean(item.paymentType) && String(item.paymentType).toUpperCase(),
      selling_price: num(price.sellingPrice),
      total_price: num(price.totalPrice),
      dispatch_by: withZone(shipment.dispatchByDate),
      platform_updated_at: withZone(shipment.updatedAt),
      // Flipkart has no separate "delivered on" field; for a delivered order its last-updated time is the delivery time.
      delivered_at: stage === 'delivered' ? withZone(shipment.updatedAt) : null,
      cancelled_at: withZone(item.cancellationDate),
      cancel_type: item.status === 'CANCELLED' ? (cancelType || null) : null,
      cancel_reason: clean(item.cancellationReason),
      cancel_sub_reason: clean(item.cancellationSubReason),
      courier_return: Boolean(item.courierReturn),
      raw: redact({
        shipmentId: shipment.shipmentId, dispatchByDate: shipment.dispatchByDate, dispatchAfterDate: shipment.dispatchAfterDate,
        updatedAt: shipment.updatedAt, locationId: shipment.locationId, hold: shipment.hold, shipmentType: shipment.shipmentType,
        logistics_partner: shipment.logistics_partner, packageSku: pkg && pkg.packageSku, item
      })
    });
    if (item.listingId) {
      const g = guessItem({ sku, title: item.title });
      listings.push({
        platform: PLATFORM, listing_id: String(item.listingId), sku_text: sku, fsn: clean(item.fsn), title: clean(item.title),
        selling_price: num(price.sellingPrice),
        name: g.name, design: g.design, colour: g.colour, size: g.size, unit_cost: g.unit_cost
      });
    }
  }
  return { lines, listings };
}

function mapShipments(shipments, opts) {
  const lines = new Map();
  const listings = new Map();
  for (const s of shipments || []) {
    const m = mapShipment(s, opts);
    m.lines.forEach((l) => lines.set(l.order_item_id, l));
    m.listings.forEach((l) => { if (!listings.has(l.listing_id)) listings.set(l.listing_id, l); });
  }
  return { lines: [...lines.values()], listings: [...listings.values()] };
}

function mapReturnItem(r, source) {
  if (!r || !r.returnId || !r.orderItemId) return null;
  return {
    platform: PLATFORM,
    return_id: String(r.returnId),
    order_item_id: String(r.orderItemId),
    order_id: clean(r.orderId),
    quantity: Number(r.quantity) || 1,
    return_type: clean(r.type) || source,
    status: clean(r.status),
    reason: clean(r.reason),
    sub_reason: clean(r.subReason),
    created_on: withZone(r.createdDate),
    updated_on: withZone(r.updatedDate),
    approved_on: withZone(r.approvedOn),
    expected_on: withZone(r.expectedDate),
    tracking_id: clean(r.trackingId),
    courier_name: clean(r.courierName),
    raw: redact(r)
  };
}

function mapReturns(items, source) {
  const out = new Map();
  for (const r of items || []) {
    const row = mapReturnItem(r, source);
    if (row) out.set(`${row.return_id}|${row.order_item_id}`, row);
  }
  return [...out.values()];
}

module.exports = { PLATFORM, PRE_DISPATCH_STATES, stageOf, mapShipment, mapShipments, mapReturnItem, mapReturns, withZone };
