'use strict';

/**
 * Turns a Flipkart SKU text like "White Malai More (XL) " into a design, colour and size guess.
 * Used for the first catalogue and for every NEW listing that appears later. The guess is only a starting
 * point: everything can be corrected on the Catalogue screen.
 */

const SIZE_RE = /^(XXS|XS|S|M|L|XL|XXL|2XL|3XL|4XL|5XL|FREE|\d{2})$/i;

const COLOURS = {
  wht: 'White', white: 'White', offwhite: 'Off-white', 'off white': 'Off-white', black: 'Black', grey: 'Grey', gray: 'Grey',
  wine: 'Wine', pista: 'Pista Green', 'pista green': 'Pista Green', beige: 'Beige', cream: 'Cream', pink: 'Pink', rani: 'Rani Pink',
  red: 'Red', maroon: 'Maroon', orange: 'Orange', mustard: 'Mustard', multi: 'Multicolour', 'sky blue': 'Sky Blue',
  'black cream': 'Black & Cream', 'sky_blue': 'Sky Blue'
};

// Costs per piece that the owner has told us (rupees). Everything else stays empty until the owner fills it in.
const DESIGN_COSTS = {
  'Malai More': 500,
  'Ari Work JJ': 350,
  'Dhoti Rani': 290,
  'Dhoti Mirror Work': 290,
  'Polo Pant': 250,
  'Bell Bottom Pant': 250,
  'Flared Bottom Pant': 250
};

const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const colourName = (raw) => {
  const key = clean(raw).toLowerCase().replace(/_/g, ' ');
  if (!key) return null;
  if (COLOURS[key]) return COLOURS[key];
  return key.replace(/\b\w/g, (c) => c.toUpperCase());
};
const sizeName = (raw) => {
  const s = clean(raw).replace(/[()]/g, '').toUpperCase();
  if (!s || !SIZE_RE.test(s)) return null;
  return s === 'XXL' ? '2XL' : s;
};

/** Takes the last size-looking piece off the end ("...-XL", "... (L)", "..._M"). Returns [rest, size]. */
function splitSize(text) {
  let t = clean(text);
  let m = t.match(/^(.*?)\s*\(\s*([A-Za-z0-9]+)\s*\)$/);
  if (m && sizeName(m[2])) return [clean(m[1]), sizeName(m[2])];
  m = t.match(/^(.*?)[\s\-_]+\(?([A-Za-z0-9]+)\)?$/);
  if (m && sizeName(m[2])) return [clean(m[1]).replace(/[\-_\s]+$/, ''), sizeName(m[2])];
  return [t, null];
}

function guessItem({ sku, title } = {}) {
  const raw = clean(sku);
  const low = raw.toLowerCase();
  let design = null, colour = null, size = null, rest;

  // Fixed product families recognised from the SKU text (order matters: most specific first).
  const families = [
    [/malai-mm-kp-/i, 'Malai Kurta-Pant Set', /^malai-mm-kp-/i],
    [/^mm-kp-/i, 'MM Kurta (KP)', /^mm-kp-/i],
    [/malai\s*more|malaii\s*more/i, 'Malai More', /\s*malaii?\s*more(\s*kurta)?/i],
    [/ari\s*work/i, 'Ari Work JJ', /\s*ari\s*work(\s*jj)?(\s*kurta)?/i],
    [/^dhoti-mirror\s*work-/i, 'Dhoti Mirror Work', /^dhoti-mirror\s*work-/i],
    [/^dhoti-rani-/i, 'Dhoti Rani', /^dhoti-rani-/i],
    [/^dhoti-/i, 'Dhoti Rani', /^dhoti-/i],
    [/black\s*cream\s*bottom\s*pant/i, 'Flared Bottom Pant', /\s*bottom\s*pant/i],
    [/bell\s*bottom\s*pant/i, 'Bell Bottom Pant', /\s*bell\s*bottom\s*pant/i],
    [/^polo\s*pant/i, 'Polo Pant', /^polo\s*pant[\-\s]*/i],
    [/^de-kurta-/i, 'Printed Kurta (DE)', /^de-kurta-/i],
    [/^kurta-multi/i, 'Printed Kurta Multi', /^kurta-/i],
    [/^kurta-/i, 'Printed Kurta (DE)', /^kurta-/i],
    [/^geometric_kurta/i, 'Geometric Kurta', /^geometric_kurta[_\-\s]*/i],
    [/^arm_chair/i, 'Arm Chair Kurta', /^arm_chair[_\-\s]*/i]
  ];

  for (const [test, name, strip] of families) {
    if (!test.test(raw)) continue;
    design = name;
    const [body, sz] = splitSize(raw);
    size = sz;
    rest = body.replace(strip, ' ');
    if (name === 'Flared Bottom Pant') rest = body.replace(/\s*bottom\s*pant/i, '').trim() || 'Black Cream';
    colour = colourName(clean(rest).replace(/^[\-_\s]+|[\-_\s]+$/g, '').replace(/^(kp|mm)[\-\s]+/i, ''));
    if (name === 'Printed Kurta Multi') colour = 'Multicolour';
    if (name === 'Arm Chair Kurta' && !colour) colour = 'Sky Blue';
    if (name === 'Geometric Kurta') colour = colour || null;
    break;
  }

  if (!design) {
    const [body, sz] = splitSize(raw);
    size = sz;
    design = clean(String(title || body || raw)).slice(0, 60) || 'Unsorted';
  }

  // colour from the listing title, e.g. "... Straight Kurta (White)"
  if (!colour) {
    const m = String(title || '').match(/\(([A-Za-z ]+)\)\s*$/);
    if (m && m[1].trim()) colour = colourName(m[1].replace(/multicolor/i, 'Multicolour'));
  }

  // free-size dhoti
  if (!size && /dhoti/i.test(design)) size = 'FREE';
  if (colour === 'Rani Pink' && /dhoti-rani-pink/i.test(raw)) colour = 'Pink';

  const parts = [design, colour, size].filter(Boolean);
  return {
    design,
    colour,
    size,
    name: parts.join(' · '),
    unit_cost: DESIGN_COSTS[design] != null ? DESIGN_COSTS[design] : null
  };
}

module.exports = { guessItem, DESIGN_COSTS, sizeName, colourName };
