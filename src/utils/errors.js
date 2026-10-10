
'use strict';

class ApiError extends Error {
  constructor(status, code, message, details = [], headers) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
    Error.captureStackTrace?.(this, ApiError);
  }
}

function bad(code, message, details = []) {
  return new ApiError(400, code, message, details);
}

function translate(err) {
  if (err instanceof ApiError) return err;

  if (err && err.type === 'entity.parse.failed') {
    return bad('INVALID_JSON', 'The request body is not valid JSON.', [
      { issue: String(err.message || 'Invalid JSON').slice(0, 200) },
    ]);
  }

  if (err && err.type === 'entity.too.large') {
    return new ApiError(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.');
  }

  if (
    err &&
    (err.type === 'charset.unsupported' ||
      err.type === 'encoding.unsupported')
  ) {
    return new ApiError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Unsupported charset or content encoding.'
    );
  }

  switch (err && err.code) {
    case '23505':
      return new ApiError(
        409,
        'DUPLICATE_RESOURCE',
        'A resource with the same unique value already exists.',
        err.constraint ? [{ constraint: err.constraint }] : []
      );

    case '23503':
      return new ApiError(
        409,
        'REFERENCE_CONFLICT',
        'The operation conflicts with related resources.',
        err.constraint ? [{ constraint: err.constraint }] : []
      );

    case '23514':
      return bad(
        'VALIDATION_FAILED',
        'A value violates a database constraint.',
        err.constraint ? [{ constraint: err.constraint }] : []
      );

    case '22P02':
    case '22003':
    case '22007':
    case '22008':
      return bad(
        'INVALID_VALUE',
        'A value has an invalid format or is out of range.'
      );

    default:
      break;
  }

  if (
    err &&
    Number.isInteger(err.status) &&
    err.status >= 400 &&
    err.status < 500
  ) {
    return new ApiError(
      err.status,
      'BAD_REQUEST',
      err.message || 'The request could not be processed.'
    );
  }

  return new ApiError(
    500,
    'INTERNAL_ERROR',
    'An unexpected error occurred. Please quote the request_id when reporting it.'
  );
}

function errorHandler(err, req, res, next) {
  const error = translate(err);

 
  if (error.status >= 500) {
    console.error(
      '[error] ' +
        (req.id || 'no-request-id') +
        ' ' +
        req.method +
        ' ' +
        req.originalUrl,
      err
    );
    console.error('[DEBUG ERROR MESSAGE]', err.message);
    console.error('[DEBUG ERROR STACK]', err.stack);
  }

  if (res.headersSent) {
    return next(err);
  }

  if (error.headers) {
    res.set(error.headers);
  }

  return res.status(error.status).json({
    error: {
      code: error.code,
      message: error.message,
      status: error.status,
      details: error.details || [],
      path: req.originalUrl.split('?')[0],
      timestamp: new Date().toISOString(),
      request_id: req.id || null,
    },
  });
}

function notFoundHandler(req, res, next) {
  return next(
    new ApiError(
      404,
      'ROUTE_NOT_FOUND',
      'No resource at ' +
        req.method +
        ' ' +
        req.originalUrl.split('?')[0] +
        '.'
    )
  );
}

function ah(fn) {
  return function asyncHandler(req, res, next) {
    return Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function allow(...methods) {
  return function methodHandler(req, res, next) {
    const allowedMethods = [
      ...new Set([
        ...methods,
        ...(methods.includes('GET') ? ['HEAD'] : []),
        'OPTIONS',
      ]),
    ];

    res.set('Allow', allowedMethods.join(', '));

    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }

    return next(
      new ApiError(
        405,
        'METHOD_NOT_ALLOWED',
        req.method + ' is not supported on this resource.',
        [{ allowed: allowedMethods }]
      )
    );
  };
}

module.exports = {
  ApiError,
  bad,
  errorHandler,
  notFoundHandler,
  ah,
  allow,
};