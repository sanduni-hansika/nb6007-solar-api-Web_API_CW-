'use strict';
// OpenAPI 3.0.3 description, served live at /openapi.json and rendered by Swagger UI at /api-docs.
const config = require('../config');

const ref = (n) => ({ $ref: `#/components/schemas/${n}` });
const rsp = (n) => ({ $ref: `#/components/responses/${n}` });
const prm = (n) => ({ $ref: `#/components/parameters/${n}` });
const json = (schema, example) => ({ 'application/json': { schema, ...(example ? { example } : {}) } });
const paged = (item) => ({ type: 'object', properties: { data: { type: 'array', items: ref(item) }, pagination: ref('Pagination'), links: ref('PageLinks') } });
const VALIDATORS = {
  ETag: { description: 'Validator for conditional GET (If-None-Match).', schema: { type: 'string' } },
  'Last-Modified': { description: 'Validator for conditional GET (If-Modified-Since).', schema: { type: 'string' } },
};
const PAGE_HEADERS = { ...VALIDATORS, 'X-Total-Count': { schema: { type: 'integer' }, description: 'Total number of items.' }, Link: { schema: { type: 'string' }, description: 'RFC 8288 links: first, prev, next, last.' } };

function op(tag, summary, o = {}) {
  const errors = { 400: rsp('BadRequest'), 401: rsp('Unauthorized'), 403: rsp('Forbidden'), 406: rsp('NotAcceptable'), 429: rsp('TooManyRequests'), ...(o.notFound === false ? {} : { 404: rsp('NotFound') }) };
  const out = { tags: [tag], summary, description: o.desc, operationId: o.id, responses: { ...o.responses, ...errors } };
  if (o.secure !== false) out.security = [{ bearerAuth: [] }];
  if (o.params) out.parameters = o.params;
  if (o.body) out.requestBody = { required: true, content: { 'application/json': { schema: o.body, ...(o.bodyExample ? { example: o.bodyExample } : {}) } } };
  if (o.readCond) out.responses[304] = { description: 'Not Modified - the client already holds the current version (empty body).' };
  return out;
}
const ok = (schema, headers = VALIDATORS, desc = 'OK') => ({ 200: { description: desc, headers, content: json(schema) } });
const idParam = (name, desc) => ({ name, in: 'path', required: true, description: desc, schema: { type: 'integer', minimum: 1 } });

function buildOpenApi(req) {
  const origin = config.publicUrl || `${req.protocol}://${req.get('host')}`;
  const now = new Date();
  const nowIso = new Date(Math.floor(now.getTime() / 1000) * 1000).toISOString();
  const IF_MATCH = { name: 'If-Match', in: 'header', required: false, description: 'ETag from a previous GET. If the resource has changed => 412.', schema: { type: 'string' } };
  const P = ['page', 'page_size'].map(prm);
  const sortParam = (desc) => ({ name: 'sort', in: 'query', description: desc, schema: { type: 'string' } });

  return {
    openapi: '3.0.3',
    info: {
      title: 'SLSEA Real-Time Solar Generation Data API',
      version: '1.0.0',
      description: [
        'REST API (Richardson Maturity Model Level 2) for the Sri Lanka Sustainable Energy Authority.',
        '',
        '**Write-read split.** Metering devices (write-clients) authenticate **as their installation** and may only `POST` readings for it. SLSEA users (read-clients) read data **scoped to their jurisdiction** (national / provincial / district).',
        '',
        '**How to try it:** 1) `POST /tokens` (users: email+password; devices: meter_id+device_secret). 2) Click **Authorize** (top right) and paste the `access_token`. 3) Call any endpoint with *Try it out*.',
        '',
        'All collections support `page` / `page_size`. Readings support `from`, `to`, `sort`, and jurisdiction filters. Retrievable resources support conditional GET (`ETag`/`If-None-Match`, `Last-Modified`/`If-Modified-Since`) and answer **304 Not Modified** with an empty body.',
      ].join('\n'),
    },
    servers: [{ url: `${origin}/api/v1` }],
    tags: [
      { name: 'Authentication' }, { name: 'Hierarchy' }, { name: 'Installations' },
      { name: 'Readings' }, { name: 'Summaries' }, { name: 'Users' },
    ],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'JWT from POST /tokens. Scopes: hierarchy:read, readings:read, readings:write (device), assets:write, readings:delete, users:manage (admin).' } },
      parameters: {
        page: { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 }, description: 'Page number (1-based).' },
        page_size: { name: 'page_size', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500, default: 50 }, description: 'Items per page.' },
        from: { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'Start of time window (inclusive), ISO-8601 with time zone.' },
        to: { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'End of time window (inclusive).' },
        readingSort: { name: 'sort', in: 'query', schema: { type: 'string', enum: ['timestamp', '-timestamp', 'power_kw', '-power_kw', 'energy_kwh', '-energy_kwh'], default: '-timestamp' }, description: "Sort field; prefix '-' for descending." },
        status: { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'maintenance', 'decommissioned'] } },
      },
      responses: {
        BadRequest: { description: '400 - validation failed / invalid parameter', content: json(ref('Error')) },
        Unauthorized: { description: '401 - missing, invalid or expired token', content: json(ref('Error')) },
        Forbidden: { description: '403 - insufficient scope, wrong device, or out of jurisdiction', content: json(ref('Error')) },
        NotFound: { description: '404 - resource does not exist', content: json(ref('Error')) },
        NotAcceptable: { description: '406 - only application/json is produced', content: json(ref('Error')) },
        Conflict: { description: '409 - duplicate or conflicting resource', content: json(ref('Error')) },
        PreconditionFailed: { description: '412 - If-Match did not match the current ETag', content: json(ref('Error')) },
        TooManyRequests: { description: '429 - rate limit exceeded', content: json(ref('Error')) },
      },
      schemas: {
        Error: {
          type: 'object', description: 'The single error contract used by the whole API.',
          properties: { error: { type: 'object', required: ['code', 'message', 'status', 'details'], properties: {
            code: { type: 'string', example: 'VALIDATION_FAILED' }, message: { type: 'string' }, status: { type: 'integer', example: 400 },
            details: { type: 'array', items: { type: 'object', additionalProperties: true }, example: [{ field: 'power_kw', issue: 'must be >= 0' }] },
            path: { type: 'string' }, timestamp: { type: 'string', format: 'date-time' }, request_id: { type: 'string' } } } },
        },
        Pagination: { type: 'object', properties: { page: { type: 'integer' }, page_size: { type: 'integer' }, total_count: { type: 'integer' }, total_pages: { type: 'integer' } } },
        PageLinks: { type: 'object', properties: { self: { type: 'string' }, first: { type: 'string' }, prev: { type: 'string', nullable: true }, next: { type: 'string', nullable: true }, last: { type: 'string' } } },
        Province: { type: 'object', properties: { id: { type: 'integer' }, code: { type: 'string', example: 'WP' }, name: { type: 'string', example: 'Western' } } },
        District: { type: 'object', properties: { id: { type: 'integer' }, code: { type: 'string', example: 'COL' }, name: { type: 'string', example: 'Colombo' }, province_id: { type: 'integer' } } },
        GridSubstation: { type: 'object', properties: { id: { type: 'integer' }, code: { type: 'string', example: 'GSS-COL-01' }, name: { type: 'string' }, district_id: { type: 'integer' }, province_id: { type: 'integer' }, voltage_level_kv: { type: 'number', example: 33 }, capacity_mva: { type: 'number', example: 31.5 }, created_at: { type: 'string', format: 'date-time' }, updated_at: { type: 'string', format: 'date-time' } } },
        GridSubstationInput: { type: 'object', required: ['code', 'name', 'voltage_level_kv', 'capacity_mva'], properties: { code: { type: 'string', example: 'GSS-COL-03' }, name: { type: 'string', example: 'Colombo Grid Substation C' }, voltage_level_kv: { type: 'number', example: 33 }, capacity_mva: { type: 'number', example: 31.5 } } },
        SolarInstallation: { type: 'object', properties: { id: { type: 'integer' }, meter_id: { type: 'string', example: 'SLSEA-MTR-0001' }, site_name: { type: 'string' }, installed_capacity_kw: { type: 'number', example: 5 }, latitude: { type: 'number', nullable: true }, longitude: { type: 'number', nullable: true }, status: { type: 'string', enum: ['active', 'maintenance', 'decommissioned'] }, commissioned_on: { type: 'string', format: 'date' }, substation_id: { type: 'integer' }, district_id: { type: 'integer' }, province_id: { type: 'integer' }, created_at: { type: 'string', format: 'date-time' }, updated_at: { type: 'string', format: 'date-time' } } },
        InstallationCreate: { type: 'object', required: ['meter_id', 'site_name', 'installed_capacity_kw', 'commissioned_on'], properties: { meter_id: { type: 'string', example: 'SLSEA-MTR-9001' }, site_name: { type: 'string', example: 'Rooftop Solar Site - Demo' }, installed_capacity_kw: { type: 'number', example: 5 }, latitude: { type: 'number', example: 6.9271 }, longitude: { type: 'number', example: 79.8612 }, status: { type: 'string', enum: ['active', 'maintenance', 'decommissioned'], default: 'active' }, commissioned_on: { type: 'string', format: 'date', example: '2025-06-15' } } },
        InstallationReplace: { type: 'object', required: ['substation_id', 'meter_id', 'site_name', 'installed_capacity_kw', 'latitude', 'longitude', 'status', 'commissioned_on'], description: 'PUT = FULL replacement: every field is required.', properties: { substation_id: { type: 'integer', example: 1 }, meter_id: { type: 'string' }, site_name: { type: 'string' }, installed_capacity_kw: { type: 'number' }, latitude: { type: 'number', nullable: true }, longitude: { type: 'number', nullable: true }, status: { type: 'string', enum: ['active', 'maintenance', 'decommissioned'] }, commissioned_on: { type: 'string', format: 'date' } } },
        InstallationPatch: { type: 'object', description: 'PATCH = PARTIAL update: send only the fields to change.', properties: { site_name: { type: 'string', example: 'Renamed site' }, status: { type: 'string', enum: ['active', 'maintenance', 'decommissioned'] }, installed_capacity_kw: { type: 'number' } } },
        InstallationCreated: { allOf: [ref('SolarInstallation'), { type: 'object', properties: { device_credentials: { type: 'object', properties: { meter_id: { type: 'string' }, device_secret: { type: 'string' }, note: { type: 'string' } } } } }] },
        GenerationReading: { type: 'object', properties: { id: { type: 'integer' }, installation_id: { type: 'integer' }, timestamp: { type: 'string', format: 'date-time' }, power_kw: { type: 'number', description: 'Instantaneous power (kW)' }, energy_kwh: { type: 'number', description: 'Cumulative energy meter register (kWh)' }, voltage_v: { type: 'number' }, temperature_c: { type: 'number', nullable: true }, received_at: { type: 'string', format: 'date-time', description: 'Server ingestion time' } } },
        ReadingCreate: { type: 'object', required: ['power_kw', 'energy_kwh', 'voltage_v'], properties: { timestamp: { type: 'string', format: 'date-time', description: 'Event time (defaults to now). Must be unique per installation.' }, power_kw: { type: 'number', example: 2.5 }, energy_kwh: { type: 'number', description: 'Cumulative; must not decrease. GET latest-reading first and add a little.', example: 12345.6 }, voltage_v: { type: 'number', example: 231.4 }, temperature_c: { type: 'number', example: 41.5 } } },
        LatestReading: { type: 'object', description: 'Derived resource: newest reading plus freshness and utilisation.', properties: { installation_id: { type: 'integer' }, meter_id: { type: 'string' }, installation_status: { type: 'string' }, freshness: { type: 'string', enum: ['live', 'stale'] }, capacity_utilisation_percent: { type: 'number' }, reading: ref('GenerationReading') } },
        InstallationOverview: { type: 'object', description: 'Composite resource: installation + hierarchy + latest reading + today statistics.', properties: { installation: ref('SolarInstallation'), hierarchy: { type: 'object' }, latest_reading: { type: 'object', nullable: true }, today: { type: 'object' } } },
        GenerationSummary: { type: 'object', description: 'Processing resource aggregated across many installations.', properties: { scope: { type: 'object' }, timezone: { type: 'string' }, as_of: { type: 'string', format: 'date-time' }, installations: { type: 'object' }, current: { type: 'object' }, today: { type: 'object' }, by_grid_substation: { type: 'array', items: { type: 'object' } } } },
        User: { type: 'object', properties: { id: { type: 'integer' }, email: { type: 'string' }, full_name: { type: 'string' }, role: { type: 'string', enum: ['admin', 'national', 'provincial', 'district'] }, province_id: { type: 'integer', nullable: true }, district_id: { type: 'integer', nullable: true }, active: { type: 'boolean' }, created_at: { type: 'string', format: 'date-time' } } },
        UserCreate: { type: 'object', required: ['email', 'password', 'full_name', 'role'], properties: { email: { type: 'string', example: 'analyst@slsea.example' }, password: { type: 'string', example: 'StrongPass123' }, full_name: { type: 'string' }, role: { type: 'string', enum: ['admin', 'national', 'provincial', 'district'] }, province_id: { type: 'integer' }, district_id: { type: 'integer' } } },
        TokenRequest: { oneOf: [
          { type: 'object', title: 'SLSEA user', required: ['email', 'password'], properties: { email: { type: 'string', example: 'district.colombo@slsea.example' }, password: { type: 'string' } } },
          { type: 'object', title: 'Metering device', required: ['meter_id', 'device_secret'], properties: { meter_id: { type: 'string', example: 'SLSEA-MTR-0001' }, device_secret: { type: 'string' } } },
        ] },
        TokenResponse: { type: 'object', properties: { access_token: { type: 'string' }, token_type: { type: 'string', example: 'Bearer' }, expires_in: { type: 'integer', example: 3600 }, scope: { type: 'string', example: 'hierarchy:read readings:read' }, subject: { type: 'object' } } },
      },
    },
    paths: {
      '/tokens': { post: op('Authentication', 'Obtain an access token (JWT)', { id: 'createToken', secure: false, notFound: false,
        desc: 'Users send `{email,password}`; devices send `{meter_id,device_secret}` and receive a token bound to their ONE installation. Failed attempts are rate-limited (10 per 15 min). Token issuance returns 200 (RFC 6749 §5.1) because no addressable resource is created.',
        body: ref('TokenRequest'),
        responses: { 200: { description: 'Token issued', content: json(ref('TokenResponse')) }, 401: rsp('Unauthorized') } }) },

      '/provinces': { get: op('Hierarchy', 'List provinces (in your jurisdiction)', { id: 'listProvinces', params: [...P, sortParam('id | name | code')], responses: ok(paged('Province'), PAGE_HEADERS), readCond: true, notFound: false }) },
      '/provinces/{id}': { get: op('Hierarchy', 'Get one province', { id: 'getProvince', params: [idParam('id', 'Province id')], responses: ok(ref('Province')), readCond: true }) },
      '/provinces/{id}/districts': { get: op('Hierarchy', 'List the districts of a province', { id: 'listDistrictsOfProvince', params: [idParam('id', 'Province id'), ...P], responses: ok(paged('District'), PAGE_HEADERS), readCond: true }) },
      '/districts/{id}': { get: op('Hierarchy', 'Get one district', { id: 'getDistrict', params: [idParam('id', 'District id')], responses: ok(ref('District')), readCond: true }) },
      '/districts/{id}/grid-substations': {
        get: op('Hierarchy', 'List the grid substations of a district', { id: 'listSubstationsOfDistrict', params: [idParam('id', 'District id'), ...P], responses: ok(paged('GridSubstation'), PAGE_HEADERS), readCond: true }),
        post: op('Hierarchy', 'Create a grid substation (admin)', { id: 'createSubstation', params: [idParam('id', 'District id')], body: ref('GridSubstationInput'), responses: { 201: { description: 'Created', headers: { Location: { schema: { type: 'string' } }, ETag: VALIDATORS.ETag }, content: json(ref('GridSubstation')) }, 409: rsp('Conflict') } }),
      },
      '/grid-substations/{id}': {
        get: op('Hierarchy', 'Get one grid substation', { id: 'getSubstation', params: [idParam('id', 'Substation id')], responses: ok(ref('GridSubstation')), readCond: true }),
        put: op('Hierarchy', 'Replace a grid substation (admin, idempotent)', { id: 'replaceSubstation', params: [idParam('id', 'Substation id'), IF_MATCH], body: ref('GridSubstationInput'), responses: { ...ok(ref('GridSubstation')), 409: rsp('Conflict'), 412: rsp('PreconditionFailed') } }),
        patch: op('Hierarchy', 'Partially update a grid substation (admin)', { id: 'patchSubstation', params: [idParam('id', 'Substation id'), IF_MATCH], body: { type: 'object', properties: { name: { type: 'string' }, capacity_mva: { type: 'number' } } }, responses: { ...ok(ref('GridSubstation')), 412: rsp('PreconditionFailed') } }),
        delete: op('Hierarchy', 'Delete a grid substation (admin; 409 if it still has installations)', { id: 'deleteSubstation', params: [idParam('id', 'Substation id'), IF_MATCH], responses: { 204: { description: 'Deleted' }, 409: rsp('Conflict'), 412: rsp('PreconditionFailed') } }),
      },
      '/grid-substations/{id}/installations': {
        get: op('Installations', 'List the installations connected to a substation', { id: 'listInstallationsOfSubstation', params: [idParam('id', 'Substation id'), prm('status'), ...P], responses: ok(paged('SolarInstallation'), PAGE_HEADERS), readCond: true }),
        post: op('Installations', 'Register a new installation (admin)', { id: 'createInstallation', params: [idParam('id', 'Substation id')], body: ref('InstallationCreate'),
          desc: 'Returns 201 + Location. The one-time `device_credentials.device_secret` is shown only in this response.',
          responses: { 201: { description: 'Created', headers: { Location: { schema: { type: 'string' } }, ETag: VALIDATORS.ETag }, content: json(ref('InstallationCreated')) }, 409: rsp('Conflict') } }),
      },
      '/installations': { get: op('Installations', 'List installations (jurisdiction-filtered)', { id: 'listInstallations', notFound: false,
        params: [...P, { name: 'province_id', in: 'query', schema: { type: 'integer' } }, { name: 'district_id', in: 'query', schema: { type: 'integer' } }, { name: 'substation_id', in: 'query', schema: { type: 'integer' } }, prm('status'), { name: 'q', in: 'query', description: 'Search site name / meter id', schema: { type: 'string' } }, sortParam('id | meter_id | site_name | installed_capacity_kw | commissioned_on (prefix - for desc)')],
        responses: ok(paged('SolarInstallation'), PAGE_HEADERS), readCond: true }) },
      '/installations/{id}': {
        get: op('Installations', 'Get one installation', { id: 'getInstallation', params: [idParam('id', 'Installation id')], responses: ok(ref('SolarInstallation')), readCond: true }),
        put: op('Installations', 'Replace an installation (admin, idempotent full replacement)', { id: 'replaceInstallation', params: [idParam('id', 'Installation id'), IF_MATCH], body: ref('InstallationReplace'), responses: { ...ok(ref('SolarInstallation')), 409: rsp('Conflict'), 412: rsp('PreconditionFailed') } }),
        patch: op('Installations', 'Partially update an installation (admin)', { id: 'patchInstallation', params: [idParam('id', 'Installation id'), IF_MATCH], body: ref('InstallationPatch'), responses: { ...ok(ref('SolarInstallation')), 409: rsp('Conflict'), 412: rsp('PreconditionFailed') } }),
        delete: op('Installations', 'Delete an installation and its readings (admin)', { id: 'deleteInstallation', params: [idParam('id', 'Installation id'), IF_MATCH], responses: { 204: { description: 'Deleted' }, 412: rsp('PreconditionFailed') } }),
      },
      '/installations/{id}/overview': { get: op('Installations', 'Composite resource: installation + hierarchy + latest reading + today', { id: 'getInstallationOverview', params: [idParam('id', 'Installation id')], responses: ok(ref('InstallationOverview')), readCond: true }) },
      '/installations/{id}/latest-reading': { get: op('Readings', 'Last-known reading (operational, real-time view)', { id: 'getLatestReading', desc: 'Derived resource: the single most recent reading with `freshness` (live/stale) and capacity utilisation.', params: [idParam('id', 'Installation id')], responses: ok(ref('LatestReading')), readCond: true }) },
      '/installations/{id}/readings': {
        get: op('Readings', 'Generation history of one installation (analytical view)', { id: 'listInstallationReadings', params: [idParam('id', 'Installation id'), ...P, prm('from'), prm('to'), prm('readingSort')], responses: ok(paged('GenerationReading'), PAGE_HEADERS), readCond: true,
          desc: 'Pagination (total count + next/prev links), time-window filtering and sorting by timestamp ascending/descending.' }),
        post: op('Readings', 'Ingest a new reading (device only)', { id: 'createReading', params: [idParam('id', 'Installation id')], body: ref('ReadingCreate'),
          bodyExample: { timestamp: nowIso, power_kw: 2.5, energy_kwh: 99999.9, voltage_v: 231.4, temperature_c: 41.5 },
          desc: 'Requires a **device token** whose installation matches `{id}`. 201 + Location on success. Re-sending an identical reading is idempotent (200); a different value for an existing timestamp is 409. `energy_kwh` must not be lower than the previous cumulative value.',
          responses: { 201: { description: 'Created', headers: { Location: { schema: { type: 'string' } }, ETag: VALIDATORS.ETag }, content: json(ref('GenerationReading')) }, 200: { description: 'Identical reading already stored (idempotent retry)', content: json(ref('GenerationReading')) }, 409: rsp('Conflict') } }),
      },
      '/installations/{id}/readings/{readingId}': {
        get: op('Readings', 'Get one reading', { id: 'getReading', params: [idParam('id', 'Installation id'), idParam('readingId', 'Reading id')], responses: ok(ref('GenerationReading')), readCond: true }),
        delete: op('Readings', 'Retract an erroneous reading (admin). PUT/PATCH are not allowed: readings are append-only (405).', { id: 'deleteReading', params: [idParam('id', 'Installation id'), idParam('readingId', 'Reading id')], responses: { 204: { description: 'Deleted' } } }),
      },
      '/readings': { get: op('Readings', 'All readings visible to you, filterable by jurisdiction and time window', { id: 'listReadings', notFound: false,
        params: [...P, { name: 'province_id', in: 'query', schema: { type: 'integer' } }, { name: 'district_id', in: 'query', schema: { type: 'integer' } }, { name: 'substation_id', in: 'query', schema: { type: 'integer' } }, { name: 'installation_id', in: 'query', schema: { type: 'integer' } }, prm('from'), prm('to'), prm('readingSort')],
        responses: ok(paged('GenerationReading'), PAGE_HEADERS), readCond: true }) },
      '/districts/{id}/generation-summary': { get: op('Summaries', 'District generation summary (processing resource)', { id: 'getDistrictSummary', desc: 'Current total power and today\'s total energy across all installations in the district, plus a per-substation breakdown.', params: [idParam('id', 'District id')], responses: ok(ref('GenerationSummary')), readCond: true }) },
      '/provinces/{id}/generation-summary': { get: op('Summaries', 'Province generation summary (provincial/national users only)', { id: 'getProvinceSummary', params: [idParam('id', 'Province id')], responses: ok(ref('GenerationSummary')), readCond: true }) },
      '/users/me': { get: op('Users', 'The authenticated user and their jurisdiction', { id: 'getMe', notFound: false, responses: ok(ref('User')) }) },
      '/users': {
        get: op('Users', 'List users (admin)', { id: 'listUsers', notFound: false, params: [...P, { name: 'role', in: 'query', schema: { type: 'string', enum: ['admin', 'national', 'provincial', 'district'] } }], responses: ok(paged('User'), PAGE_HEADERS) }),
        post: op('Users', 'Create a user (admin)', { id: 'createUser', notFound: false, body: ref('UserCreate'), responses: { 201: { description: 'Created', headers: { Location: { schema: { type: 'string' } } }, content: json(ref('User')) }, 409: rsp('Conflict') } }),
      },
      '/users/{id}': {
        get: op('Users', 'Get a user (admin)', { id: 'getUser', params: [idParam('id', 'User id')], responses: ok(ref('User')) }),
        patch: op('Users', 'Update full_name / active / password (admin)', { id: 'patchUser', params: [idParam('id', 'User id')], body: { type: 'object', properties: { full_name: { type: 'string' }, active: { type: 'boolean' }, password: { type: 'string' } } }, responses: ok(ref('User')) }),
        delete: op('Users', 'Delete a user (admin)', { id: 'deleteUser', params: [idParam('id', 'User id')], responses: { 204: { description: 'Deleted' }, 409: rsp('Conflict') } }),
      },
    },
  };
}
module.exports = { buildOpenApi };
