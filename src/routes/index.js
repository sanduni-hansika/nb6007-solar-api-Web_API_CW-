'use strict';
const express = require('express');
const { ApiError } = require('../utils/errors');
const { authenticate } = require('../middleware/auth');

const v1 = express.Router();

// 406: this API only produces JSON
v1.use((req, res, next) => {
  if (!req.accepts('json')) return next(new ApiError(406, 'NOT_ACCEPTABLE', 'This API only produces application/json.', [{ supported: ['application/json'] }]));
  next();
});
// 415: bodies must be JSON
v1.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const hasBody = (req.headers['content-length'] && req.headers['content-length'] !== '0') || req.headers['transfer-encoding'];
    if (hasBody && !req.is(['application/json', 'application/merge-patch+json'])) {
      return next(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the body as application/json.', [{ supported: ['application/json', 'application/merge-patch+json'] }]));
    }
  }
  next();
});
v1.use(express.json({ limit: '100kb', type: ['application/json', 'application/merge-patch+json'] }));

v1.use('/tokens', require('./tokens')); // public: this is where you log in
v1.use(authenticate); // everything below requires a valid bearer token
v1.use(require('./hierarchy'));
v1.use(require('./installations'));
v1.use(require('./readings'));
v1.use(require('./summaries'));
v1.use(require('./users'));

module.exports = v1;
