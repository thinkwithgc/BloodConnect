#!/usr/bin/env node
/**
 * Submit the `donor_consent_invite` WhatsApp template to Meta for review.
 *
 * Fired by the /webhooks/v1/donor-registration handler when a vendor
 * (Safetrans / Strides) pushes a new donor into Raktify. The template asks
 * the donor to accept, decline, or defer on Raktify's own /consent/:token
 * screen — the DPDP §7 legal-basis hook.
 *
 * Meta submissions:
 *   POST https://graph.facebook.com/<version>/<waba_id>/message_templates
 *
 * Env vars:
 *   WHATSAPP_ACCESS_TOKEN   System User token with whatsapp_business_management
 *   WHATSAPP_WABA_ID        Business Account ID
 *   WHATSAPP_API_VERSION    optional, default v21.0
 *
 * Usage:
 *   node scripts/submit_donor_consent_template.js                # all 3 langs
 *   node scripts/submit_donor_consent_template.js --dry-run      # print only
 *   node scripts/submit_donor_consent_template.js --lang en      # subset
 *
 * Each language is submitted as its own record. Approval is async — check
 * WhatsApp Manager → Message templates for the final state.
 */
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
function argOf(flag) {
  const i = argv.indexOf(flag);
  return i === -1 || i + 1 >= argv.length ? null : argv[i + 1];
}
const LANG_FILTER = argOf('--lang')
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const {
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_WABA_ID,
  WHATSAPP_API_VERSION = 'v21.0',
} = process.env;

if (!DRY_RUN) {
  const missing = [];
  if (!WHATSAPP_ACCESS_TOKEN) missing.push('WHATSAPP_ACCESS_TOKEN');
  if (!WHATSAPP_WABA_ID) missing.push('WHATSAPP_WABA_ID');
  if (missing.length) {
    console.error(
      `Missing env vars: ${missing.join(', ')}.\n` +
        `Fetch from Key Vault or export before running. Pass --dry-run to preview.`,
    );
    process.exit(2);
  }
}

const FOOTER = 'Raktify · An initiative of Choudhari Foundation';
const BASE_URL = 'https://raktify.choudhari.ngo';
const BUTTON_URL = `${BASE_URL}/consent/{{1}}`;
const BUTTON_EXAMPLE = `${BASE_URL}/consent/sample-consent-token-goes-here`;

// One record per language. Wording kept transactional (no promotional lift)
// so Meta's Utility classifier doesn't flip us to MARKETING. Structure
// mirrors the other Utility templates already approved for the account.
const TEMPLATES = [
  {
    name: 'donor_consent_invite',
    category: 'UTILITY',
    language: 'en',
    body:
      `Hi *{{1}}*, {{2}} has shared your donor registration with Raktify. ` +
      `Tap below to review the details on Raktify's site and confirm — or decline anytime.`,
    body_example: ['Ramesh', 'Sangamtirth Blood Bank'],
    button_text: 'Review and confirm',
  },
  {
    name: 'donor_consent_invite',
    category: 'UTILITY',
    language: 'mr',
    body:
      `नमस्कार *{{1}}*, {{2}} ने तुमची रक्तदाता नोंदणी Raktify सोबत सामायिक केली आहे. ` +
      `तपशील पाहण्यासाठी आणि पुष्टी करण्यासाठी खाली टॅप करा — किंवा कधीही नकार द्या.`,
    body_example: ['रमेश', 'संगमतीर्थ रक्तपेढी'],
    button_text: 'तपशील पहा',
  },
  {
    name: 'donor_consent_invite',
    category: 'UTILITY',
    language: 'hi',
    body:
      `नमस्ते *{{1}}*, {{2}} ने आपकी रक्तदाता पंजीकरण Raktify के साथ साझा किया है। ` +
      `विवरण देखने और पुष्टि करने के लिए नीचे टैप करें — या कभी भी अस्वीकार करें।`,
    body_example: ['रमेश', 'संगमतीर्थ ब्लड बैंक'],
    button_text: 'विवरण देखें',
  },
];

function buildPayload(t) {
  return {
    name: t.name,
    language: t.language,
    category: t.category,
    components: [
      {
        type: 'BODY',
        text: t.body,
        example: { body_text: [t.body_example] },
      },
      { type: 'FOOTER', text: FOOTER },
      {
        type: 'BUTTONS',
        buttons: [
          {
            type: 'URL',
            text: t.button_text,
            url: BUTTON_URL,
            example: [BUTTON_EXAMPLE],
          },
        ],
      },
    ],
  };
}

async function submit(t) {
  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_WABA_ID}/message_templates`;
  const payload = buildPayload(t);
  if (DRY_RUN) {
    console.log(`— DRY-RUN — ${t.name} (${t.language})`);
    console.log(JSON.stringify(payload, null, 2));
    return { ok: true, dry: true };
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body: json };
}

(async () => {
  const rows = TEMPLATES.filter(
    (t) => !LANG_FILTER || LANG_FILTER.includes(t.language),
  );
  console.log(
    `Submitting ${rows.length} donor_consent_invite record(s)${DRY_RUN ? ' (dry-run)' : ''}...\n`,
  );
  let failed = 0;
  for (const t of rows) {
    process.stdout.write(`  → ${t.name} (${t.language}) `);
    try {
      const r = await submit(t);
      if (r.ok) {
        const status = r.body?.status || 'submitted';
        const id = r.body?.id || '';
        console.log(r.dry ? '(dry-run)' : `✓ ${status}${id ? ` id=${id}` : ''}`);
      } else {
        console.log(`✗ HTTP ${r.status}: ${r.body?.error?.message || 'unknown'}`);
        if (r.body?.error?.error_user_msg) {
          console.log(`    user-msg: ${r.body.error.error_user_msg}`);
        }
        failed++;
      }
    } catch (err) {
      console.log(`✗ threw: ${err.message}`);
      failed++;
    }
  }
  console.log(`\nDone. ${rows.length - failed}/${rows.length} succeeded.`);
  process.exit(failed);
})();
