#!/usr/bin/env node
/**
 * Submit the three camp-lifecycle reminder templates to Meta:
 *   camp_precheck_2d   — 2 days before, includes 48-hour prep list
 *   camp_day_of        — morning of camp, "we're open, come donate"
 *   camp_donor_thankyou — evening after camp, for donors who attended
 *
 * Each in EN / MR / HI (9 records total). All Utility category.
 *
 * Env vars (same as submit_donor_consent_template.js + V2 batch script):
 *   WHATSAPP_ACCESS_TOKEN, WHATSAPP_WABA_ID, WHATSAPP_API_VERSION.
 *
 * Usage:
 *   node scripts/submit_camp_reminder_templates.js
 *   node scripts/submit_camp_reminder_templates.js --dry-run
 *   node scripts/submit_camp_reminder_templates.js --only camp_precheck_2d
 *   node scripts/submit_camp_reminder_templates.js --lang en
 */
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
function argOf(flag) {
  const i = argv.indexOf(flag);
  return i === -1 || i + 1 >= argv.length ? null : argv[i + 1];
}
const ONLY = argOf('--only')
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
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
    console.error(`Missing env vars: ${missing.join(', ')}. Pass --dry-run to preview.`);
    process.exit(2);
  }
}

const FOOTER = 'Raktify · An initiative of Choudhari Foundation';
const BASE = 'https://raktify.choudhari.ngo';
// URL button uses a variable for the camp slug — the same URL pattern works
// for both precheck + day-of. Meta requires the variable to appear as {{1}}
// and an example URL be provided for review.
const CAMP_URL = `${BASE}/c/{{1}}`;
const CAMP_URL_EXAMPLE = `${BASE}/c/sample-camp-slug`;
// The thank-you button goes to /donor — variable substitution used
// (the app passes 'donor' as the variable) so Meta reviewer sees a
// dynamic pattern rather than a hardcoded URL.
const DASHBOARD_URL = `${BASE}/{{1}}`;
const DASHBOARD_URL_EXAMPLE = `${BASE}/donor`;

const TEMPLATES = [
  // ── camp_precheck_2d — 2 days before ─────────────────────────────────
  {
    name: 'camp_precheck_2d',
    category: 'UTILITY',
    language: 'en',
    body:
      `Hi *{{1}}*, your donation slot at *{{2}}* on *{{3}}* is 2 days away.\n\n` +
      `Please avoid alcohol for the next 48 hours, sleep at least 7 hours the night before, ` +
      `and drink plenty of water. Have a proper meal 2–3 hours before donating.`,
    body_example: ['Ramesh', 'Sangamtirth Blood Camp', '15 Aug, 09:00'],
    button_url: CAMP_URL,
    button_example: CAMP_URL_EXAMPLE,
    button_text: 'See camp details',
  },
  {
    name: 'camp_precheck_2d',
    category: 'UTILITY',
    language: 'mr',
    body:
      `नमस्कार *{{1}}*, *{{3}}* रोजी *{{2}}* येथे तुमची रक्तदान वेळ 2 दिवसांवर आली आहे.\n\n` +
      `पुढील 48 तासांत मद्यपान करू नका, आदल्या रात्री किमान 7 तास झोप घ्या आणि भरपूर पाणी प्या. ` +
      `रक्तदानाच्या 2-3 तास आधी नीट जेवण करा.`,
    body_example: ['रमेश', 'संगमतीर्थ रक्तदान शिबिर', '15 ऑगस्ट, 09:00'],
    button_url: CAMP_URL,
    button_example: CAMP_URL_EXAMPLE,
    button_text: 'तपशील पहा',
  },
  {
    name: 'camp_precheck_2d',
    category: 'UTILITY',
    language: 'hi',
    body:
      `नमस्ते *{{1}}*, *{{3}}* को *{{2}}* में आपका रक्तदान समय 2 दिन दूर है।\n\n` +
      `अगले 48 घंटों तक शराब न पिएं, रात को कम से कम 7 घंटे सोएं और भरपूर पानी पिएं। ` +
      `रक्तदान से 2-3 घंटे पहले भोजन कर लें।`,
    body_example: ['रमेश', 'संगमतीर्थ रक्तदान शिविर', '15 अगस्त, 09:00'],
    button_url: CAMP_URL,
    button_example: CAMP_URL_EXAMPLE,
    button_text: 'विवरण देखें',
  },

  // ── camp_day_of — morning of camp ─────────────────────────────────────
  {
    name: 'camp_day_of',
    category: 'UTILITY',
    language: 'en',
    body:
      `Hi *{{1}}*, *{{2}}* is open today from *{{3}}* at *{{4}}*.\n\n` +
      `Come donate and save a life. Bring a photo ID.`,
    body_example: [
      'Ramesh',
      'Sangamtirth Blood Camp',
      '09:00',
      'Choudhari Foundation Office, Amravati',
    ],
    button_url: CAMP_URL,
    button_example: CAMP_URL_EXAMPLE,
    button_text: 'Directions to venue',
  },
  {
    name: 'camp_day_of',
    category: 'UTILITY',
    language: 'mr',
    body:
      `नमस्कार *{{1}}*, *{{2}}* आज *{{3}}* पासून *{{4}}* येथे सुरू आहे.\n\n` +
      `येऊन रक्तदान करा आणि एक जीव वाचवा. फोटो ID सोबत आणा.`,
    body_example: [
      'रमेश',
      'संगमतीर्थ रक्तदान शिबिर',
      '09:00',
      'चौधरी फाउंडेशन कार्यालय, अमरावती',
    ],
    button_url: CAMP_URL,
    button_example: CAMP_URL_EXAMPLE,
    button_text: 'दिशानिर्देश',
  },
  {
    name: 'camp_day_of',
    category: 'UTILITY',
    language: 'hi',
    body:
      `नमस्ते *{{1}}*, *{{2}}* आज *{{3}}* से *{{4}}* पर खुला है।\n\n` +
      `आएं, रक्तदान करें और एक जीवन बचाएं। फोटो ID साथ लाएं।`,
    body_example: ['रमेश', 'संगमतीर्थ रक्तदान शिविर', '09:00', 'चौधरी फाउंडेशन कार्यालय, अमरावती'],
    button_url: CAMP_URL,
    button_example: CAMP_URL_EXAMPLE,
    button_text: 'दिशा-निर्देश',
  },

  // ── camp_donor_thankyou — evening after ──────────────────────────────
  {
    name: 'camp_donor_thankyou',
    category: 'UTILITY',
    language: 'en',
    body:
      `Thank you *{{1}}*, for donating at *{{2}}* today. Your donation can save up to 3 lives.\n\n` +
      `Your dashboard has your next-eligible date. We'll notify you when someone in your ` +
      `district needs your blood group.`,
    body_example: ['Ramesh', 'Sangamtirth Blood Camp'],
    button_url: DASHBOARD_URL,
    button_example: DASHBOARD_URL_EXAMPLE,
    button_text: 'View my dashboard',
  },
  {
    name: 'camp_donor_thankyou',
    category: 'UTILITY',
    language: 'mr',
    body:
      `धन्यवाद *{{1}}*, आज *{{2}}* येथे रक्तदान केल्याबद्दल. तुमचे दान 3 पर्यंत जीव वाचवू शकते.\n\n` +
      `तुमच्या डॅशबोर्डवर पुढील पात्र तारीख दिली आहे. तुमच्या जिल्ह्यात तुमच्या रक्तगटाची गरज असल्यास आम्ही कळवू.`,
    body_example: ['रमेश', 'संगमतीर्थ रक्तदान शिबिर'],
    button_url: DASHBOARD_URL,
    button_example: DASHBOARD_URL_EXAMPLE,
    button_text: 'माझे डॅशबोर्ड',
  },
  {
    name: 'camp_donor_thankyou',
    category: 'UTILITY',
    language: 'hi',
    body:
      `धन्यवाद *{{1}}*, आज *{{2}}* पर रक्तदान करने के लिए. आपका दान 3 जीवन तक बचा सकता है।\n\n` +
      `आपके डैशबोर्ड पर अगली पात्र तिथि है। जब आपके जिले में किसी को आपके रक्त समूह की ज़रूरत होगी, हम सूचित करेंगे।`,
    body_example: ['रमेश', 'संगमतीर्थ रक्तदान शिविर'],
    button_url: DASHBOARD_URL,
    button_example: DASHBOARD_URL_EXAMPLE,
    button_text: 'मेरा डैशबोर्ड',
  },
];

function buildPayload(t) {
  return {
    name: t.name,
    language: t.language,
    category: t.category,
    components: [
      { type: 'BODY', text: t.body, example: { body_text: [t.body_example] } },
      { type: 'FOOTER', text: FOOTER },
      {
        type: 'BUTTONS',
        buttons: [
          {
            type: 'URL',
            text: t.button_text,
            url: t.button_url,
            example: [t.button_example],
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
    (t) =>
      (!ONLY || ONLY.includes(t.name)) &&
      (!LANG_FILTER || LANG_FILTER.includes(t.language)),
  );
  console.log(`Submitting ${rows.length} template records${DRY_RUN ? ' (dry-run)' : ''}...\n`);
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
