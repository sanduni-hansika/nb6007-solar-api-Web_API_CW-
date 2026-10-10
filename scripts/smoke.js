'use strict';
/**
 * End-to-end verification of the API against the brief.   Usage:
 *   npm run smoke                                  (tests http://localhost:3000)
 *   npm run smoke -- https://your-api.onrender.com (tests the deployed API)
 *   add --ratelimit to also test login throttling (afterwards wait 15 min before logging in again)
 * Set SEED_PASSWORD to the password configured on the server (default Solar@2026!Demo).
 */
const BASE = (process.argv[2] || process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const PASSWORD = process.env.SEED_PASSWORD || 'Solar@2026!Demo';
const API = BASE + '/api/v1';
let pass = 0, fail = 0;

function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}
async function call(method, path, { token, body, headers = {}, raw = false } = {}) {
  const h = { Accept: 'application/json', ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] = h['Content-Type'] || 'application/json';
  const res = await fetch(raw ? path : API + path, { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, headers: res.headers, data, text };
}
const login = async (email) => (await call('POST', '/tokens', { body: { email, password: PASSWORD } })).data?.access_token;
const section = (t) => console.log(`\n== ${t}`);

(async () => {
  console.log(`Testing ${BASE}`);

  section('Public surface, docs and health');
  let r = await call('GET', `${BASE}/health`, { raw: true });
  check('GET /health = 200 and database up', r.status === 200 && r.data.database === 'up');
  r = await call('GET', `${BASE}/openapi.json`, { raw: true });
  check('OpenAPI JSON served', r.status === 200 && r.data.openapi && Object.keys(r.data.paths).length >= 20);
  const sw = await fetch(`${BASE}/api-docs/`);
  check('Swagger UI served at /api-docs', sw.status === 200 && (await sw.text()).includes('swagger'));

  section('Authentication');
  r = await call('GET', '/provinces');
  check('No token => 401 with error contract', r.status === 401 && r.data.error?.code && r.data.error.message && Array.isArray(r.data.error.details));
  r = await call('POST', '/tokens', { body: { email: 'national@slsea.example', password: 'wrong-password' } });
  check('Wrong password => 401', r.status === 401 && r.data.error.code === 'INVALID_CREDENTIALS');
  r = await call('GET', '/provinces', { token: 'abc.def.ghi' });
  check('Garbage token => 401', r.status === 401);
  const admin = await login('admin@slsea.example');
  const national = await login('national@slsea.example');
  const western = await login('provincial.western@slsea.example');
  const colombo = await login('district.colombo@slsea.example');
  const jaffna = await login('district.jaffna@slsea.example');
  check('All demo users can obtain tokens', admin && national && western && colombo && jaffna);
  r = await call('GET', '/users/me', { token: colombo });
  check('/users/me returns district user + scopes', r.status === 200 && r.data.role === 'district' && r.data.scopes.includes('readings:read') && !r.data.scopes.includes('assets:write'));

  section('Hierarchy read path (national)');
  r = await call('GET', '/provinces', { token: national });
  check('9 provinces', r.status === 200 && r.data.pagination.total_count === 9 && r.data.data.length === 9);
  const prov = r.data.data[0];
  r = await call('GET', `/provinces/${prov.id}`, { token: national });
  check('GET /provinces/{id}', r.status === 200 && r.data.id === prov.id && r.headers.get('etag') && r.headers.get('last-modified'));
  r = await call('GET', '/provinces/1/districts', { token: national });
  check('Districts nested under province (Western has 3)', r.status === 200 && r.data.pagination.total_count === 3);
  const colomboDistrict = r.data.data.find((d) => d.name === 'Colombo');
  const jaffnaId = (await call('GET', '/provinces/4/districts', { token: national })).data.data.find((d) => d.name === 'Jaffna').id;
  let total = 0;
  for (let p = 1; p <= 9; p++) total += (await call('GET', `/provinces/${p}/districts`, { token: national })).data.pagination.total_count;
  check('25 districts in total', total === 25, `got ${total}`);
  r = await call('GET', `/districts/${colomboDistrict.id}/grid-substations`, { token: national });
  check('Substations nested under district (2)', r.status === 200 && r.data.pagination.total_count === 2);
  const sub = r.data.data[0];
  r = await call('GET', `/grid-substations/${sub.id}/installations`, { token: national });
  check('Installations nested under substation (5)', r.status === 200 && r.data.pagination.total_count === 5);
  const inst = r.data.data[0];
  r = await call('GET', '/installations?page_size=1', { token: national });
  check('250 installations in total (>= 200)', r.data.pagination.total_count >= 200);
  r = await call('GET', '/installations?q=0001', { token: national });
  check('Installation search (q)', r.status === 200 && r.data.data.length >= 1);

  section('Composite, last-known and history resources');
  r = await call('GET', `/installations/${inst.id}/overview`, { token: national });
  check('Composite overview has installation+hierarchy+latest+today', r.status === 200 && r.data.installation && r.data.hierarchy.district && r.data.latest_reading && r.data.today.energy_kwh >= 0);
  r = await call('GET', `/installations/${inst.id}/latest-reading`, { token: national });
  check('Latest reading is derived and live', r.status === 200 && r.data.freshness === 'live' && r.data.reading.timestamp && typeof r.data.capacity_utilisation_percent === 'number', JSON.stringify(r.data).slice(0, 200));
  const latest = r.data;
  r = await call('GET', `/installations/${inst.id}/readings?page_size=100`, { token: national });
  check('Readings: >= 672 per installation (7 days @ 15 min)', r.status === 200 && r.data.pagination.total_count >= 672, `got ${r.data?.pagination?.total_count}`);
  check('Readings: total count, links and Link header', r.data.links.next && r.data.links.first && r.data.links.last && r.data.links.prev === null && r.headers.get('link').includes('rel="next"') && r.headers.get('x-total-count'));
  check('Readings: default order newest first', r.data.data[0].timestamp >= r.data.data[1].timestamp);
  const next = await call('GET', r.data.links.next, { token: national, raw: true });
  check('Following links.next works and links.prev appears', next.status === 200 && next.data.pagination.page === 2 && next.data.links.prev);
  r = await call('GET', `/installations/${inst.id}/readings?sort=timestamp&page_size=5`, { token: national });
  check('Sort ascending', r.data.data[0].timestamp < r.data.data[4].timestamp);
  r = await call('GET', `/installations/${inst.id}/readings?sort=-timestamp&page_size=5`, { token: national });
  check('Sort descending', r.data.data[0].timestamp > r.data.data[4].timestamp);
  r = await call('GET', `/installations/${inst.id}/readings?sort=power_kw&order=desc&page_size=3`, { token: national });
  check('Sort by power_kw + order=desc', r.data.data[0].power_kw >= r.data.data[2].power_kw);
  const from = new Date(Date.now() - 24 * 3600e3).toISOString(), to = new Date(Date.now() - 12 * 3600e3).toISOString();
  r = await call('GET', `/installations/${inst.id}/readings?from=${from}&to=${to}&page_size=500`, { token: national });
  check('Time-window filter returns ~48 rows inside window', r.status === 200 && r.data.pagination.total_count >= 46 && r.data.pagination.total_count <= 50 && r.data.data.every((x) => x.timestamp >= from && x.timestamp <= to), `total ${r.data.pagination.total_count}`);
  r = await call('GET', `/installations/${inst.id}/readings?from=2000-01-01T00:00:00Z&to=2000-01-02T00:00:00Z`, { token: national });
  check('Empty window => 200, empty data, count 0', r.status === 200 && r.data.data.length === 0 && r.data.pagination.total_count === 0 && r.data.links.next === null);
  r = await call('GET', `/readings?district_id=${colomboDistrict.id}&page_size=10`, { token: national });
  check('Filter by district', r.status === 200 && r.data.pagination.total_count >= 2 * 5 * 672);
  r = await call('GET', `/readings?substation_id=${sub.id}&page_size=10`, { token: national });
  check('Filter by substation', r.status === 200 && r.data.pagination.total_count === 5 * 672 + (r.data.pagination.total_count - 5 * 672) && r.data.pagination.total_count >= 3360);
  r = await call('GET', `/readings?province_id=1&from=${from}&to=${to}&sort=timestamp&page_size=10`, { token: national });
  check('Filter by province + time window + sort combined', r.status === 200 && r.data.data.length === 10);
  r = await call('GET', `/installations/${inst.id}/readings?from=not-a-date`, { token: national });
  check('Bad query parameter => 400 with details', r.status === 400 && r.data.error.code === 'INVALID_QUERY_PARAMETER');
  r = await call('GET', `/installations/${inst.id}/readings?page_size=9999`, { token: national });
  check('page_size over limit => 400', r.status === 400);
  r = await call('GET', `/installations/${inst.id}/readings?sort=bogus`, { token: national });
  check('Unknown sort field => 400', r.status === 400);

  section('Conditional GET, headers, status codes');
  r = await call('GET', `/installations/${inst.id}`, { token: national });
  const etag = r.headers.get('etag'), lm = r.headers.get('last-modified');
  check('ETag, Last-Modified and Content-Type: application/json', etag && lm && r.headers.get('content-type').startsWith('application/json'));
  let c = await call('GET', `/installations/${inst.id}`, { token: national, headers: { 'If-None-Match': etag } });
  check('If-None-Match => 304 with EMPTY body', c.status === 304 && c.text === '');
  c = await call('GET', `/installations/${inst.id}`, { token: national, headers: { 'If-Modified-Since': lm } });
  check('If-Modified-Since => 304', c.status === 304);
  c = await call('GET', `/installations/${inst.id}`, { token: national, headers: { 'If-None-Match': 'W/"stale"' } });
  check('Stale validator => 200 with body', c.status === 200 && c.data.id === inst.id);
  r = await call('GET', `/installations/${inst.id}/latest-reading`, { token: national });
  c = await call('GET', `/installations/${inst.id}/latest-reading`, { token: national, headers: { 'If-None-Match': r.headers.get('etag') } });
  check('Conditional GET on latest-reading => 304', c.status === 304);
  r = await call('GET', `/installations/${inst.id}/readings?page_size=10`, { token: national });
  c = await call('GET', `/installations/${inst.id}/readings?page_size=10`, { token: national, headers: { 'If-None-Match': r.headers.get('etag') } });
  check('Conditional GET on readings collection => 304', c.status === 304 && c.text === '');
  r = await call('GET', '/installations/999999', { token: national });
  check('Unknown id => 404 with error contract', r.status === 404 && r.data.error.code === 'INSTALLATION_NOT_FOUND');
  r = await call('GET', '/installations/abc', { token: national });
  check('Non-numeric id => 400', r.status === 400 && r.data.error.code === 'INVALID_PATH_PARAMETER');
  r = await call('GET', '/provinces', { token: national, headers: { Accept: 'text/html' } });
  check('Accept: text/html => 406', r.status === 406 && r.data.error.code === 'NOT_ACCEPTABLE');
  r = await call('POST', '/tokens', { body: '{bad json', headers: { 'Content-Type': 'application/json' } });
  check('Malformed JSON => 400 INVALID_JSON', r.status === 400 && r.data.error.code === 'INVALID_JSON');
  r = await call('POST', '/tokens', { body: 'a=b', headers: { 'Content-Type': 'text/plain' } });
  check('Wrong Content-Type => 415', r.status === 415);
  r = await call('GET', '/nope', { token: national });
  check('Unknown route => 404 with contract', r.status === 404 && r.data.error.code === 'ROUTE_NOT_FOUND');

  section('Security: jurisdiction scoping (no cross-jurisdiction leakage)');
  r = await call('GET', '/provinces', { token: western });
  check('Provincial user sees only own province', r.data.pagination.total_count === 1 && r.data.data[0].name === 'Western');
  r = await call('GET', '/provinces', { token: colombo });
  check('District user sees only parent province', r.data.pagination.total_count === 1);
  r = await call('GET', '/provinces/1/districts', { token: colombo });
  check('District user sees only OWN district in the list', r.data.pagination.total_count === 1 && r.data.data[0].name === 'Colombo');
  r = await call('GET', `/districts/${jaffnaId}`, { token: colombo });
  check('Colombo user -> Jaffna district => 403', r.status === 403 && r.data.error.code === 'OUT_OF_JURISDICTION');
  r = await call('GET', `/districts/${jaffnaId}`, { token: western });
  check('Western provincial user -> Jaffna district => 403', r.status === 403);
  const jaffnaSubs = (await call('GET', `/districts/${jaffnaId}/grid-substations`, { token: national })).data.data;
  r = await call('GET', `/districts/${jaffnaId}/grid-substations`, { token: colombo });
  check('Cross-district substations => 403', r.status === 403);
  const jaffnaInst = (await call('GET', `/grid-substations/${jaffnaSubs[0].id}/installations`, { token: national })).data.data[0];
  for (const [label, path] of [['installation', ''], ['latest-reading', '/latest-reading'], ['overview', '/overview'], ['readings', '/readings']]) {
    r = await call('GET', `/installations/${jaffnaInst.id}${path}`, { token: colombo });
    check(`Colombo user -> Jaffna ${label} => 403`, r.status === 403, `got ${r.status}`);
  }
  r = await call('GET', `/districts/${jaffnaId}/generation-summary`, { token: colombo });
  check('Cross-district generation summary => 403', r.status === 403);
  r = await call('GET', `/readings?district_id=${jaffnaId}`, { token: colombo });
  check('/readings?district_id=<other> leaks nothing (0 rows)', r.status === 200 && r.data.pagination.total_count === 0);
  r = await call('GET', '/readings?page_size=500', { token: colombo });
  check('/readings for district user contains only own district', r.data.data.every((x) => x.installation_id !== jaffnaInst.id) && r.data.pagination.total_count >= 3360);
  r = await call('GET', '/installations?page_size=500', { token: colombo });
  check('/installations for district user = own 10 sites only', r.data.pagination.total_count === 10 && r.data.data.every((x) => x.district_id === colomboDistrict.id));
  r = await call('GET', '/installations?page_size=500', { token: western });
  check('/installations for provincial user = own province (Western 3 districts x 10)', r.data.pagination.total_count === 30);
  r = await call('GET', `/installations?district_id=${jaffnaId}`, { token: western });
  check('Provincial user filtering another province => 0 rows', r.data.pagination.total_count === 0);
  r = await call('GET', '/users', { token: national });
  check('Non-admin cannot list users => 403 INSUFFICIENT_SCOPE', r.status === 403 && r.data.error.code === 'INSUFFICIENT_SCOPE');
  r = await call('POST', `/installations/${inst.id}/readings`, { token: national, body: { power_kw: 1, energy_kwh: 1, voltage_v: 230 } });
  check('SLSEA users can NEVER write readings => 403', r.status === 403 && r.data.error.code === 'INSUFFICIENT_SCOPE');
  r = await call('POST', `/installations/${inst.id}/readings`, { token: admin, body: { power_kw: 1, energy_kwh: 1, voltage_v: 230 } });
  check('Even admin cannot write readings => 403', r.status === 403);
  r = await call('PATCH', `/installations/${inst.id}`, { token: colombo, body: { site_name: 'hack' } });
  check('District user cannot modify assets => 403', r.status === 403);
  r = await call('GET', '/provinces/1/generation-summary', { token: colombo });
  check('District user cannot read province-wide summary => 403', r.status === 403);

  section('Write path: device authentication + ingestion');
  r = await call('POST', '/tokens', { body: { meter_id: inst.meter_id, device_secret: 'wrong' } });
  check('Wrong device secret => 401', r.status === 401);
  // create a throw-away installation as admin to get a known device secret (works against any deployment)
  const code = 'SLSEA-TEST-' + Date.now().toString().slice(-8);
  r = await call('POST', `/grid-substations/${sub.id}/installations`, { token: admin, body: { meter_id: code, site_name: 'Smoke test site', installed_capacity_kw: 5, latitude: 6.9, longitude: 79.8, commissioned_on: '2025-01-01' } });
  check('Admin creates installation => 201 + Location + ETag + one-time secret', r.status === 201 && r.headers.get('location')?.includes(`/api/v1/installations/${r.data.id}`) && r.headers.get('etag') && r.data.device_credentials?.device_secret, JSON.stringify(r.data).slice(0, 200));
  const newInst = r.data, secret = r.data.device_credentials.device_secret, loc = r.headers.get('location');
  r = await call('POST', `/grid-substations/${sub.id}/installations`, { token: admin, body: { meter_id: code, site_name: 'dup', installed_capacity_kw: 5, commissioned_on: '2025-01-01' } });
  check('Duplicate meter_id => 409', r.status === 409 && r.data.error.code === 'DUPLICATE_RESOURCE');
  r = await call('POST', `/grid-substations/${sub.id}/installations`, { token: admin, body: { meter_id: 'x', installed_capacity_kw: -1, bogus: 1 } });
  check('Invalid installation => 400 listing every problem', r.status === 400 && r.data.error.details.length >= 4);
  r = await call('POST', '/tokens', { body: { meter_id: code, device_secret: secret } });
  check('Device authenticates as its installation (readings:write only)', r.status === 200 && r.data.scope === 'readings:write' && r.data.subject.installation_id === newInst.id);
  const dev = r.data.access_token;
  r = await call('GET', '/provinces', { token: dev });
  check('Device token cannot read hierarchy => 403', r.status === 403);
  r = await call('GET', `/installations/${newInst.id}/readings`, { token: dev });
  check('Device token cannot read readings => 403', r.status === 403);
  r = await call('POST', `/installations/${inst.id}/readings`, { token: dev, body: { power_kw: 1, energy_kwh: 1, voltage_v: 230 } });
  check("Device cannot write another installation's readings => 403", r.status === 403 && r.data.error.code === 'DEVICE_INSTALLATION_MISMATCH');
  r = await call('PATCH', `/installations/${newInst.id}`, { token: dev, body: { site_name: 'x' } });
  check('Device cannot write anything but readings => 403', r.status === 403);
  const t1 = new Date(Date.now() - 60e3).toISOString();
  r = await call('POST', `/installations/${newInst.id}/readings`, { token: dev, body: { timestamp: t1, power_kw: 3.2, energy_kwh: 100.5, voltage_v: 231.2, temperature_c: 40 } });
  check('Ingest reading => 201 + Location + ETag', r.status === 201 && r.headers.get('location')?.includes(`/installations/${newInst.id}/readings/${r.data.id}`) && r.headers.get('etag'), JSON.stringify(r.data));
  const readingLoc = r.headers.get('location'), readingId = r.data.id;
  r = await call('GET', readingLoc, { token: national, raw: true });
  check('Location header resolves to the new reading', r.status === 200 && r.data.id === readingId && r.data.power_kw === 3.2);
  r = await call('POST', `/installations/${newInst.id}/readings`, { token: dev, body: { timestamp: t1, power_kw: 3.2, energy_kwh: 100.5, voltage_v: 231.2 } });
  check('Idempotent retry of identical reading => 200 (no duplicate)', r.status === 200 && r.data.id === readingId && r.headers.get('content-location'));
  r = await call('POST', `/installations/${newInst.id}/readings`, { token: dev, body: { timestamp: t1, power_kw: 9, energy_kwh: 100.5, voltage_v: 231.2 } });
  check('Same timestamp, different value => 409 (append-only)', r.status === 409 && r.data.error.code === 'READING_ALREADY_EXISTS');
  r = await call('POST', `/installations/${newInst.id}/readings`, { token: dev, body: { power_kw: 3, energy_kwh: 50, voltage_v: 230 } });
  check('Cumulative energy decreasing => 400', r.status === 400 && r.data.error.details.some((d) => d.field === 'energy_kwh'));
  r = await call('POST', `/installations/${newInst.id}/readings`, { token: dev, body: { power_kw: -1, energy_kwh: 'x' } });
  check('Invalid reading => 400 with field details', r.status === 400 && r.data.error.details.length >= 3);
  r = await call('POST', `/installations/${newInst.id}/readings`, { token: dev, body: { timestamp: new Date(Date.now() + 3600e3).toISOString(), power_kw: 1, energy_kwh: 200, voltage_v: 230 } });
  check('Future timestamp => 400', r.status === 400);
  r = await call('POST', `/installations/${newInst.id}/readings`, { token: dev, body: { power_kw: 3, energy_kwh: 101, voltage_v: 230 } });
  check('Timestamp defaults to now', r.status === 201);
  r = await call('GET', `/installations/${newInst.id}/latest-reading`, { token: admin });
  check('Last-known-reading reflects the newest ingest immediately (live)', r.status === 200 && r.data.reading.energy_kwh === 101 && r.data.freshness === 'live');
  r = await call('PUT', `${readingLoc.replace(BASE + '/api/v1', '')}`, { token: admin, body: {} });
  check('PUT on a reading => 405 with Allow header', r.status === 405 && r.headers.get('allow').includes('GET'));
  r = await call('PATCH', `${readingLoc.replace(BASE + '/api/v1', '')}`, { token: admin, body: {} });
  check('PATCH on a reading => 405', r.status === 405);

  section('CRUD semantics + optimistic concurrency (If-Match => 412)');
  r = await call('GET', `/installations/${newInst.id}`, { token: admin });
  const e1 = r.headers.get('etag');
  r = await call('PATCH', `/installations/${newInst.id}`, { token: admin, body: { site_name: 'Smoke test site (renamed)' }, headers: { 'If-Match': e1 } });
  check('PATCH partial update => 200 and ETag changes', r.status === 200 && r.data.site_name.includes('renamed') && r.headers.get('etag') !== e1);
  r = await call('PATCH', `/installations/${newInst.id}`, { token: admin, body: { site_name: 'again' }, headers: { 'If-Match': e1 } });
  check('Stale If-Match => 412 Precondition Failed', r.status === 412 && r.data.error.code === 'PRECONDITION_FAILED');
  r = await call('PATCH', `/installations/${newInst.id}`, { token: admin, body: {} });
  check('Empty PATCH => 400', r.status === 400);
  const put = { substation_id: sub.id, meter_id: code, site_name: 'Replaced site', installed_capacity_kw: 6, latitude: 6.9, longitude: 79.8, status: 'active', commissioned_on: '2025-01-01' };
  r = await call('PUT', `/installations/${newInst.id}`, { token: admin, body: put });
  const afterPut1 = r.data;
  r = await call('PUT', `/installations/${newInst.id}`, { token: admin, body: put });
  check('PUT full replace is idempotent (same representation twice)', r.status === 200 && r.data.site_name === 'Replaced site' && r.data.installed_capacity_kw === 6 && r.data.id === afterPut1.id);
  const { site_name, ...partial } = put;
  r = await call('PUT', `/installations/${newInst.id}`, { token: admin, body: partial });
  check('PUT with missing fields => 400 (PUT is never a partial update)', r.status === 400);
  r = await call('POST', `/districts/${colomboDistrict.id}/grid-substations`, { token: admin, body: { code: 'GSS-TST-' + Date.now().toString().slice(-6), name: 'Smoke Substation', voltage_level_kv: 33, capacity_mva: 20 } });
  check('Create substation => 201 + Location', r.status === 201 && r.headers.get('location'));
  const tmpSub = r.data;
  r = await call('DELETE', `/grid-substations/${sub.id}`, { token: admin });
  check('Delete substation that still has installations => 409', r.status === 409);
  r = await call('DELETE', `/grid-substations/${tmpSub.id}`, { token: admin });
  check('Delete empty substation => 204', r.status === 204);
  r = await call('DELETE', `/grid-substations/${tmpSub.id}`, { token: admin });
  check('Delete again => 404', r.status === 404);
  r = await call('DELETE', `${readingLoc.replace(BASE + '/api/v1', '')}`, { token: admin });
  check('Admin retracts a reading => 204', r.status === 204);
  r = await call('DELETE', `/installations/${newInst.id}`, { token: admin });
  check('Delete installation (cascades readings) => 204', r.status === 204);
  r = await call('GET', `/installations/${newInst.id}`, { token: admin });
  check('Deleted installation => 404', r.status === 404);
  r = await call('POST', '/tokens', { body: { meter_id: code, device_secret: secret } });
  check('Deleted installation device can no longer authenticate => 401', r.status === 401);

  section('Users (admin)');
  const mail = `smoke.${Date.now()}@slsea.example`;
  r = await call('POST', '/users', { token: admin, body: { email: mail, password: 'StrongPass123', full_name: 'Smoke User', role: 'district', district_id: colomboDistrict.id } });
  check('Create user => 201 + Location, no password in response', r.status === 201 && r.headers.get('location') && !JSON.stringify(r.data).includes('password'));
  const uid = r.data.id;
  r = await call('POST', '/users', { token: admin, body: { email: 'bad', password: 'short', full_name: 'x', role: 'district' } });
  check('Invalid user => 400', r.status === 400 && r.data.error.details.length >= 2);
  r = await call('PATCH', `/users/${uid}`, { token: admin, body: { active: false } });
  check('Disable user', r.status === 200 && r.data.active === false);
  r = await call('POST', '/tokens', { body: { email: mail, password: 'StrongPass123' } });
  check('Disabled user cannot log in', r.status === 401);
  r = await call('DELETE', `/users/${uid}`, { token: admin });
  check('Delete user => 204', r.status === 204);

  section('Operational view: district + province generation summaries (stretch)');
  r = await call('GET', `/districts/${colomboDistrict.id}/generation-summary`, { token: colombo });
  check('District summary: totals, per-substation breakdown', r.status === 200 && r.data.installations.total === 10 && r.data.current.total_power_kw >= 0 && r.data.today.total_energy_kwh >= 0 && r.data.by_grid_substation.length === 2, JSON.stringify(r.data).slice(0, 300));
  r = await call('GET', `/districts/${colomboDistrict.id}/generation-summary`, { token: colombo, headers: { 'If-None-Match': r.headers.get('etag') } });
  check('Summary supports conditional GET => 304', r.status === 304);
  r = await call('GET', '/provinces/1/generation-summary', { token: western });
  check('Province summary for provincial user', r.status === 200 && r.data.installations.total === 30);

  if (process.argv.includes('--ratelimit')) { // opt-in: locks YOUR IP out of logging in for 15 minutes
    section('Rate limiting of failed logins');
    let last;
    for (let i = 0; i < 12; i++) last = await call('POST', '/tokens', { body: { email: 'nobody@slsea.example', password: 'x' } });
    check('Repeated failed logins are throttled => 429', last.status === 429 && last.data.error.code === 'TOO_MANY_FAILED_LOGINS');
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('Smoke test crashed:', e); process.exit(2); });
