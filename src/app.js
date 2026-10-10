'use strict';
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const swaggerUi = require('swagger-ui-express');
const config = require('./config');
const db = require('./db');
const { ApiError, errorHandler, notFoundHandler } = require('./utils/errors');
const { buildOpenApi } = require('./docs/openapi');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false); // we generate our own validators (ETag / Last-Modified)
  app.set('query parser', 'simple');
  app.set('trust proxy', config.trustProxy);

  app.use((req, res, next) => {
    const inc = req.get('x-request-id');
    req.id = inc && /^[\w.-]{8,64}$/.test(inc) ? inc : crypto.randomUUID();
    res.set('X-Request-Id', req.id);
    next();
  });
  // HTTPS everywhere in production (the host's load balancer terminates TLS and sets X-Forwarded-Proto)
  if (config.enforceHttps) {
    app.use((req, res, next) => {
      if (req.secure || req.path === '/health') return next();
      if (req.method === 'GET' || req.method === 'HEAD') return res.redirect(308, `https://${req.get('host')}${req.originalUrl}`);
      return next(new ApiError(403, 'HTTPS_REQUIRED', 'This API must be accessed over HTTPS.'));
    });
  }
  if (!config.isTest) app.use(morgan(':method :url :status :res[content-length] - :response-time ms'));

  // Swagger UI (own helmet config: the UI needs inline styles/scripts)
  app.get('/docs', (req, res) => res.redirect('/api-docs'));
  app.use('/api-docs', helmet({ contentSecurityPolicy: false }), swaggerUi.serve,
    swaggerUi.setup(null, { swaggerUrl: '/openapi.json', customSiteTitle: 'SLSEA Solar Generation API', swaggerOptions: { persistAuthorization: true, displayRequestDuration: true } }));

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({
    origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposedHeaders: ['Location', 'ETag', 'Last-Modified', 'Link', 'X-Total-Count', 'X-Request-Id', 'Content-Location', 'Allow', 'Retry-After'],
    maxAge: 600,
  }));
  app.use(compression());
  app.use(rateLimit({
    windowMs: 60 * 1000, limit: config.rateLimitPerMinute, standardHeaders: 'draft-7', legacyHeaders: false,
    handler: (req, res, next) => next(new ApiError(429, 'RATE_LIMITED', 'Too many requests. Please slow down.')),
  }));

  app.get('/openapi.json', (req, res) => res.json(buildOpenApi(req)));
  app.get('/', (req, res) => res.json({
    name: 'SLSEA Real-Time Solar Generation Data API', version: '1.0.0',
    documentation: '/api-docs', openapi: '/openapi.json', base_path: '/api/v1', health: '/health',
  }));
  app.get('/health', async (req, res) => {
    try {
      const r = await db.query('SELECT (SELECT max(measured_at) FROM generation_readings) AS latest, (SELECT count(*)::int FROM solar_installations) AS installations');
      res.json({ status: 'ok', database: 'up', time: new Date().toISOString(), uptime_seconds: Math.round(process.uptime()), installations: r.rows[0].installations, latest_reading_at: r.rows[0].latest });
    } catch (e) {
      res.status(503).json({ status: 'degraded', database: 'down', time: new Date().toISOString() });
    }
  });

  app.use('/api/v1', require('./routes'));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
module.exports = { createApp };
