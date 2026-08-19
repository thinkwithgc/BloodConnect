#!/usr/bin/env node
/**
 * One-off integration test for the Leegality sendForSign path.
 *
 * DORMANT as of Aug 2026. Institution MoUs are signed OFFLINE ON PAPER and
 * recorded via POST /onboarding/activate/:id — no route calls the eSign
 * provider today. This script and backend/src/services/esign/* are kept on
 * disk so eSign can be re-enabled later (activateInstitution() already accepts
 * signingMode:'ES'); nothing in the running app reaches them.
 *
 * Does NOT require any DB state, /admin login, or running backend. Calls
 * the Leegality v3.0 API directly using credentials sourced from env.
 * Pass test data via CLI flags; observe Leegality's response inline.
 *
 * Usage (from worktree root, with env loaded — typically `source ./azure-day1-output.env`
 * OR `set -a; source .env; set +a`):
 *
 *   LEEGALITY_AUTH_TOKEN=...  \
 *   LEEGALITY_PRIVATE_SALT=...  \
 *   LEEGALITY_TEMPLATE_ID=KH4DMOi  \
 *   LEEGALITY_BASE_URL=https://app1.leegality.com/api  \
 *   node scripts/test_leegality_send.js \
 *     --name "Gaurav Choudhari" \
 *     --phone "+919850541412" \
 *     --institution-name "Choudhari Foundation Test Hospital" \
 *     --institution-id "test-$(date +%s)"
 *
 * What you'll see if it works:
 *   • HTTP 200 + status=1 from Leegality
 *   • A `documentId` returned (the Leegality reference)
 *   • A `signUrl` returned (the per-invitee Aadhaar eSign URL)
 *   • The recipient phone receives a Leegality SMS with the same sign URL
 *
 * Completing the eSign on the phone is OPTIONAL — if you complete it,
 * Leegality will POST to the workflow's Webhook URL (must be configured
 * in dashboard first; see docs/sample-mou/README.md). If you ignore the
 * SMS, no webhook fires. Either path proves sendForSign works.
 */
const path = require('path');

// Allow this script to be run from anywhere — find the backend's pg/etc.
const backendDir = path.resolve(__dirname, '..', 'backend');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

// Tiny arg parser — no yargs dependency needed
function arg(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1];
}

const signatoryName = arg('--name', 'Test Signatory');
const signatoryPhone = arg('--phone', '+919850541412');
const institutionName = arg('--institution-name', 'Test Institution');
const institutionId = arg('--institution-id', `test-${Date.now()}`);

const requiredEnv = [
  'LEEGALITY_AUTH_TOKEN',
  'LEEGALITY_PRIVATE_SALT',
  'LEEGALITY_TEMPLATE_ID',
  'LEEGALITY_BASE_URL',
];
const missing = requiredEnv.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error('Missing required env: ' + missing.join(', '));
  console.error('Source ./azure-day1-output.env OR set them inline before running.');
  process.exit(1);
}

// Reuse the same provider the prod backend uses. Path-resolve into backend's
// node_modules so the require resolves env config + logger correctly.
process.chdir(backendDir);
const provider = require(path.resolve(backendDir, 'src/services/esign/leegalityProvider.js'));

(async () => {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' Leegality sendForSign integration test');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Provider     :', provider.providerName);
  console.log('  Base URL     :', process.env.LEEGALITY_BASE_URL);
  console.log('  Workflow ID  :', process.env.LEEGALITY_TEMPLATE_ID);
  console.log('  Auth token   :', process.env.LEEGALITY_AUTH_TOKEN.slice(0, 8) + '…');
  console.log('  Private salt :', process.env.LEEGALITY_PRIVATE_SALT.slice(0, 8) + '…');
  console.log('');
  console.log('  Signatory    :', signatoryName, '·', signatoryPhone);
  console.log('  Institution  :', institutionName, '·', institutionId);
  console.log('');

  // Same templateData shape the real /generate-mou route builds. Variable
  // names match what the Leegality template editor expects (see
  // docs/sample-mou/README.md table).
  const templateData = {
    institution_legal_name: institutionName,
    institution_type: 'Hospital',
    license_number: 'TEST-LIC-' + Date.now(),
    institution_address: '54, 2nd Lane, Rathi Nagar, VMV Road, Amravati 444603',
    district_name: 'Amravati',
    primary_contact_name: signatoryName,
    primary_contact_designation: 'Director',
    primary_contact_mobile: signatoryPhone,
    signatory_name: signatoryName,
    signatory_designation: 'Authorised Signatory',
    signing_date: new Date().toISOString().slice(0, 10),
    effective_until_date: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    mou_version: '1',
  };

  console.log('  templateData : { ' + Object.keys(templateData).join(', ') + ' }');
  console.log('');
  console.log('▸ Calling Leegality v3.0 /sign/request …');
  console.log('');

  try {
    const result = await provider.sendForSign({
      institutionId,
      signatoryMobile: signatoryPhone,
      signatoryName,
      templateData,
    });

    console.log('✓ Leegality accepted the request:');
    console.log('  documentId : ' + result.docId);
    console.log('  signUrl    : ' + result.signUrl);
    console.log('  expiresAt  : ' + result.expiresAt);
    console.log('');
    console.log('Next:');
    console.log('  • Check ' + signatoryPhone + ' for the Leegality eSign SMS.');
    console.log('  • Tap the link → complete Aadhaar eSign → Leegality fires webhook.');
    console.log('  • Webhook lands at the URL you configured on the workflow');
    console.log('    (https://raktify-api.azurewebsites.net/onboarding/mou-signed).');
    console.log('  • If webhook not configured in dashboard, signing still works but');
    console.log('    no backend follow-up fires — institution stays in VE state.');
  } catch (err) {
    console.error('✗ Leegality rejected the request:');
    console.error('  ' + err.message);
    console.error('');
    console.error('Common causes:');
    console.error('  • LEEGALITY_TEMPLATE_ID is not a published Workflow ID');
    console.error('  • Workflow not configured for Aadhaar eSign');
    console.error('  • Variable names in templateData don\'t match the template\'s field names');
    console.error('  • Whitelisted IPs configured in Leegality dashboard, this IP not on the list');
    process.exit(1);
  }
})();
