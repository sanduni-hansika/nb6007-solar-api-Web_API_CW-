
'use strict';

const crypto = require('crypto');
const config = require('../config');
const { ApiError } = require('./errors');
const { qInt } = require('./validate');

function origin(req) {
  return config.publicUrl || `${req.protocol}://${req.get('host')}`;
}

const absUrl = (req, path) => origin(req) + path;

function etagOf(body) {
  const json = typeof body === 'string' ? body : JSON.stringify(body);

  return (
    'W/"' +
    crypto
      .createHash('sha1')
      .update(json)
      .digest('base64url')
      .slice(0, 27) +
    '"'
  );
}

/**
 * RFC 7232 conditional evaluation:
 * If-None-Match takes precedence over If-Modified-Since.
 */
function notModified(req, etag, lastModified) {
  const weak = (value) => value.trim().replace(/^W\//, '');
  const inm = req.get('if-none-match');

  if (inm) {
    return (
      inm.trim() === '*' ||
      inm.split(',').some((value) => weak(value) === weak(etag))
    );
  }

  const ims = req.get('if-modified-since');

  if (ims && lastModified) {
    const since = Date.parse(ims);

    return (
      !Number.isNaN(since) &&
      Math.floor(new Date(lastModified).getTime() / 1000) * 1000 <= since
    );
  }

  return false;
}

/**
 * Send JSON with cache validators and support conditional GET.
 */
function sendJson(
  req,
  res,
  body,
  { status = 200, lastModified, headers = {} } = {}
) {
  const json = JSON.stringify(body);

  res.status(status);
  res.set(headers);
  res.set('ETag', etagOf(json));

  if (lastModified) {
    res.set('Last-Modified', new Date(lastModified).toUTCString());
  }

  res.set('Cache-Control', 'private, no-cache');
  res.set('Vary', 'Accept, Authorization');

  if (
    (req.method === 'GET' || req.method === 'HEAD') &&
    status === 200 &&
    notModified(req, res.get('ETag'), lastModified)
  ) {
    return res.status(304).end();
  }

  return res.type('application/json').send(json);
}

/**
 * Send a 201 Created response with a Location header.
 */
function sendCreated(req, res, body, locationPath, extra = {}) {
  res.set('Location', absUrl(req, locationPath));
  res.set('ETag', etagOf(body));
  res.set('Cache-Control', 'no-store');

  return res
    .status(201)
    .type('application/json')
    .send(JSON.stringify({ ...body, ...extra }));
}

/**
 * Enforce optimistic concurrency using If-Match.
 * Missing If-Match or '*' permits the operation.
 */
function checkIfMatch(req, currentBody) {
  const header = req.get('if-match');

  if (!header || header.trim() === '*') {
    return;
  }

  const strip = (value) => value.trim().replace(/^W\//, '');
  const wanted = header.split(',').map(strip);

  if (!wanted.includes(strip(etagOf(currentBody)))) {
    throw new ApiError(
      412,
      'PRECONDITION_FAILED',
      'The resource has changed since you last retrieved it (If-Match did not match). GET it again and retry.',
      [{ current_etag: etagOf(currentBody) }]
    );
  }
}

function parsePaging(req) {
  const page = qInt(req, 'page', {
    min: 1,
    max: 1000000,
    def: 1,
  });

  const pageSize = qInt(req, 'page_size', {
    min: 1,
    max: 500,
    def: 50,
  });

  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
  };
}

function pageLinks(req, { page, pageSize, total }) {
  const totalPages = Math.ceil(total / pageSize);
  const path = req.originalUrl.split('?')[0];

  const makeUrl = (pageNumber) => {
    const params = new URLSearchParams();

    for (const [key, value] of Object.entries(req.query)) {
      if (
        key !== 'page' &&
        key !== 'page_size' &&
        typeof value === 'string'
      ) {
        params.append(key, value);
      }
    }

    params.set('page', String(pageNumber));
    params.set('page_size', String(pageSize));

    return `${origin(req)}${path}?${params.toString()}`;
  };

  return {
    totalPages,
    links: {
      self: makeUrl(page),
      first: makeUrl(1),
      prev:
        page > 1 && totalPages > 0
          ? makeUrl(Math.min(page - 1, totalPages))
          : null,
      next: page < totalPages ? makeUrl(page + 1) : null,
      last: makeUrl(Math.max(totalPages, 1)),
    },
  };
}

/**
 * Send a paginated collection with counts and navigation links.
 */
function sendPaged(req, res, items, paging, lastModified) {
  const { totalPages, links } = pageLinks(req, paging);

  const headers = {
    'X-Total-Count': String(paging.total),
  };

  headers.Link = Object.entries(links)
    .filter(([, url]) => url)
    .map(([rel, url]) => `<${url}>; rel="${rel}"`)
    .join(', ');

  return sendJson(
    req,
    res,
    {
      data: items,
      pagination: {
        page: paging.page,
        page_size: paging.pageSize,
        total: paging.total,
        total_count: paging.total,
        total_pages: totalPages,
      },
      links,
    },
    { lastModified, headers }
  );
}

module.exports = {
  origin,
  absUrl,
  etagOf,
  sendJson,
  sendCreated,
  checkIfMatch,
  parsePaging,
  sendPaged,
};
