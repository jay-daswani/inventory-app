'use strict';

const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'FLIPKART_CONSUMER_ID', 'FLIPKART_CONSUMER_SECRET', 'APP_PASSWORD'];

function missingEnv(env) {
  const missing = REQUIRED_ENV.filter((n) => !env[n]);
  if (env.APP_PASSWORD && String(env.APP_PASSWORD).length < 8) missing.push('APP_PASSWORD (must be at least 8 characters)');
  return missing;
}

module.exports = { REQUIRED_ENV, missingEnv };
