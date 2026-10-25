'use strict';

/**
 * Personal details of buyers are never stored. Any field whose NAME looks personal is replaced by "[removed]".
 * (Names, addresses, phone numbers, e-mails, pincodes, cities, landmarks. States are kept for regional analysis.)
 */
const PERSONAL = /(first|last|buyer|customer|seller|recipient|consignee)_?name|^name$|address|landmark|phone|mobile|contact|e_?mail|pin_?code|zip|^city$|comment/i;

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = PERSONAL.test(k) ? '[removed]' : redact(v);
    return out;
  }
  return value;
}

module.exports = { redact, PERSONAL };
