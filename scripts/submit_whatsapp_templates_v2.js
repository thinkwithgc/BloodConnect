#!/usr/bin/env node
/**
 * Submit the V2 donor-alert-gate WhatsApp templates to Meta for review.
 *
 * Uses the Meta Graph API:
 *   POST https://graph.facebook.com/<version>/<waba_id>/message_templates
 *
 * Reads creds from process.env:
 *   WHATSAPP_ACCESS_TOKEN   (System User token with whatsapp_business_management)
 *   WHATSAPP_WABA_ID        (WhatsApp Business Account id)
 *   WHATSAPP_API_VERSION    (optional, default v21.0)
 *
 * Also honours .env via dotenv (same file the backend reads).
 *
 * Usage:
 *   # Submit ALL 15 template records (7 templates x 3 langs for donor/leader
 *   # templates, 1 lang for BB/coord templates):
 *   node scripts/submit_whatsapp_templates_v2.js
 *
 *   # Dry-run: print the payloads without POSTing
 *   node scripts/submit_whatsapp_templates_v2.js --dry-run
 *
 *   # Submit a subset by name (comma-separated, matches Meta template name)
 *   node scripts/submit_whatsapp_templates_v2.js --only donor_alert_bb_routed,bb_donor_incoming
 *
 *   # Submit only specific languages (default: all supported for each template)
 *   node scripts/submit_whatsapp_templates_v2.js --lang en
 *
 * On success each submission returns Meta's { id, status } — Meta typically
 * queues them in APPROVED / PENDING / REJECTED asynchronously; check
 * WhatsApp Manager → Message templates for the final state.
 *
 * Behaviour on individual failure: prints the error and keeps going with the
 * next template. Exit code = number of failures.
 */
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
function argOf(flag) {
  const i = argv.indexOf(flag);
  return i === -1 || i + 1 >= argv.length ? null : argv[i + 1];
}
const ONLY = argOf('--only')?.split(',').map((s) => s.trim()).filter(Boolean);
const LANG_FILTER = argOf('--lang')?.split(',').map((s) => s.trim()).filter(Boolean);

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
        `Add them to .env (or export before running).\n` +
        `Pass --dry-run to print payloads without POSTing.`,
    );
    process.exit(2);
  }
}

const FOOTER_RAKTIFY = 'Raktify · An initiative of Choudhari Foundation';
const FOOTER_LEADER = 'Raktify · Community leader alert · choudhari.ngo';
const FOOTER_COORD = 'Raktify · Coordinator alert · choudhari.ngo';
const FOOTER_BB = 'Raktify · Blood bank alert · choudhari.ngo';
const FOOTER_ORGANIZER = 'Raktify · Camp organizer alert · choudhari.ngo';
const ACTIVATION_BASE = 'https://raktify.choudhari.ngo';

// One entry per template + language variant. Meta submits each language as
// its own record. `example` values are what Meta shows during review — use
// realistic-but-fake data.
const TEMPLATES = [
  // ── 8. donor_alert_bb_routed (EN/MR/HI) ────────────────────────────────
  {
    name: 'donor_alert_bb_routed',
    category: 'UTILITY',
    language: 'en',
    body: `A patient needs *{{1}}* blood at *{{2}}* today. That's about *{{3}} km* from you.\n\nTap below to confirm you can donate. If you can't, please tap 'not this time' so we can find someone else.`,
    body_example: ['B- PRBC', 'Dr. Panjabrao Deshmukh BB, Amravati', '4'],
    footer: FOOTER_RAKTIFY,
    button_url: `${ACTIVATION_BASE}/alert/{{1}}`,
    button_example: `${ACTIVATION_BASE}/alert/sample-jwt-token-here`,
    button_text: 'Confirm you can donate',
  },
  {
    name: 'donor_alert_bb_routed',
    category: 'UTILITY',
    language: 'mr',
    body: `आज एका रुग्णाला *{{2}}* येथे *{{1}}* रक्ताची गरज आहे. तुमच्यापासून सुमारे *{{3}} किमी*.\n\nरक्तदान करू शकत असल्यास खाली टॅप करा. जमत नसल्यास 'यावेळी नाही' दाबा जेणेकरून आम्ही दुसरा दाता शोधू.`,
    body_example: ['B- PRBC', 'डॉ. पंजाबराव देशमुख रक्तपेढी, अमरावती', '4'],
    footer: FOOTER_RAKTIFY,
    button_url: `${ACTIVATION_BASE}/alert/{{1}}`,
    button_example: `${ACTIVATION_BASE}/alert/sample-jwt-token-here`,
    button_text: 'रक्तदान करा',
  },
  {
    name: 'donor_alert_bb_routed',
    category: 'UTILITY',
    language: 'hi',
    body: `आज एक मरीज़ को *{{2}}* पर *{{1}}* रक्त की आवश्यकता है। आपसे लगभग *{{3}} किमी* दूर।\n\nरक्तदान कर सकते हैं तो नीचे टैप करें। नहीं कर सकते तो 'इस बार नहीं' दबाएँ ताकि हम दूसरा दाता ढूँढ सकें।`,
    body_example: ['B- PRBC', 'डॉ. पंजाबराव देशमुख ब्लड बैंक, अमरावती', '4'],
    footer: FOOTER_RAKTIFY,
    button_url: `${ACTIVATION_BASE}/alert/{{1}}`,
    button_example: `${ACTIVATION_BASE}/alert/sample-jwt-token-here`,
    button_text: 'रक्तदान करें',
  },

  // ── 9. donor_alert_replacement (EN/MR/HI) ──────────────────────────────
  {
    name: 'donor_alert_replacement',
    category: 'UTILITY',
    language: 'en',
    body: `Hi *{{1}}*, a patient at *{{2}}* has received *{{3}}* today. The blood bank asks for a replacement donation to keep stock balanced within *{{4}}*.\n\nTap below to confirm. Your donation replaces the unit and keeps supply stable for the next patient.`,
    body_example: ['Ramesh', 'Irwin Hospital BB, Amravati', '1 unit of B- PRBC', '72 hours'],
    footer: FOOTER_RAKTIFY,
    button_url: `${ACTIVATION_BASE}/alert/{{1}}`,
    button_example: `${ACTIVATION_BASE}/alert/sample-repl-token`,
    // 19 chars. Meta caps URL-button text at 25 and the original
    // 'Confirm replacement donation' was 28 - a silent rejection cause.
    button_text: 'Confirm replacement',
  },
  {
    name: 'donor_alert_replacement',
    category: 'UTILITY',
    language: 'mr',
    body: `नमस्कार *{{1}}*, आज *{{2}}* येथील एका रुग्णाला *{{3}}* देण्यात आले आहे. रक्तपेढी *{{4}}* च्या आत बदली रक्तदान मागत आहे.\n\nपुष्टी करण्यासाठी खाली टॅप करा. तुमचे दान त्या युनिटची पूर्तता करते आणि पुरवठा स्थिर ठेवते.`,
    body_example: ['रमेश', 'इर्विन हॉस्पिटल रक्तपेढी, अमरावती', 'B- PRBC चा 1 युनिट', '72 तास'],
    footer: FOOTER_RAKTIFY,
    button_url: `${ACTIVATION_BASE}/alert/{{1}}`,
    button_example: `${ACTIVATION_BASE}/alert/sample-repl-token`,
    button_text: 'बदली दान करा',
  },
  {
    name: 'donor_alert_replacement',
    category: 'UTILITY',
    language: 'hi',
    body: `नमस्ते *{{1}}*, आज *{{2}}* के एक मरीज़ को *{{3}}* दिया गया है। ब्लड बैंक *{{4}}* के भीतर प्रतिस्थापन दान की ज़रूरत बता रहा है।\n\nपुष्टि करने के लिए नीचे टैप करें। आपका दान उस यूनिट की भरपाई करता है और अगले मरीज़ के लिए आपूर्ति स्थिर रखता है।`,
    body_example: ['रमेश', 'इर्विन हॉस्पिटल ब्लड बैंक, अमरावती', 'B- PRBC की 1 यूनिट', '72 घंटे'],
    footer: FOOTER_RAKTIFY,
    button_url: `${ACTIVATION_BASE}/alert/{{1}}`,
    button_example: `${ACTIVATION_BASE}/alert/sample-repl-token`,
    button_text: 'प्रतिस्थापन दान',
  },

  // ── 10. donor_alert_community_first (EN/MR/HI) ─────────────────────────
  {
    name: 'donor_alert_community_first',
    category: 'UTILITY',
    language: 'en',
    body: `Hi *{{1}}*, your community leader *{{2}}* is looking for *{{3}}* donors for a patient in *{{4}}* today.\n\nTap below to confirm you can donate. This alert is going to your community first — before Raktify widens the search.`,
    body_example: ['Ramesh', 'Anita Kale', 'O+ PRBC', 'Amravati Rural'],
    footer: FOOTER_LEADER,
    button_url: `${ACTIVATION_BASE}/alert/{{1}}`,
    button_example: `${ACTIVATION_BASE}/alert/sample-comm-token`,
    button_text: 'Confirm you can donate',
  },
  {
    name: 'donor_alert_community_first',
    category: 'UTILITY',
    language: 'mr',
    body: `नमस्कार *{{1}}*, आज *{{4}}* मधील एका रुग्णासाठी तुमचे कम्युनिटी लीडर *{{2}}* *{{3}}* दात्यांचा शोध घेत आहेत.\n\nरक्तदान करू शकत असल्यास खाली टॅप करा. हा अलर्ट प्रथम तुमच्या कम्युनिटीला जात आहे — त्यानंतर Raktify शोध विस्तृत करेल.`,
    body_example: ['रमेश', 'अनिता काळे', 'O+ PRBC', 'अमरावती ग्रामीण'],
    footer: FOOTER_LEADER,
    button_url: `${ACTIVATION_BASE}/alert/{{1}}`,
    button_example: `${ACTIVATION_BASE}/alert/sample-comm-token`,
    button_text: 'रक्तदान करा',
  },
  {
    name: 'donor_alert_community_first',
    category: 'UTILITY',
    language: 'hi',
    body: `नमस्ते *{{1}}*, आज *{{4}}* के एक मरीज़ के लिए आपके कम्युनिटी लीडर *{{2}}* *{{3}}* दाताओं की तलाश में हैं।\n\nरक्तदान कर सकते हैं तो नीचे टैप करें। यह अलर्ट पहले आपकी कम्युनिटी को जा रहा है — उसके बाद Raktify खोज बढ़ाएगा।`,
    body_example: ['रमेश', 'अनीता काले', 'O+ PRBC', 'अमरावती ग्रामीण'],
    footer: FOOTER_LEADER,
    button_url: `${ACTIVATION_BASE}/alert/{{1}}`,
    button_example: `${ACTIVATION_BASE}/alert/sample-comm-token`,
    button_text: 'रक्तदान करें',
  },

  // ── 11. bb_donor_incoming (EN/MR/HI) ─────────────────────────────────
  {
    name: 'bb_donor_incoming',
    category: 'UTILITY',
    language: 'en',
    body: `A donor has accepted an alert and is coming to your bank.\n\nDonor: *{{1}}* ({{2}})\nFor: *{{3}}*\nExpected arrival: *{{4}}*\n\nOpen the Incoming Donors tab to review, mark arrived, or defer.`,
    body_example: ['Ramesh Patil', 'B-', 'REQ-A7X9', 'within 2 hours'],
    footer: FOOTER_BB,
    button_url: `${ACTIVATION_BASE}/bb?tab=incoming&donor={{1}}`,
    button_example: `${ACTIVATION_BASE}/bb?tab=incoming&donor=sample-donor-id`,
    button_text: 'Open Incoming Donors',
  },
  {
    name: 'bb_donor_incoming',
    category: 'UTILITY',
    language: 'mr',
    body: `एका दात्याने अलर्ट स्वीकारला आहे आणि तो तुमच्या रक्तपेढीत येत आहे.

दाता: *{{1}}* ({{2}})
कारण: *{{3}}*
अपेक्षित आगमन: *{{4}}*

तपासणी, आगमन नोंद किंवा स्थगिती यासाठी Incoming Donors टॅब उघडा.`,
    body_example: ['रमेश पाटील', 'B-', 'REQ-A7X9', '२ तासांत'],
    footer: FOOTER_BB,
    button_url: `${ACTIVATION_BASE}/bb?tab=incoming&donor={{1}}`,
    button_example: `${ACTIVATION_BASE}/bb?tab=incoming&donor=sample-donor-id`,
    button_text: 'येणारे दाते',
  },
  {
    name: 'bb_donor_incoming',
    category: 'UTILITY',
    language: 'hi',
    body: `एक दाता ने अलर्ट स्वीकार किया है और वह आपके ब्लड बैंक आ रहा है.

दाता: *{{1}}* ({{2}})
के लिए: *{{3}}*
अपेक्षित आगमन: *{{4}}*

समीक्षा, आगमन दर्ज करने या स्थगित करने के लिए Incoming Donors टैब खोलें.`,
    body_example: ['रमेश पाटील', 'B-', 'REQ-A7X9', '२ घंटे में'],
    footer: FOOTER_BB,
    button_url: `${ACTIVATION_BASE}/bb?tab=incoming&donor={{1}}`,
    button_example: `${ACTIVATION_BASE}/bb?tab=incoming&donor=sample-donor-id`,
    button_text: 'आने वाले दाता',
  },

  // ── 12. coord_prefire_warning (EN/MR/HI) ─────────────────────────────
  {
    name: 'coord_prefire_warning',
    category: 'UTILITY',
    language: 'en',
    body: `Alerts for request *{{1}}* ({{2}}) will fire to donors in *{{3}}*.\n\nIf a BB has quietly committed inventory, hold the alert. Otherwise let it fire.\n\nTap below to review or hold.`,
    body_example: ['REQ-A7X9', '2 units O- PRBC', '15 minutes'],
    footer: FOOTER_COORD,
    button_url: `${ACTIVATION_BASE}/coordinator/requests/{{1}}`,
    button_example: `${ACTIVATION_BASE}/coordinator/requests/sample-request-id`,
    button_text: 'Review request',
  },
  {
    name: 'coord_prefire_warning',
    category: 'UTILITY',
    language: 'mr',
    body: `विनंती *{{1}}* ({{2}}) साठी दात्यांना अलर्ट *{{3}}* मध्ये जाणार आहेत.

एखाद्या रक्तपेढीने न सांगता साठा राखून ठेवला असेल तर अलर्ट थांबवा. अन्यथा जाऊ द्या.

तपासण्यासाठी किंवा थांबवण्यासाठी खाली टॅप करा.`,
    body_example: ['REQ-A7X9', 'O- PRBC २ युनिट', '१५ मिनिटे'],
    footer: FOOTER_COORD,
    button_url: `${ACTIVATION_BASE}/coordinator/requests/{{1}}`,
    button_example: `${ACTIVATION_BASE}/coordinator/requests/sample-request-id`,
    button_text: 'विनंती पहा',
  },
  {
    name: 'coord_prefire_warning',
    category: 'UTILITY',
    language: 'hi',
    body: `अनुरोध *{{1}}* ({{2}}) के लिए दाताओं को अलर्ट *{{3}}* में भेजे जाएंगे.

यदि किसी ब्लड बैंक ने बिना बताए स्टॉक आरक्षित कर लिया है तो अलर्ट रोकें. अन्यथा जाने दें.

समीक्षा करने या रोकने के लिए नीचे टैप करें.`,
    body_example: ['REQ-A7X9', 'O- PRBC २ यूनिट', '१५ मिनट'],
    footer: FOOTER_COORD,
    button_url: `${ACTIVATION_BASE}/coordinator/requests/{{1}}`,
    button_example: `${ACTIVATION_BASE}/coordinator/requests/sample-request-id`,
    button_text: 'अनुरोध देखें',
  },

  // ── 13. coord_critical_new (EN/MR/HI) ────────────────────────────────
  {
    name: 'coord_critical_new',
    category: 'UTILITY',
    language: 'en',
    body: `New critical request in *{{1}}*.\n\nNeeds: *{{2}}* by *{{3}}*\nFrom: *{{4}}*\n\nTap to review. Matching engine is running — you can override, cancel, or hand-place inventory now.`,
    body_example: ['Amravati', '3 units B- PRBC', '18:00 today', 'Government General Hospital, Amravati'],
    footer: FOOTER_COORD,
    button_url: `${ACTIVATION_BASE}/coordinator/requests/{{1}}`,
    button_example: `${ACTIVATION_BASE}/coordinator/requests/sample-request-id`,
    button_text: 'Review request',
  },
  {
    name: 'coord_critical_new',
    category: 'UTILITY',
    language: 'mr',
    body: `*{{1}}* मध्ये नवीन क्रिटिकल विनंती.

गरज: *{{2}}* — *{{3}}* पर्यंत
कडून: *{{4}}*

तपासण्यासाठी टॅप करा. मॅचिंग सुरू आहे — तुम्ही ओव्हरराइड करू शकता, रद्द करू शकता किंवा साठा स्वतः नेमू शकता.`,
    body_example: ['अमरावती', 'B- PRBC ३ युनिट', 'आज १८:००', 'शासकीय सर्वोपचार रुग्णालय, अमरावती'],
    footer: FOOTER_COORD,
    button_url: `${ACTIVATION_BASE}/coordinator/requests/{{1}}`,
    button_example: `${ACTIVATION_BASE}/coordinator/requests/sample-request-id`,
    button_text: 'विनंती पहा',
  },
  {
    name: 'coord_critical_new',
    category: 'UTILITY',
    language: 'hi',
    body: `*{{1}}* में नया क्रिटिकल अनुरोध.

आवश्यकता: *{{2}}* — *{{3}}* तक
से: *{{4}}*

समीक्षा के लिए टैप करें. मैचिंग इंजन चल रहा है — आप ओवरराइड कर सकते हैं, रद्द कर सकते हैं या स्टॉक स्वयं निर्धारित कर सकते हैं.`,
    body_example: ['अमरावती', 'B- PRBC ३ यूनिट', 'आज १८:००', 'शासकीय सर्वोपचार अस्पताल, अमरावती'],
    footer: FOOTER_COORD,
    button_url: `${ACTIVATION_BASE}/coordinator/requests/{{1}}`,
    button_example: `${ACTIVATION_BASE}/coordinator/requests/sample-request-id`,
    button_text: 'अनुरोध देखें',
  },

  // ── 14. community_leader_mobilise (EN/MR/HI) ───────────────────────────
  {
    name: 'community_leader_mobilise',
    category: 'UTILITY',
    language: 'en',
    body: `Hi *{{1}}*, a patient in *{{2}}* urgently needs *{{3}}*.\n\nTap below to see the shareable poster + WhatsApp text — takes one tap to forward to your community group. Raktify won't message your community members directly.`,
    body_example: ['Anita', 'Achalpur', 'O+ PRBC, 2 units'],
    footer: FOOTER_LEADER,
    button_url: `${ACTIVATION_BASE}/community-leader/mobilise/{{1}}`,
    button_example: `${ACTIVATION_BASE}/community-leader/mobilise/sample-token`,
    button_text: 'See share toolkit',
  },
  {
    name: 'community_leader_mobilise',
    category: 'UTILITY',
    language: 'mr',
    body: `नमस्कार *{{1}}*, *{{2}}* मधील एका रुग्णाला *{{3}}* ची तातडीने गरज आहे.\n\nपोस्टर आणि व्हॉट्सअॅप मजकूर पाहण्यासाठी खाली टॅप करा — तुमच्या कम्युनिटी ग्रुपला एका टॅपमध्ये फॉरवर्ड करा. Raktify तुमच्या कम्युनिटी सदस्यांना थेट संदेश पाठवणार नाही.`,
    body_example: ['अनिता', 'अचलपूर', 'O+ PRBC, 2 युनिट'],
    footer: FOOTER_LEADER,
    button_url: `${ACTIVATION_BASE}/community-leader/mobilise/{{1}}`,
    button_example: `${ACTIVATION_BASE}/community-leader/mobilise/sample-token`,
    button_text: 'शेअर टूलकिट',
  },
  {
    name: 'community_leader_mobilise',
    category: 'UTILITY',
    language: 'hi',
    body: `नमस्ते *{{1}}*, *{{2}}* के एक मरीज़ को *{{3}}* की तत्काल आवश्यकता है।\n\nपोस्टर और व्हाट्सएप टेक्स्ट देखने के लिए नीचे टैप करें — एक टैप से अपने कम्युनिटी ग्रुप में फॉरवर्ड करें। Raktify आपके कम्युनिटी सदस्यों को सीधे संदेश नहीं भेजेगा।`,
    body_example: ['अनीता', 'अचलपुर', 'O+ PRBC, 2 यूनिट'],
    footer: FOOTER_LEADER,
    button_url: `${ACTIVATION_BASE}/community-leader/mobilise/{{1}}`,
    button_example: `${ACTIVATION_BASE}/community-leader/mobilise/sample-token`,
    button_text: 'शेयर टूलकिट',
  },

  // ── 15. camp_precheck_2d - job live since 5d5d5aa, could not send (EN/MR/HI) ───
  {
    name: 'camp_precheck_2d',
    category: 'UTILITY',
    language: 'en',
    body: `Hi *{{1}}*, your blood donation slot at *{{2}}* is on *{{3}}*.

Two things before you come: eat a proper meal and drink extra water, and avoid alcohol for 24 hours. Carry a photo ID.

If you cannot make it, tap below to update your registration.`,
    body_example: ['Ramesh', 'Shivaji College Blood Donation Camp', 'Sat 12 Sep, 9:00 AM'],
    footer: FOOTER_RAKTIFY,
    button_url: `${ACTIVATION_BASE}/c/{{1}}`,
    button_example: `${ACTIVATION_BASE}/c/shivaji-college-camp-k2x9f`,
    button_text: 'View camp details',
  },
  {
    name: 'camp_precheck_2d',
    category: 'UTILITY',
    language: 'mr',
    body: `नमस्कार *{{1}}*, *{{2}}* येथे तुमची रक्तदानाची वेळ *{{3}}* अशी आहे.

येण्यापूर्वी दोन गोष्टी: व्यवस्थित जेवण करा आणि जास्त पाणी प्या, आणि २४ तास मद्यपान टाळा. ओळखपत्र सोबत आणा.

तुम्हाला येणे शक्य नसेल, तर नोंदणी बदलण्यासाठी खाली टॅप करा.`,
    body_example: ['रमेश', 'शिवाजी कॉलेज रक्तदान शिबिर', 'शनिवार १२ सप्टेंबर, सकाळी ९:००'],
    footer: FOOTER_RAKTIFY,
    button_url: `${ACTIVATION_BASE}/c/{{1}}`,
    button_example: `${ACTIVATION_BASE}/c/shivaji-college-camp-k2x9f`,
    button_text: 'शिबिराची माहिती',
  },
  {
    name: 'camp_precheck_2d',
    category: 'UTILITY',
    language: 'hi',
    body: `नमस्ते *{{1}}*, *{{2}}* में आपके रक्तदान का समय *{{3}}* है।

आने से पहले दो बातें: भरपेट भोजन करें और अधिक पानी पिएँ, और 24 घंटे शराब से बचें। पहचान पत्र साथ लाएँ।

यदि आप नहीं आ सकते, तो अपना पंजीकरण बदलने के लिए नीचे टैप करें।`,
    body_example: ['रमेश', 'शिवाजी कॉलेज रक्तदान शिविर', 'शनिवार १२ सितंबर, सुबह ९:००'],
    footer: FOOTER_RAKTIFY,
    button_url: `${ACTIVATION_BASE}/c/{{1}}`,
    button_example: `${ACTIVATION_BASE}/c/shivaji-college-camp-k2x9f`,
    button_text: 'शिविर की जानकारी',
  },

  // ── 16. camp_day_of — SUPERSEDED by camp_day_of_v2 below. DO NOT RESUBMIT. ────
  //
  // All three records are APPROVED in the WABA, but Meta's classifier filed them
  // as MARKETING, not UTILITY — and a day-of reminder in MARKETING is subject to
  // per-user marketing frequency caps, so a donor who has hit the cap silently
  // gets no reminder on the morning they were expected at the camp.
  //
  // They also each OPEN on *{{1}}*, which Meta now rejects outright
  // (error_subcode 2388299, "Variables can't be at the start or end of the
  // template"), so they cannot be resubmitted as-is even to fix the category.
  //
  // Kept here as the record of what is live in prod until the v2 records clear
  // review and WHATSAPP_TEMPLATE_CAMP_DAY_OF is repointed. Deliberately NOT
  // deleted from the WABA: Meta locks a deleted template's NAME for weeks, which
  // is exactly why the house pattern is a _v2 name (camp_organizer_link_v2,
  // donor_alert_bb_routed_v2) rather than delete-and-recreate.
  {
    name: 'camp_day_of',
    category: 'UTILITY',
    language: 'en',
    body: `*{{1}}*, today is your donation day at *{{2}}*.

Doors open: *{{3}}*
Venue: *{{4}}*

Eat before you come, carry a photo ID, and allow about 45 minutes. Tap below for directions and your registration.`,
    body_example: ['Ramesh', 'Shivaji College Blood Donation Camp', '09:00', 'Shivaji College Main Hall, Amravati'],
    footer: FOOTER_RAKTIFY,
    button_url: `${ACTIVATION_BASE}/c/{{1}}`,
    button_example: `${ACTIVATION_BASE}/c/shivaji-college-camp-k2x9f`,
    button_text: 'Get directions',
  },
  {
    name: 'camp_day_of',
    category: 'UTILITY',
    language: 'mr',
    body: `*{{1}}*, आज *{{2}}* येथे तुमचा रक्तदानाचा दिवस आहे.

सुरुवात: *{{3}}*
ठिकाण: *{{4}}*

येण्यापूर्वी जेवण करा, ओळखपत्र सोबत आणा आणि सुमारे ४५ मिनिटे वेळ ठेवा. मार्ग व तुमची नोंदणी पाहण्यासाठी खाली टॅप करा.`,
    body_example: ['रमेश', 'शिवाजी कॉलेज रक्तदान शिबिर', '09:00', 'शिवाजी कॉलेज मुख्य सभागृह, अमरावती'],
    footer: FOOTER_RAKTIFY,
    button_url: `${ACTIVATION_BASE}/c/{{1}}`,
    button_example: `${ACTIVATION_BASE}/c/shivaji-college-camp-k2x9f`,
    button_text: 'दिशा आणि नोंदणी',
  },
  {
    name: 'camp_day_of',
    category: 'UTILITY',
    language: 'hi',
    body: `*{{1}}*, आज *{{2}}* में आपके रक्तदान का दिन है।

शुरुआत: *{{3}}*
स्थान: *{{4}}*

आने से पहले भोजन करें, पहचान पत्र साथ लाएँ और लगभग 45 मिनट का समय रखें। रास्ता और अपना पंजीकरण देखने के लिए नीचे टैप करें।`,
    body_example: ['रमेश', 'शिवाजी कॉलेज रक्तदान शिविर', '09:00', 'शिवाजी कॉलेज मुख्य सभागृह, अमरावती'],
    footer: FOOTER_RAKTIFY,
    button_url: `${ACTIVATION_BASE}/c/{{1}}`,
    button_example: `${ACTIVATION_BASE}/c/shivaji-college-camp-k2x9f`,
    button_text: 'दिशा और पंजीकरण',
  },

  // ── 16b. camp_day_of_v2 — the UTILITY-tuned replacement (EN/MR/HI) ────────────
  //
  // FOUR variables in the SAME ORDER as camp_day_of, and the same URL-button
  // token. buildComponents() fills {{1}}..{{n}} positionally from the caller's
  // insertion order, so the CAMP_DAY_OF handler in whatsappCloudProvider.js and
  // camp-day-of-reminder.js need no change at all. Reword freely; never renumber.
  //
  // What changed, and why each change is load-bearing:
  //   • Opens on literal text, not *{{1}}* — a body may not start or end with a
  //     variable (error_subcode 2388299). This alone made the old records
  //     un-resubmittable.
  //   • Anchored on a transaction the donor themselves created ("the camp you
  //     registered for on Raktify"), which is the strongest UTILITY signal for
  //     Meta's classifier. The old copy opened "today is your donation day" —
  //     campaign framing, and it is what read as MARKETING.
  //   • "Reporting time" + "view your registration" replace "Doors open" +
  //     "Get directions": appointment- and record-language instead of an
  //     attendance nudge. The meal/ID/45-minute prep line is kept verbatim from
  //     camp_precheck_2d, which Meta approved as UTILITY with the same content —
  //     so the instructions are not the problem, the framing was.
  //   • Button text stays under Meta's 25-char ceiling and still carries the
  //     per-recipient camp slug — a CONSTANT URL is what got
  //     community_leader_welcome re-classified MARKETING.
  //
  // All three languages matter here, unlike the camps.js send sites: the job
  // sends in donors.preferred_language, defaulting to 'mr'.
  {
    name: 'camp_day_of_v2',
    category: 'UTILITY',
    language: 'en',
    body: `Hi *{{1}}*, the blood donation camp you registered for on Raktify is scheduled for today.

Camp: *{{2}}*
Reporting time: *{{3}}*
Venue: *{{4}}*

Please have a meal before reporting, carry a photo ID, and allow about 45 minutes. Tap below to view your registration.`,
    body_example: ['Ramesh', 'Shivaji College Blood Donation Camp', '09:00', 'Shivaji College Main Hall, Amravati'],
    footer: FOOTER_RAKTIFY,
    button_url: `${ACTIVATION_BASE}/c/{{1}}`,
    button_example: `${ACTIVATION_BASE}/c/shivaji-college-camp-k2x9f`,
    button_text: 'View your registration',
  },
  {
    name: 'camp_day_of_v2',
    category: 'UTILITY',
    language: 'mr',
    body: `नमस्कार *{{1}}*, तुम्ही Raktify वर नोंदणी केलेले रक्तदान शिबिर आज नियोजित आहे.

शिबिर: *{{2}}*
हजर राहण्याची वेळ: *{{3}}*
ठिकाण: *{{4}}*

येण्यापूर्वी जेवण करा, ओळखपत्र सोबत आणा आणि सुमारे ४५ मिनिटे वेळ ठेवा. तुमची नोंदणी पाहण्यासाठी खाली टॅप करा.`,
    body_example: ['रमेश', 'शिवाजी कॉलेज रक्तदान शिबिर', '09:00', 'शिवाजी कॉलेज मुख्य सभागृह, अमरावती'],
    footer: FOOTER_RAKTIFY,
    button_url: `${ACTIVATION_BASE}/c/{{1}}`,
    button_example: `${ACTIVATION_BASE}/c/shivaji-college-camp-k2x9f`,
    button_text: 'माझी नोंदणी पहा',
  },
  {
    name: 'camp_day_of_v2',
    category: 'UTILITY',
    language: 'hi',
    body: `नमस्ते *{{1}}*, आपने Raktify पर जिस रक्तदान शिविर के लिए पंजीकरण किया था वह आज निर्धारित है।

शिविर: *{{2}}*
उपस्थिति का समय: *{{3}}*
स्थान: *{{4}}*

आने से पहले भोजन करें, पहचान पत्र साथ लाएँ और लगभग 45 मिनट का समय रखें। अपना पंजीकरण देखने के लिए नीचे टैप करें।`,
    body_example: ['रमेश', 'शिवाजी कॉलेज रक्तदान शिविर', '09:00', 'शिवाजी कॉलेज मुख्य सभागृह, अमरावती'],
    footer: FOOTER_RAKTIFY,
    button_url: `${ACTIVATION_BASE}/c/{{1}}`,
    button_example: `${ACTIVATION_BASE}/c/shivaji-college-camp-k2x9f`,
    button_text: 'मेरा पंजीकरण देखें',
  },

  // ── 17. camp_donor_thankyou - body only, no button (EN/MR/HI) ─────────────────
  {
    name: 'camp_donor_thankyou',
    category: 'UTILITY',
    language: 'en',
    body: `Thank you, *{{1}}*. Your donation at *{{2}}* has been recorded on your donor passport.

Your test results will be added once the blood bank completes screening. You can donate again after 90 days — we will remind you.

Rest today, drink extra fluids, and avoid heavy lifting for a few hours.`,
    body_example: ['Ramesh', 'Shivaji College Blood Donation Camp'],
    footer: FOOTER_RAKTIFY,
  },
  {
    name: 'camp_donor_thankyou',
    category: 'UTILITY',
    language: 'mr',
    body: `धन्यवाद *{{1}}*. *{{2}}* येथे केलेले तुमचे रक्तदान तुमच्या डोनर पासपोर्टमध्ये नोंदवले आहे.

रक्तपेढीची तपासणी पूर्ण झाल्यावर तुमचे अहवाल त्यात जोडले जातील. पुढील रक्तदान ९० दिवसांनंतर करता येईल — आम्ही आठवण करून देऊ.

आज विश्रांती घ्या, जास्त पाणी प्या आणि काही तास जड वजन उचलणे टाळा.`,
    body_example: ['रमेश', 'शिवाजी कॉलेज रक्तदान शिबिर'],
    footer: FOOTER_RAKTIFY,
  },
  {
    name: 'camp_donor_thankyou',
    category: 'UTILITY',
    language: 'hi',
    body: `धन्यवाद *{{1}}*। *{{2}}* में किया गया आपका रक्तदान आपके डोनर पासपोर्ट में दर्ज कर लिया गया है।

ब्लड बैंक की जाँच पूरी होने पर आपकी रिपोर्ट उसमें जोड़ दी जाएगी। अगला रक्तदान 90 दिनों के बाद कर सकेंगे — हम याद दिला देंगे।

आज आराम करें, अधिक पानी पिएँ और कुछ घंटे भारी वजन उठाने से बचें।`,
    body_example: ['रमेश', 'शिवाजी कॉलेज रक्तदान शिविर'],
    footer: FOOTER_RAKTIFY,
  },

  // ── 18. camp_announcement - two live call sites in camps.js (EN/MR/HI) ────────
  {
    name: 'camp_announcement',
    category: 'UTILITY',
    language: 'en',
    body: `Update about *{{1}}*, scheduled on *{{2}}*:

{{3}}

You are receiving this because you registered for this camp.`,
    body_example: ['Shivaji College Blood Donation Camp', 'Sat 12 Sep', 'The hall is on the ground floor next to the library. Please carry a photo ID and eat a full breakfast before you come.'],
    footer: FOOTER_RAKTIFY,
  },
  {
    name: 'camp_announcement',
    category: 'UTILITY',
    language: 'mr',
    body: `शिबिराबाबत सूचना — *{{1}}*, दिनांक *{{2}}*:

{{3}}

तुम्ही या शिबिरासाठी नोंदणी केली असल्याने हा संदेश मिळाला आहे.`,
    body_example: ['शिवाजी कॉलेज रक्तदान शिबिर', 'शनिवार १२ सप्टेंबर', 'सभागृह तळमजल्यावर, ग्रंथालयाच्या शेजारी आहे. ओळखपत्र सोबत आणा आणि येण्यापूर्वी पोटभर नाश्ता करा.'],
    footer: FOOTER_RAKTIFY,
  },
  {
    name: 'camp_announcement',
    category: 'UTILITY',
    language: 'hi',
    body: `शिविर से जुड़ी सूचना — *{{1}}*, दिनांक *{{2}}*:

{{3}}

आपने इस शिविर के लिए पंजीकरण किया है, इसलिए यह संदेश भेजा गया है।`,
    body_example: ['शिवाजी कॉलेज रक्तदान शिविर', 'शनिवार १२ सितंबर', 'हॉल भूतल पर, पुस्तकालय के पास है. पहचान पत्र साथ लाएं और आने से पहले भरपूर नाश्ता करें.'],
    footer: FOOTER_RAKTIFY,
  },

  // ── 19. donor_consent_invite - vendor webhook, after donor row (EN/MR/HI) ─────
  {
    name: 'donor_consent_invite',
    category: 'UTILITY',
    language: 'en',
    body: `Hi *{{1}}*, *{{2}}* has recorded your blood donation on Raktify.

To see your donor passport, your test results and your next eligible date, confirm your consent using the link below. It takes under a minute and the link is only for you.

If you did not donate at *{{2}}*, ignore this message.`,
    body_example: ['Ramesh', 'Dr. PDMMC Blood Centre'],
    footer: FOOTER_RAKTIFY,
    button_url: `${ACTIVATION_BASE}/consent/{{1}}`,
    button_example: `${ACTIVATION_BASE}/consent/cst-7f3a91b2c4`,
    button_text: 'Confirm consent',
  },
  {
    name: 'donor_consent_invite',
    category: 'UTILITY',
    language: 'mr',
    body: `नमस्कार *{{1}}*, *{{2}}* यांनी तुमचे रक्तदान Raktify वर नोंदवले आहे.

तुमचा डोनर पासपोर्ट, तपासणी अहवाल आणि पुढील रक्तदानाची तारीख पाहण्यासाठी खालील लिंकवरून संमती द्या. एक मिनिटही लागणार नाही आणि ही लिंक फक्त तुमच्यासाठी आहे.

तुम्ही *{{2}}* येथे रक्तदान केले नसेल, तर हा संदेश दुर्लक्षित करा.`,
    body_example: ['रमेश', 'डॉ. पीडीएमएमसी रक्तपेढी'],
    footer: FOOTER_RAKTIFY,
    button_url: `${ACTIVATION_BASE}/consent/{{1}}`,
    button_example: `${ACTIVATION_BASE}/consent/cst-7f3a91b2c4`,
    button_text: 'संमती द्या',
  },
  {
    name: 'donor_consent_invite',
    category: 'UTILITY',
    language: 'hi',
    body: `नमस्ते *{{1}}*, *{{2}}* ने आपका रक्तदान Raktify पर दर्ज किया है।

अपना डोनर पासपोर्ट, जाँच रिपोर्ट और अगली रक्तदान तिथि देखने के लिए नीचे दी गई लिंक से सहमति दें। इसमें एक मिनट से कम लगेगा और यह लिंक केवल आपके लिए है।

यदि आपने *{{2}}* में रक्तदान नहीं किया है, तो इस संदेश को नज़रअंदाज़ करें।`,
    body_example: ['रमेश', 'डॉ. पीडीएमएमसी ब्लड सेंटर'],
    footer: FOOTER_RAKTIFY,
    button_url: `${ACTIVATION_BASE}/consent/{{1}}`,
    button_example: `${ACTIVATION_BASE}/consent/cst-7f3a91b2c4`,
    button_text: 'सहमति दें',
  },

  // ── 20. camp_bb_request - migration 317, BB answers a camp (EN/MR/HI) ─────────
  {
    name: 'camp_bb_request',
    category: 'UTILITY',
    language: 'en',
    body: `A blood donation camp has been assigned to *{{1}}* for collection.

Date: *{{2}}*
Venue: *{{3}}*
Expected donors: *{{4}}*

Open the Camps tab in your Raktify portal to accept or decline, and to see the live registration count before the day.`,
    body_example: ['Dr. PDMMC Blood Centre', 'Sat 12 Sep', 'Shivaji College Main Hall, Amravati', '50'],
    footer: FOOTER_BB,
  },
  {
    name: 'camp_bb_request',
    category: 'UTILITY',
    language: 'mr',
    body: `रक्तसंकलनासाठी *{{1}}* या रक्तपेढीला एक रक्तदान शिबिर देण्यात आले आहे.

दिनांक: *{{2}}*
ठिकाण: *{{3}}*
अपेक्षित रक्तदाते: *{{4}}*

स्वीकारण्यासाठी किंवा नाकारण्यासाठी, आणि दिवसापूर्वी नोंदणीची संख्या पाहण्यासाठी Raktify पोर्टलमधील Camps टॅब उघडा.`,
    body_example: ['डॉ. पीडीएमएमसी रक्तपेढी', 'शनिवार १२ सप्टेंबर', 'शिवाजी कॉलेज मुख्य सभागृह, अमरावती', '50'],
    footer: FOOTER_BB,
  },
  {
    name: 'camp_bb_request',
    category: 'UTILITY',
    language: 'hi',
    body: `रक्त संग्रह के लिए *{{1}}* को एक रक्तदान शिविर सौंपा गया है।

दिनांक: *{{2}}*
स्थान: *{{3}}*
अपेक्षित रक्तदाता: *{{4}}*

स्वीकार या अस्वीकार करने और शिविर से पहले पंजीकरण की संख्या देखने के लिए Raktify पोर्टल में Camps टैब खोलें।`,
    body_example: ['डॉ. पीडीएमएमसी ब्लड सेंटर', 'शनिवार १२ सितंबर', 'शिवाजी कॉलेज मुख्य सभागृह, अमरावती', '50'],
    footer: FOOTER_BB,
  },

  // ── 21. camp_bb_accepted - organiser hears the good news (EN/MR/HI) ───────────
  {
    name: 'camp_bb_accepted',
    category: 'UTILITY',
    language: 'en',
    body: `Hi *{{1}}*, the blood bank for *{{2}}* on *{{3}}* is confirmed.

Their team will bring the staff, beds and all collection supplies. Nothing further is needed from you on this — keep sharing your registration link so they can plan supplies from the numbers.`,
    body_example: ['Ashish Tayde', 'Shivaji College Blood Donation Camp', 'Sat 12 Sep'],
    footer: FOOTER_ORGANIZER,
  },
  {
    name: 'camp_bb_accepted',
    category: 'UTILITY',
    language: 'mr',
    body: `नमस्कार *{{1}}*, *{{2}}* (दिनांक *{{3}}*) साठी रक्तपेढी निश्चित झाली आहे.

त्यांची टीम कर्मचारी, बेड आणि संकलनाचे सर्व साहित्य घेऊन येईल. यासाठी तुम्हाला आणखी काही करायचे नाही — नोंदणीची लिंक शेअर करत राहा, म्हणजे संख्येनुसार ते साहित्याची तयारी करू शकतील.`,
    body_example: ['आशिष तायडे', 'शिवाजी कॉलेज रक्तदान शिबिर', 'शनिवार १२ सप्टेंबर'],
    footer: FOOTER_ORGANIZER,
  },
  {
    name: 'camp_bb_accepted',
    category: 'UTILITY',
    language: 'hi',
    body: `नमस्ते *{{1}}*, *{{2}}* (दिनांक *{{3}}*) के लिए ब्लड बैंक तय हो गया है।

उनकी टीम स्टाफ, बेड और संग्रह की सभी सामग्री साथ लाएगी। इसके लिए आपको और कुछ नहीं करना है — पंजीकरण लिंक साझा करते रहें, जिससे वे संख्या के अनुसार सामग्री की तैयारी कर सकें।`,
    body_example: ['आशिष तायडे', 'शिवाजी कॉलेज रक्तदान शिविर', 'शनिवार १२ सितंबर'],
    footer: FOOTER_ORGANIZER,
  },

  // ── 22. camp_bb_changed - never carries the decline reason (EN/MR/HI) ─────────
  {
    name: 'camp_bb_changed',
    category: 'UTILITY',
    language: 'en',
    body: `Hi *{{1}}*, we are arranging a different blood bank to collect at *{{2}}* on *{{3}}*.

Your camp is going ahead as planned and your registrations are unaffected. We will confirm the new blood bank shortly — you do not need to do anything.`,
    body_example: ['Ashish Tayde', 'Shivaji College Blood Donation Camp', 'Sat 12 Sep'],
    footer: FOOTER_ORGANIZER,
  },
  {
    name: 'camp_bb_changed',
    category: 'UTILITY',
    language: 'mr',
    body: `नमस्कार *{{1}}*, *{{2}}* (दिनांक *{{3}}*) येथे रक्तसंकलनासाठी आम्ही दुसरी रक्तपेढी नियुक्त करत आहोत.

तुमचे शिबिर ठरल्याप्रमाणे होणार आहे आणि नोंदणीवर कोणताही परिणाम होणार नाही. नवीन रक्तपेढी लवकरच कळवू — तुम्हाला काहीही करण्याची गरज नाही.`,
    body_example: ['आशिष तायडे', 'शिवाजी कॉलेज रक्तदान शिबिर', 'शनिवार १२ सप्टेंबर'],
    footer: FOOTER_ORGANIZER,
  },
  {
    name: 'camp_bb_changed',
    category: 'UTILITY',
    language: 'hi',
    body: `नमस्ते *{{1}}*, *{{2}}* (दिनांक *{{3}}*) में रक्त संग्रह के लिए हम दूसरा ब्लड बैंक तय कर रहे हैं।

आपका शिविर योजना के अनुसार ही होगा और पंजीकरण पर कोई असर नहीं पड़ेगा। नया ब्लड बैंक शीघ्र ही बता देंगे — आपको कुछ करने की आवश्यकता नहीं है।`,
    body_example: ['आशिष तायडे', 'शिवाजी कॉलेज रक्तदान शिविर', 'शनिवार १२ सितंबर'],
    footer: FOOTER_ORGANIZER,
  },

  // ── 23. camp_review_pending - the NGO side is TOLD a camp is waiting ─────────
  //
  // Fired by POST /camps/apply, which until now notified nobody while promising
  // the organiser an NGO callback within 2 working days. Goes to the district's
  // coordinators + every active ngo_admin.
  //
  // Body-only, NO button: an admin signs in with password + TOTP, so a button
  // could only carry a constant /admin link, and a constant URL is exactly what
  // got community_leader_welcome re-classified MARKETING.
  //
  // Opens with literal text and closes with literal text — Meta rejects a body
  // that begins or ends with a variable (error_subcode 2388299).
  {
    name: 'camp_review_pending',
    category: 'UTILITY',
    language: 'en',
    body: `A new blood donation camp application is waiting for NGO review on Raktify.

Camp: *{{1}}*
Date: *{{2}}*
Venue: *{{3}}*
Organiser: *{{4}}*
District: *{{5}}*

Open the Camps tab in your Raktify portal to verify the details and assign a blood bank.`,
    body_example: [
      'Shivaji College Blood Donation Camp',
      '2026-09-12',
      'Shivaji College Main Hall, Amravati',
      'Shivaji College, Amravati',
      'Amravati',
    ],
    footer: FOOTER_COORD,
  },
  {
    name: 'camp_review_pending',
    category: 'UTILITY',
    language: 'mr',
    body: `Raktify वर एक नवीन रक्तदान शिबिराचा अर्ज तपासणीसाठी प्रलंबित आहे.

शिबिर: *{{1}}*
दिनांक: *{{2}}*
ठिकाण: *{{3}}*
आयोजक: *{{4}}*
जिल्हा: *{{5}}*

तपशील तपासण्यासाठी आणि रक्तपेढी नेमण्यासाठी Raktify पोर्टलमधील Camps टॅब उघडा.`,
    body_example: [
      'शिवाजी कॉलेज रक्तदान शिबिर',
      '2026-09-12',
      'शिवाजी कॉलेज मुख्य सभागृह, अमरावती',
      'शिवाजी कॉलेज, अमरावती',
      'अमरावती',
    ],
    footer: FOOTER_COORD,
  },
  {
    name: 'camp_review_pending',
    category: 'UTILITY',
    language: 'hi',
    body: `Raktify पर एक नया रक्तदान शिविर आवेदन समीक्षा के लिए लंबित है।

शिविर: *{{1}}*
दिनांक: *{{2}}*
स्थान: *{{3}}*
आयोजक: *{{4}}*
जिला: *{{5}}*

विवरण सत्यापित करने और ब्लड बैंक तय करने के लिए Raktify पोर्टल में Camps टैब खोलें।`,
    body_example: [
      'शिवाजी कॉलेज रक्तदान शिविर',
      '2026-09-12',
      'शिवाजी कॉलेज मुख्य सभागृह, अमरावती',
      'शिवाजी कॉलेज, अमरावती',
      'अमरावती',
    ],
    footer: FOOTER_COORD,
  },

];

function buildPayload(t) {
  const components = [
    {
      type: 'BODY',
      text: t.body,
      example: { body_text: [t.body_example] },
    },
  ];
  if (t.footer) components.push({ type: 'FOOTER', text: t.footer });
  if (t.button_url) {
    components.push({
      type: 'BUTTONS',
      buttons: [
        {
          type: 'URL',
          text: t.button_text,
          url: t.button_url,
          example: [t.button_example],
        },
      ],
    });
  }
  return {
    name: t.name,
    language: t.language,
    category: t.category,
    components,
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
        console.log(r.dry ? '(dry-run)' : `✓ ${r.body?.status || 'submitted'}`);
      } else {
        console.log(`✗ HTTP ${r.status}: ${r.body?.error?.message || 'unknown'}`);
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
