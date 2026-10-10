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
  return 'W/"' + crypto.createHash('sha1').update(json).digest('base64url').slice(0, 27) + '"';
}

/** RFC 7232 conditional evaluation: If-None-Match wins; otherwise If-Modified-Since (independent of Cache-Control). */
function notModified(req, etag, lastModified) {
  const weak = (t) => t.trim().replace(/^W\//, '');
  const inm = req.get('if-none-match');
  if (inm) return inm.trim() === '*' || inm.split(',').some((t) => weak(t) === weak(etag));
  const ims = req.get('if-modified-since');
  if (ims && lastModified) {
    const since = Date.parse(ims);
    return !Number.isNaN(since) && Math.floor(new Date(lastModified).getTime() / 1000) * 1000 <= since;
  }
  return false;
}

/**
 * Send a JSON representation with validators (ETag + Last-Modified) and answer
 * conditional GET: If-None-Match / If-Modified-Since => 304 with an EMPTY body.
 */
function sendJson(req, res, body, { status = 200, lastModified, headers = {} } = {}) {
  const json = JSON.stringify(body);
  res.status(status);
  res.set(headers);
  res.set('ETag', etagOf(json));
  if (lastModified) res.set('Last-Modified', new Date(lastModified).toUTCString());
  res.set('Cache-Control', 'private, no-cache'); // may be stored, but must be revalidated (conditional GET)
  res.set('Vary', 'Accept, Authorization');
  if ((req.method === 'GET' || req.method === 'HEAD') && status === 200 && notModified(req, res.get('ETag'), lastModified)) {
    return res.status(304).end();
  }
  return res.type('application/json').send(json);
}

/** 201 Created: body + Location header (+ ETag so the client can use If-Match straight away). */
function sendCreated(req, res, body, locationPath, extra = {}) {
  res.set('Location', absUrl(req, locationPath));
  res.set('ETag', etagOf(body));
  res.set('Cache-Control', 'no-store');
  return res.status(201).type('application/json').send(JSON.stringify({ ...body, ...extra }));
}

/** If-Match => optimistic concurrency. Mismatch => 412 Precondition Failed. */
function checkIfMatch(req, currentBody) {
  const header = req.get('if-match');
  if (!header || header.trim() === '*') return;
  const strip = (s) => s.trim().replace(/^W\//, '');
  const wanted = header.split(',').map(strip);
  if (!wanted.includes(strip(etagOf(currentBody)))) {
    throw new ApiError(412, 'PRECONDITION_FAILED', 'The resource has changed since you last retrieved it (If-Match did not match). GET it again and retry.', [{ current_etag: etagOf(currentBody) }]);
  }
}

function parsePaging(req) {
  const page = qInt(req, 'page', { min: 1, max: 1000000, def: 1 });
  const pageSize = qInt(req, 'page_size', { min: 1, max: 500, def: 50 });
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function pageLinks(req, { page, pageSize, total }) {
  const totalPages = Math.ceil(total / pageSize);
  const path = req.originalUrl.split('?')[0];
  const mk = (p) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query)) if (k !== 'page' && k !== 'page_size' && typeof v === 'string') q.append(k, v);
    q.set('page', String(p));
    q.set('page_size', String(pageSize));
    return origin(req) + path + '?' + q.toString();
  };
  return {
    totalPages,
    links: {
      self: mk(page),
      first: mk(1),
      prev: page > 1 && totalPages > 0 ? mk(Math.min(page - 1, totalPages)) : null,
      next: page < totalPages ? mk(page + 1) : null,
      last: mk(Math.max(totalPages, 1)),
    },
  };
}

/** Paginated collection envelope: data + total count + next/previous links (also as a Link header). */
function sendPaged(req, res, items, paging, lastModified) {
  const { totalPages, links } = pageLinks(req, paging);
  const headers = { 'X-Total-Count': String(paging.total) };
  const linkHeader = Object.entries(links).filter(([, v]) => v).map(([rel, url]) => `<${url}>; rel="${rel}"`).join(', ');
  headers.Link = linkHeader;
  return sendJson(req, res, {
    data: items,
    pagination: { page: paging.page, page_size: paging.pageSize, total_count: paging.total, total_pages: totalPages },
    links,
  }, { lastModified, headers });
}

module.exports = { origin, absUrl, etagOf, sendJson, sendCreated, checkIfMatch, parsePaging, sendPaged };
