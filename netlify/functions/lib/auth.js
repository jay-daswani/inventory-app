'use strict';

const crypto = require('crypto');

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

/** True when the request carries the right app password (header x-app-password). */
function isAuthorised(headers, env) {
  const expected = env.APP_PASSWORD;
  if (!expected || String(expected).length < 8) return false;
  const given = (headers && (headers['x-app-password'] || headers['X-App-Password'])) || '';
  return crypto.timingSafeEqual(digest(given), digest(expected));
}

module.exports = { isAuthorised };
