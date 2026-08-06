#!/usr/bin/env node
/**
 * vendor_push_simulator.js — pretends to be a BB software vendor (Strides,
 * etc.) pushing donor or donation events to the /webhooks/v1/* endpoints.
 * Signs the raw body with HMAC-SHA256 using the partner secret and posts it.
 *
 * Usage:
 *   node scripts/vendor_push_simulator.js donor    [flags]
 *   node scripts/vendor_push_simulator.js donation [flags]
 *
 * Required flags:
 *   --partner-key pk_...              from seed_dev_vendor.js
 *   --secret <base64url>              from seed_dev_vendor.js (plaintext)
 *
 * Optional flags:
 *   --base-url http://localhost:3000  default (or set RAKTIFY_API_URL)
 *   --mobile +919876543210            override the default random mobile
 *   --payload path/to/payload.json    supply a full payload file
 *                                     (bypasses the built-in sample)
 *   --repeat                          send twice (test idempotency)
 *
 * Exits 0 on 202, 1 otherwise.
 *
 * No production dependencies beyond Node's built-in http/https + crypto —
 * this is meant to be portable enough that a vendor can copy it into their
 * own codebase in any language and reproduce.
 */
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  const v = process.argv[idx + 1];
  return v && !v.startsWith('--') ? v : true;
}

function fail(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

const endpoint = process.argv[2];
if (!endpoint || !['donor', 'donation'].includes(endpoint)) {
  fail('Usage: node scripts/vendor_push_simulator.js <donor|donation> [flags]', 2);
}

const partnerKey = arg('--partner-key') || process.env.RAKTIFY_PARTNER_KEY;
const secret = arg('--secret') || process.env.RAKTIFY_PARTNER_SECRET;
if (!partnerKey) fail('Missing --partner-key (or RAKTIFY_PARTNER_KEY env)', 2);
if (!secret) fail('Missing --secret (or RAKTIFY_PARTNER_SECRET env)', 2);

const baseUrl = arg('--base-url') || process.env.RAKTIFY_API_URL || 'http://localhost:3000';
const overrideMobile = arg('--mobile');
const payloadPath = arg('--payload');
const repeat = process.argv.includes('--repeat');

function randomMobile() {
  const prefix = '+91' + (Math.floor(Math.random() * 4) + 6); // 6-9 leading
  let rest = '';
  for (let i = 0; i < 9; i += 1) rest += Math.floor(Math.random() * 10);
  return prefix + rest;
}

function buildPayload() {
  if (payloadPath) {
    return JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
  }
  const eventTime = new Date().toISOString();
  const vendorEventId = 'sim_' + crypto.randomBytes(8).toString('hex');
  if (endpoint === 'donor') {
    return {
      vendor_event_id: vendorEventId,
      event_time: eventTime,
      mobile: overrideMobile || randomMobile(),
      full_name: 'Test Donor ' + crypto.randomBytes(2).toString('hex'),
      date_of_birth: '1995-06-15',
      gender: 'M',
      blood_group: 'A+',
      pincode: '444601',
      preferred_language: 'mr',
      consent_captured_at: eventTime,
    };
  }
  // donation
  return {
    vendor_event_id: vendorEventId,
    event_time: eventTime,
    donor_mobile: overrideMobile || fail('Provide --mobile for a donation event (donor must exist first)', 2),
    collection_date: new Date().toISOString().slice(0, 10),
    component_code: 'WB',
    volume_ml: 350,
    isbt_barcode: 'W' + Date.now().toString().slice(-9),
    hb_gdl: 13.5,
  };
}

function send(payloadObj) {
  return new Promise((resolve, reject) => {
    const bodyRaw = Buffer.from(JSON.stringify(payloadObj), 'utf8');
    const sig = crypto.createHmac('sha256', secret).update(bodyRaw).digest('hex');

    const parsed = url.parse(baseUrl);
    const client = parsed.protocol === 'https:' ? https : http;
    const path =
      (parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '') +
      (endpoint === 'donor' ? '/webhooks/v1/donor-registration' : '/webhooks/v1/donation');

    const req = client.request(
      {
        method: 'POST',
        host: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': bodyRaw.length,
          'X-Raktify-Partner-Key': partnerKey,
          'X-Raktify-Signature': 'sha256=' + sig,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            /* text response, leave json null */
          }
          resolve({ status: res.statusCode, body: json ?? text });
        });
      },
    );
    req.on('error', reject);
    req.write(bodyRaw);
    req.end();
  });
}

(async () => {
  const payload = buildPayload();
  console.log('POST', baseUrl + '/webhooks/v1/' + (endpoint === 'donor' ? 'donor-registration' : 'donation'));
  console.log('  vendor_event_id:', payload.vendor_event_id);
  if (endpoint === 'donor') console.log('  mobile:', payload.mobile);
  else console.log('  donor_mobile:', payload.donor_mobile);

  const r1 = await send(payload);
  console.log(`  → ${r1.status}`, JSON.stringify(r1.body, null, 2));

  if (repeat) {
    console.log('\n[--repeat] sending the SAME vendor_event_id again to test idempotency...');
    const r2 = await send(payload);
    console.log(`  → ${r2.status}`, JSON.stringify(r2.body, null, 2));
    if (r2.body && r2.body.idempotent_replay) {
      console.log('  ✓ Idempotency replay confirmed.');
    } else {
      console.log('  ✗ Expected idempotent_replay=true on second send.');
    }
  }

  process.exit(r1.status >= 200 && r1.status < 300 ? 0 : 1);
})().catch((err) => {
  console.error('simulator error:', err.message);
  process.exit(1);
});
