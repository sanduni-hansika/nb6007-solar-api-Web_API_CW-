'use strict';
// Relational schema (PostgreSQL). Idempotent: safe to run on every start-up.
const { query } = require('./db');

const SQL = `
CREATE TABLE IF NOT EXISTS provinces (
  id          SERIAL PRIMARY KEY,
  code        VARCHAR(10)  NOT NULL UNIQUE,
  name        VARCHAR(100) NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS districts (
  id          SERIAL PRIMARY KEY,
  province_id INT NOT NULL REFERENCES provinces(id) ON DELETE RESTRICT,
  code        VARCHAR(10)  NOT NULL UNIQUE,
  name        VARCHAR(100) NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_districts_province ON districts(province_id);

CREATE TABLE IF NOT EXISTS grid_substations (
  id               SERIAL PRIMARY KEY,
  district_id      INT NOT NULL REFERENCES districts(id) ON DELETE RESTRICT,
  code             VARCHAR(30)  NOT NULL UNIQUE,
  name             VARCHAR(150) NOT NULL,
  voltage_level_kv NUMERIC(6,1) NOT NULL DEFAULT 33 CHECK (voltage_level_kv > 0),
  capacity_mva     NUMERIC(8,2) NOT NULL DEFAULT 31.5 CHECK (capacity_mva > 0),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_substations_district ON grid_substations(district_id);

-- The meter / inverter identifier is an ATTRIBUTE of the installation (meter_id), not a separate Device table.
CREATE TABLE IF NOT EXISTS solar_installations (
  id                    SERIAL PRIMARY KEY,
  substation_id         INT NOT NULL REFERENCES grid_substations(id) ON DELETE RESTRICT,
  meter_id              VARCHAR(40)  NOT NULL UNIQUE,
  site_name             VARCHAR(150) NOT NULL,
  installed_capacity_kw NUMERIC(8,2) NOT NULL CHECK (installed_capacity_kw > 0),
  latitude              NUMERIC(9,6),
  longitude             NUMERIC(9,6),
  status                VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','maintenance','decommissioned')),
  commissioned_on       DATE NOT NULL,
  device_secret_hash    CHAR(64) NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_installations_substation ON solar_installations(substation_id);

-- GenerationReading: its own APPEND-ONLY time series (never "last value" columns on the installation).
CREATE TABLE IF NOT EXISTS generation_readings (
  id              BIGSERIAL PRIMARY KEY,
  installation_id INT NOT NULL REFERENCES solar_installations(id) ON DELETE CASCADE,
  measured_at     TIMESTAMPTZ  NOT NULL,                 -- event time reported by the device
  power_kw        NUMERIC(8,3) NOT NULL CHECK (power_kw >= 0),
  energy_kwh      NUMERIC(12,3) NOT NULL CHECK (energy_kwh >= 0), -- cumulative meter register
  voltage_v       NUMERIC(6,2) NOT NULL CHECK (voltage_v >= 0),
  temperature_c   NUMERIC(4,1),                          -- optional inverter temperature
  received_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),   -- ingestion time (server)
  CONSTRAINT uq_reading_installation_time UNIQUE (installation_id, measured_at)
);
CREATE INDEX IF NOT EXISTS idx_readings_measured_at ON generation_readings(measured_at);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(100) NOT NULL,
  full_name     VARCHAR(150) NOT NULL,
  role          VARCHAR(20)  NOT NULL CHECK (role IN ('admin','national','provincial','district')),
  province_id   INT REFERENCES provinces(id) ON DELETE RESTRICT,
  district_id   INT REFERENCES districts(id) ON DELETE RESTRICT,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_user_jurisdiction CHECK (
    (role IN ('admin','national') AND province_id IS NULL AND district_id IS NULL) OR
    (role = 'provincial' AND province_id IS NOT NULL AND district_id IS NULL) OR
    (role = 'district'   AND district_id IS NOT NULL AND province_id IS NULL))
);
`;

async function migrate() {
  await query(SQL);
}
module.exports = { migrate };
