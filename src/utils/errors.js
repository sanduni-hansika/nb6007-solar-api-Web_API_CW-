'use strict';
// One consistent error contract for the WHOLE API:
// { "error": { code, message, status, details[], path, timestamp, request_id } }
class ApiError extends Error {
  constructor(status, code, message, details = [], headers) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

const bad = (code, message, details) => new ApiError(400, code, message, details);

function translate(err) {
  if (err instanceof ApiError) return err;
  if (err.type === 'entity.parse.failed') return bad('INVALID_JSON', 'The request body is not valid JSON.', [{ issue: err.message.slice(0, 200) }]);
  if (err.type === 'entity.too.large') return new ApiError(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.');
  if (err.type === 'charset.unsupported' || err.type === 'encoding.unsupported') return new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported charset/encoding.');
  switch (err.code) {
    case '23505': return new ApiError(409, 'DUPLICATE_RESOURCE', 'A resource with the same unique value already exists.', [{ constraint: err.constraint }]);
    case '23503': return new ApiError(409, 'REFERENCE_CONFLICT', 'The operation conflicts with related resources (a referenced parent is missing or children still exist).', [{ constraint: err.constraint }]);
    case '23514': return bad('VALIDATION_FAILED', 'A value violates a data constraint.', [{ constraint: err.constraint }]);
    case '22P02': case '22003': case '22007': case '22008': return bad('INVALID_VALUE', 'A value has an invalid format or is out of range.');
    default: break;
  }
  if (err.status && err.status >= 400 && err.status < 500) return new ApiError(err.status, 'BAD_REQUEST', err.message || 'Bad request.');
  return new ApiError(500, 'INTERNAL_ERROR', 'An unexpected error occurred. Please quote the request_id when reporting it.');
}

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const e = translate(err);
  if (e.status >= 500) console.error(`[error] ${req.id} ${req.method} ${req.originalUrl}`, err);
  if (res.headersSent) return next(err);
  if (e.headers) res.set(e.headers);
  res.status(e.status).json({
    error: {
      code: e.code,
      message: e.message,
      status: e.status,
      details: e.details || [],
      path: req.originalUrl.split('?')[0],
      timestamp: new Date().toISOString(),
      request_id: req.id,
    },
  });
}

const notFoundHandler = (req, res, next) =>
  next(new ApiError(404, 'ROUTE_NOT_FOUND', `No resource at ${req.method} ${req.originalUrl.split('?')[0]}.`));

// async wrapper so rejected promises reach the error handler (Express 4)
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// 405 helper: used as the last handler of every route
const allow = (...methods) => (req, res) => {
  const list = [...new Set([...methods, ...(methods.includes('GET') ? ['HEAD'] : []), 'OPTIONS'])];
  res.set('Allow', list.join(', '));
  if (req.method === 'OPTIONS') return res.status(204).end();
  throw new ApiError(405, 'METHOD_NOT_ALLOWED', `${req.method} is not supported on this resource.`, [{ allowed: list }]);
};

module.exports = { ApiError, bad, errorHandler, notFoundHandler, ah, allow };
