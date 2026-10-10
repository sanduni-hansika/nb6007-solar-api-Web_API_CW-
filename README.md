# SLSEA Real-Time Solar Generation Data API

NB6007CEM Web API Development - Coursework 1. Node.js + Express + PostgreSQL.
A national REST API (Richardson Maturity Level 2) that acquires and serves real-time and historical generation data from rooftop solar installations in Sri Lanka.

* **Write-clients:** metering devices authenticate *as their installation* and can only `POST` readings for it.
* **Read-clients:** SLSEA users (national / provincial / district) read data **scoped to their jurisdiction**.
* **Live data:** a built-in simulator makes every active installation report a reading each 15 minutes (and back-fills any gap), so *last-known-reading* is always current.

Live API docs (Swagger UI): `/api-docs` · OpenAPI JSON: `/openapi.json` · Health: `/health`

## Quick start (local)
```bash
npm install
cp .env.example .env        # edit DATABASE_URL, JWT_SECRET, SEED_PASSWORD
npm start                   # creates tables, seeds data on first run, starts the live simulator
npm run smoke               # ~110 automated checks against http://localhost:3000
```
Full step-by-step instructions (including deployment) are in the project guide.

## Environment variables
| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `DATABASE_SSL` | `true` for hosted DBs (Neon/Render/Railway) |
| `JWT_SECRET` | >= 32 random characters (required in production) |
| `SEED_PASSWORD` | password of all seeded demo users |
| `PUBLIC_URL` | public base URL (used in `Location` / pagination links) |
| `AUTO_SEED`, `SIMULATOR` | `true` by default |
| `RETENTION_DAYS` | readings older than this are purged (default 14) |
| `HIDE_OUT_OF_SCOPE` | `true` => 404 instead of 403 for out-of-jurisdiction resources |

## Seed data
9 provinces · 25 districts · 50 grid substations · 250 installations · 7 days x 96 readings per installation (≈168,000 rows) with a realistic diurnal curve, regional weather and a cumulative energy register.

| Role | Example login (password = `SEED_PASSWORD`) | Can |
|---|---|---|
| admin | `admin@slsea.example` | national read + manage substations/installations/users, retract readings |
| national | `national@slsea.example` | read everything |
| provincial | `provincial.western@slsea.example` (also `.central`, `.southern`, `.northern`, `.eastern`, `.north-western`, `.north-central`, `.uva`, `.sabaragamuwa`) | read own province only |
| district | `district.colombo@slsea.example` (+ one per district, e.g. `district.jaffna`) | read own district only |
| device | `meter_id` `SLSEA-MTR-0001` + secret from `npm run device-secret -- SLSEA-MTR-0001` (also printed in the first-boot log) | `POST` readings for its own installation only |

## Endpoint summary (base `/api/v1`)
| Method & path | Resource type | Notes |
|---|---|---|
| `POST /tokens` | token issuance | users `{email,password}` or devices `{meter_id,device_secret}` -> JWT |
| `GET /provinces`, `/provinces/{id}`, `/provinces/{id}/districts` | collection / atomic / scoped collection | |
| `GET /districts/{id}`, `/districts/{id}/grid-substations` | atomic / scoped collection | admin `POST` creates a substation |
| `GET/PUT/PATCH/DELETE /grid-substations/{id}` | atomic | PUT = full replace, PATCH = partial, `If-Match` => 412 |
| `GET /grid-substations/{id}/installations` | scoped collection | admin `POST` registers an installation (201 + Location + one-time device secret) |
| `GET /installations` | collection | filters `province_id`, `district_id`, `substation_id`, `status`, `q`; sort; pagination |
| `GET/PUT/PATCH/DELETE /installations/{id}` | atomic | |
| `GET /installations/{id}/overview` | **composite** | installation + hierarchy + latest reading + today stats |
| `GET /installations/{id}/latest-reading` | **derived** (operational) | newest reading + freshness + utilisation |
| `GET /installations/{id}/readings` | scoped sub-collection (analytical) | pagination (count + next/prev), `from`/`to`, `sort=-timestamp` |
| `POST /installations/{id}/readings` | ingestion (device) | 201 + Location; identical retry 200; conflict 409 |
| `GET/DELETE /installations/{id}/readings/{rid}` | atomic | PUT/PATCH => 405 (append-only) |
| `GET /readings` | collection | cross-installation history filtered by province/district/substation/time |
| `GET /districts/{id}/generation-summary`, `/provinces/{id}/generation-summary` | **processing** | current kW, today's kWh, per-substation breakdown |
| `GET /users/me`; admin: `/users` CRUD | | |

Cross-cutting: one error schema `{error:{code,message,status,details[],path,timestamp,request_id}}`; `ETag` + `Last-Modified` + `304`; `406` for non-JSON `Accept`; `415`; `405` + `Allow`; rate limiting; Helmet; HTTPS enforcement in production.

## Project layout
```
src/server.js          start-up: migrate -> listen -> seed -> simulator
src/app.js             middleware pipeline, docs, health
src/schema.js          PostgreSQL schema
src/seed.js            reference data, users, installations, history
src/sim/               generator (diurnal model) + live simulator
src/routes/            tokens, hierarchy, installations, readings, summaries, users
src/middleware/auth.js JWT verification + scope checks
src/utils/             errors, validation, pagination/ETag helpers, jurisdiction scoping, serializers
src/docs/openapi.js    OpenAPI 3 document (served live)
scripts/smoke.js       end-to-end verification suite
docs/er-diagram.*      entity-relationship diagram
```
