'use strict';

// Old address kept only so nothing breaks; downloads now run from the Sync screen of the app.
exports.handler = async () => ({
  statusCode: 410,
  headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  body: 'This address is no longer used. Open the app and use the Sync screen.'
});
