'use strict';
// Row -> JSON representation. Secrets (password_hash, device_secret_hash) never leave this layer.
const ts = (d) => (d instanceof Date ? d.toISOString() : d);

const province = (r) => ({ id: r.id, code: r.code, name: r.name });
const district = (r) => ({ id: r.id, code: r.code, name: r.name, province_id: r.province_id });
const substation = (r) => ({
  id: r.id, code: r.code, name: r.name, district_id: r.district_id, province_id: r.province_id,
  voltage_level_kv: r.voltage_level_kv, capacity_mva: r.capacity_mva, created_at: ts(r.created_at), updated_at: ts(r.updated_at),
});
const installation = (r) => ({
  id: r.id, meter_id: r.meter_id, site_name: r.site_name, installed_capacity_kw: r.installed_capacity_kw,
  latitude: r.latitude, longitude: r.longitude, status: r.status, commissioned_on: r.commissioned_on,
  substation_id: r.substation_id, district_id: r.district_id, province_id: r.province_id,
  created_at: ts(r.created_at), updated_at: ts(r.updated_at),
});
const reading = (r) => ({
  id: r.id, installation_id: r.installation_id, timestamp: ts(r.measured_at), power_kw: r.power_kw,
  energy_kwh: r.energy_kwh, voltage_v: r.voltage_v, temperature_c: r.temperature_c, received_at: ts(r.received_at),
});
const user = (r) => ({
  id: r.id, email: r.email, full_name: r.full_name, role: r.role, province_id: r.province_id ?? null,
  district_id: r.district_id ?? null, active: r.active, created_at: ts(r.created_at),
});

// Shared SELECT fragments
const SQL = {
  province: 'SELECT p.id, p.code, p.name, p.updated_at FROM provinces p',
  district: 'SELECT d.id, d.code, d.name, d.province_id, d.updated_at FROM districts d',
  substation: `SELECT s.id, s.code, s.name, s.district_id, d.province_id, s.voltage_level_kv, s.capacity_mva, s.created_at, s.updated_at
               FROM grid_substations s JOIN districts d ON d.id = s.district_id`,
  installationCols: `i.id, i.meter_id, i.site_name, i.installed_capacity_kw, i.latitude, i.longitude, i.status, i.commissioned_on,
                     i.substation_id, s.district_id, d.province_id, i.created_at, i.updated_at`,
  installationFrom: `FROM solar_installations i JOIN grid_substations s ON s.id = i.substation_id JOIN districts d ON d.id = s.district_id`,
  readingCols: 'r.id, r.installation_id, r.measured_at, r.power_kw, r.energy_kwh, r.voltage_v, r.temperature_c, r.received_at',
  readingFrom: `FROM generation_readings r JOIN solar_installations i ON i.id = r.installation_id
                JOIN grid_substations s ON s.id = i.substation_id JOIN districts d ON d.id = s.district_id`,
};
SQL.installation = `SELECT ${SQL.installationCols} ${SQL.installationFrom}`;

module.exports = { province, district, substation, installation, reading, user, SQL };
