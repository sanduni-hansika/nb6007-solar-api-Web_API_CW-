'use strict';
// Central configuration. Everything comes from environment variables (12-factor style),
// so the same code runs on a laptop and in the cloud.
require('dotenv').config();
const crypto = require('crypto');
const env = process.env;

const isProd = env.NODE_ENV === 'production';
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

let jwtSecret = env.JWT_SECRET;
if (!jwtSecret) {
  if (isProd) throw new Error('JWT_SECRET must be set in production.');
  jwtSecret = 'dev-only-secret-do-not-use-in-production-0123456789';
  console.warn('[config] JWT_SECRET not set - using an insecure development default.');
}
if (isProd && jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters in production.');

let seedPassword = env.SEED_PASSWORD;
if (!seedPassword) {
  seedPassword = isProd ? crypto.randomBytes(9).toString('base64url') + 'A1!' : 'Solar@2026!Demo';
  if (isProd) console.warn('[config] SEED_PASSWORD not set - generated one (only used if seeding happens now): ' + seedPassword);
}

module.exports = {
  isProd,
  isTest: env.NODE_ENV === 'test',
  port: parseInt(env.PORT || '3000', 10),
  databaseUrl: env.DATABASE_URL || 'postgres://solar:solar@localhost:5432/solar',
  databaseSsl: env.DATABASE_SSL, // 'true' | 'false' | undefined (auto)
  jwt: {
    secret: jwtSecret,
    issuer: 'slsea-solar-api',
    audience: 'slsea-solar-api',
    userTtlSeconds: parseInt(env.USER_TOKEN_TTL || '3600', 10),
    deviceTtlSeconds: parseInt(env.DEVICE_TOKEN_TTL || '43200', 10),
  },
  deviceSecretKey: env.DEVICE_SECRET_KEY || jwtSecret + '|device-secrets',
  seedPassword,
  autoSeed: bool(env.AUTO_SEED, true),
  simulator: bool(env.SIMULATOR, true),
  retentionDays: parseInt(env.RETENTION_DAYS || '14', 10),
  publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
  hideOutOfScope: bool(env.HIDE_OUT_OF_SCOPE, false),
  corsOrigins: (env.CORS_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),
  rateLimitPerMinute: parseInt(env.RATE_LIMIT_PER_MINUTE || '300', 10),
  trustProxy: parseInt(env.TRUST_PROXY || (isProd ? '1' : '0'), 10),
  enforceHttps: bool(env.ENFORCE_HTTPS, isProd),
  slotMinutes: 15, // device reporting interval
  staleAfterMinutes: 30, // a site is "live" if its last reading is newer than this
  tzOffsetMinutes: 330, // Asia/Colombo = UTC+05:30 (no DST) - used for "today"
};
