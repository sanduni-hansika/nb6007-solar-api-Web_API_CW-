'use strict';
// Usage: npm run device-secret -- SLSEA-MTR-0001   (prints the demo device secret for a SEEDED meter)
const { deviceSecretFor } = require('../utils/security');
const id = process.argv[2];
if (!id) { console.error('Usage: npm run device-secret -- <meter_id>'); process.exit(1); }
console.log(deviceSecretFor(id));
