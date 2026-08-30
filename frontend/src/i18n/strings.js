// Spec §7: default Marathi, switchable. Strings live here keyed by feature.
// This is intentionally hand-rolled rather than i18next — the Phase-7 starter
// only needs a couple of screens. Swap for i18next when the screen count grows.

// Domain string packs. Kept out of the dict literal below so a 100-key feature
// does not make every future diff in this file unreviewable. They are spread
// FIRST in each block, so an existing literal key here always wins a collision.
import * as camps from './camps.js';
import * as bloodbank from './bloodbank.js';

const STORAGE_KEY = 'rk.lang';

export const SUPPORTED = ['mr', 'hi', 'en'];

// Language code -> native-script label. A Marathi-first user recognises their
// own script instantly; three Roman abbreviations (MR / HI / EN) are opaque to
// exactly the person the picker exists for.
export const LANG_LABELS = { mr: 'मराठी', hi: 'हिन्दी', en: 'English' };

export function detectInitialLang() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && SUPPORTED.includes(stored)) return stored;
  const nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return SUPPORTED.includes(nav) ? nav : 'mr';
}

export function setLang(lang) {
  if (!SUPPORTED.includes(lang)) return;
  localStorage.setItem(STORAGE_KEY, lang);
  document.documentElement.lang = lang;
}

const dict = {
  mr: {
    ...camps.mr,
    ...bloodbank.mr,
    app_name: 'Raktify',
    tagline: 'रक्त दान करा. जीव वाचवा.',
    role_donor: 'मी रक्तदाता आहे',
    role_staff: 'रुग्णालय / ब्लड बँक / एनजीओ',
    login_mobile_hint: 'रक्तदाते आणि सामुदायिक नेते — तुमच्या मोबाइल नंबरने साइन इन करा',
    login_go_staff: 'रुग्णालय / ब्लड बँक / एनजीओ कर्मचारी? ईमेलने साइन इन करा',
    login_go_mobile: 'रक्तदाता किंवा समन्वयक? मोबाइलने लॉग इन करा',
    // Landing page
    lp_eyebrow: 'भारताचे ऐच्छिक रक्तदान जाळे',
    lp_headline_a: 'गरजूंसाठी',
    lp_headline_b: 'वेळेवर रक्त.',
    lp_subhead:
      'Raktify हे एक मोफत व्यासपीठ आहे जे भारतभर ऐच्छिक रक्तदाते, रुग्णालये आणि रक्तपेढ्या जोडते — जेणेकरून कोणतीही विनंती अनुत्तरित राहणार नाही.',
    lp_cta_donor: 'रक्तदाता व्हा',
    lp_cta_login: 'लॉग इन करा',
    lp_cta_staff: 'रुग्णालय / रक्तपेढी प्रवेश',
    // Top-nav labels (new in May 2026 redesign)
    lp_nav_how: 'हे कसे चालते',
    lp_hero_how: 'नवीन आहात? Raktify कसे चालते ते पहा',
    lp_nav_host_camp: 'शिबिर आयोजित करा',
    lp_nav_institutions: 'रुग्णालये आणि रक्तपेढ्या',
    lp_nav_inst_signin: 'तुमच्या संस्थेत साइन इन करा',
    lp_nav_inst_signin_sub: 'आधीच खाते असलेल्या रुग्णालय व रक्तपेढी कर्मचाऱ्यांसाठी.',
    lp_nav_inst_apply: 'तुमचे रुग्णालय किंवा रक्तपेढी जोडा',
    lp_nav_inst_apply_sub: 'Raktify खात्यासाठी अर्ज करा (मोफत). 48 तासांत पुनरावलोकन.',
    lp_nav_menu: 'मेनू',
    lp_nav_lang_label: 'भाषा',
    // Setup-link password setup (institutional admins)
    setup_subtitle: 'पासवर्ड सेट करा',
    setup_loading: 'लिंक तपासत आहे...',
    setup_welcome: 'स्वागत आहे',
    setup_intro_for: 'पासवर्ड सेट करा',
    setup_intro_username: 'वापरकर्तानाव:',
    setup_password: 'नवीन पासवर्ड',
    setup_confirm: 'पासवर्डची पुष्टी करा',
    setup_pwd_min: 'किमान 12 अक्षरे',
    setup_pwd_letter: 'किमान एक अक्षर',
    setup_pwd_digit: 'किमान एक अंक',
    setup_pwd_ok: 'पासवर्ड मजबूत आहे',
    setup_pwd_mismatch: 'पासवर्ड जुळत नाही',
    setup_submit: 'पासवर्ड सेट करा',
    setup_submitting: 'सेट करत आहे...',
    setup_submit_error: 'त्रुटी',
    setup_already_set: 'आधीच सेट केले?',
    setup_login_link: 'लॉग इन करा',
    setup_invalid_title: 'अवैध लिंक',
    setup_invalid_body: 'ही पासवर्ड-सेट लिंक चुकीची किंवा खराब झाली आहे.',
    setup_expired_title: 'लिंकची मुदत संपली',
    setup_expired_body: 'ही लिंक 7 दिवसांत वापरली जाऊ शकत होती. कृपया तुमच्या समन्वयकाकडून नवीन लिंक मागवा.',
    setup_used_title: 'लिंक आधीच वापरली',
    setup_used_body: 'या लिंकद्वारे पासवर्ड आधीच सेट केला आहे. कृपया लॉग इन करा.',
    setup_error_title: 'त्रुटी आली',
    setup_error_body: 'लिंक तपासताना समस्या आली.',
    setup_contact_admin: 'मदतीसाठी संपर्क: contact@choudhari.ngo',
    setup_back_to_login: 'लॉगिनवर परत जा',
    lp_reassure: 'मोफत · २ मिनिटांत नोंदणी · कधीही रद्द करा',
    lp_card_live: 'थेट विनंती',
    lp_card_matched: 'जुळले',
    lp_card_alerted: '३ रक्तदात्यांना सूचना',
    lp_card_critical: 'अत्यावश्यक',
    lp_how_title: 'हे कसे चालते',
    lp_how_sub: 'नोंदणीपासून जुळवणीपर्यंत तीन सोप्या पायऱ्या.',
    lp_how_full_link: 'संपूर्ण प्रवास पहा — विनंतीपासून रक्तसंक्रमणापर्यंत',
    lp_step1_title: 'काही मिनिटांत नोंदणी',
    lp_step1_body:
      'थोडक्यात आरोग्य तपासणी करा आणि तुम्ही कधी उपलब्ध आहात ते सांगा. मराठी, हिंदी किंवा इंग्रजीत.',
    lp_step2_title: 'रुग्णालय विनंती करते',
    lp_step2_body:
      'रुग्णाला रक्ताची गरज असताना, विनंती लगेच स्थानिक समन्वयकाकडे पाठवली जाते.',
    lp_step3_title: 'आम्ही जुळवतो — गोपनीयतेने',
    lp_step3_body:
      'सुसंगत रक्तदाते आणि तपासलेला साठा जुळवला जातो. तुमचा मोबाइल नंबर रुग्णालयांना कधीही दिसत नाही.',
    lp_trust_title: 'सुरक्षितता आणि गोपनीयतेसाठी बनवलेले',
    lp_trust1_title: 'तुमचा नंबर खाजगी राहतो',
    lp_trust1_body:
      'रुग्णालयांना रक्तदात्याचे संपर्क तपशील कधीही दिसत नाहीत. प्रत्येक संवाद समन्वयकामार्फत होतो.',
    lp_trust2_title: 'प्रयोगशाळेत तपासलेला रक्तगट',
    lp_trust2_body:
      'जुळवणीसाठी फक्त रक्तपेढीने तपासलेला रक्तगट वापरला जातो — स्वतः सांगितलेला अंदाज नाही.',
    lp_trust3_title: 'प्रत्येक कृतीची नोंद',
    lp_trust3_body: 'प्रत्येक बदलाची छेडछाड-स्पष्ट नोंद सुरुवातीपासून शेवटपर्यंत ठेवली जाते.',
    lp_final_title: 'एक जीव वाचवायला तयार आहात?',
    lp_final_body: 'नोंदणीला फक्त दोन मिनिटे लागतात. आज एक रक्तदाता व्हा.',
    lp_footer_org: 'चौधरी एज्युहेल्थ इंडिया फाउंडेशन',
    enter_mobile: 'मोबाइल नंबर',
    send_otp: 'OTP पाठवा',
    enter_otp: '6-अंकी OTP',
    verify_otp: 'पुष्टी करा',
    available_today: 'आज उपलब्ध आहे',
    not_available_today: 'सध्या उपलब्ध नाही',
    next_eligible: 'पुढील पात्र तारीख',
    total_donations: 'एकूण रक्तदान',
    blood_group: 'रक्तगट',
    unverified: 'अप्रमाणित',
    logout: 'बाहेर पडा',
    queue_title: 'विनंती रांग',
    raise_request: 'नवीन विनंती',
    units: 'युनिट्स',
    urgency: 'तात्काळता',
    back: 'मागे',
    submit: 'सबमिट',
    // common UI
    accept: 'स्वीकार करा',
    cancel: 'रद्द करा',
    confirm: 'पुष्टी करा',
    sign_in: 'साइन इन करा',
    loading: 'लोड होत आहे…',
    no_records: 'कोणत्याही नोंदी नाहीत',
    open: 'उघडा',
    // coord queue / detail
    open_count: 'खुले',
    raised_ago: 'पासून उठवली',
    // hospital
    my_requests: 'माझ्या विनंत्या',
    raise_new: 'नवीन उभारा',
    confirm_crossmatch: 'क्रॉसमॅच पुष्टी करा',
    // BB
    inventory: 'इन्व्हेंटरी',
    record_donation: 'दान नोंदवा',
    tti_screening: 'TTI तपासणी',
    opening_stock: 'सुरुवातीचा साठा',
    donor_lookup: 'दात्याचा शोध',
    // date of birth picker
    dob_day: 'दिवस',
    dob_month: 'महिना',
    dob_year: 'वर्ष',
    dob_out_of_range: 'वय {min} ते {max} वर्षांदरम्यान असावे.',
    // the language a donor's WhatsApp / SMS messages go out in
    donor_lang_label: 'संदेशाची भाषा',
    donor_lang_hint:
      'WhatsApp आणि SMS संदेश या भाषेत येतील. नंतर प्रोफाइलमध्ये बदलता येईल.',
    // outbox
    // OTP errors, donor-facing. otp_err_no_whatsapp is shown ONLY when Meta
    // rejected the number itself — never for an outage or a missing template.
    otp_err_no_whatsapp:
      'हा नंबर WhatsApp वर दिसत नाही, त्यामुळे कोड पाठवता आला नाही. WhatsApp सुरू असलेला नंबर टाका. WhatsApp वापरत नसाल तर +91 98505 41412 वर फोन करा.',
    otp_err_send_failed:
      'कोड पाठवताना अडचण आली. ही आमच्या बाजूची अडचण आहे — थोड्या वेळाने पुन्हा प्रयत्न करा.',
    otp_err_rate_limited: 'खूप वेळा कोड मागवला गेला आहे. थोडा वेळ थांबून पुन्हा प्रयत्न करा.',
    otp_err_wrong_code: 'हा कोड बरोबर नाही किंवा त्याची मुदत संपली आहे. नवीन कोड मागवा.',
    otp_err_expired: 'कोडची मुदत संपली आहे. नवीन कोड मागवा.',
    otp_err_locked:
      'अनेक चुकीच्या प्रयत्नांमुळे हे खाते काही वेळासाठी बंद केले आहे. थोड्या वेळाने पुन्हा प्रयत्न करा.',
    otp_err_bad_mobile: 'मोबाइल नंबर तपासा — 10 अंकी भारतीय नंबर टाका.',
    otp_err_six_digits: '6 अंकी कोड टाका.',
    otp_err_leader_unknown:
      'हा नंबर समुदाय प्रमुख म्हणून नोंदलेला नाही. एनजीओ प्रशासकाशी संपर्क करा.',
    otp_err_offline: 'इंटरनेट जोडलेले दिसत नाही. कनेक्शन तपासून पुन्हा प्रयत्न करा.',
    otp_err_generic: 'काहीतरी चुकले. थोड्या वेळाने पुन्हा प्रयत्न करा.',
    otp_send_failed_title: 'कोड पाठवता आला नाही',
    otp_resend: 'कोड पुन्हा पाठवा',
    reg_saved_otp_pending:
      'तुमची माहिती जतन झाली आहे. पण मोबाइल तपासणीचा कोड पाठवता आला नाही, त्यामुळे नोंदणी अजून पूर्ण झाली नाही.',
    reg_err_consent_required: 'पुढे जाण्यासाठी संमती द्यावी लागेल.',
    reg_err_invalid_details: 'काही माहिती अपूर्ण किंवा चुकीची आहे. वरील रकाने तपासा.',
    reg_err_submit_failed: 'नोंदणी पूर्ण होऊ शकली नाही. थोड्या वेळाने पुन्हा प्रयत्न करा.',
    pending_sync_one: '१ बदल सिंक होण्याच्या प्रतीक्षेत',
    pending_sync_many: '{n} बदल सिंक होण्याच्या प्रतीक्षेत',
    retry: 'पुन्हा प्रयत्न करा',
    will_sync_when_online: 'ऑनलाइन झाल्यावर सिंक होईल',
  },
  hi: {
    app_name: 'Raktify',
    tagline: 'रक्तदान करें. जीवन बचाएँ.',
    role_donor: 'मैं रक्तदाता हूँ',
    role_staff: 'अस्पताल / ब्लड बैंक / एनजीओ',
    login_mobile_hint: 'रक्तदाता और सामुदायिक नेता — अपने मोबाइल नंबर से साइन इन करें',
    login_go_staff: 'अस्पताल / ब्लड बैंक / एनजीओ स्टाफ? ईमेल से साइन इन करें',
    login_go_mobile: 'रक्तदाता या समन्वयक? मोबाइल से लॉग इन करें',
    // Landing page
    lp_eyebrow: 'भारत का स्वैच्छिक रक्तदान नेटवर्क',
    lp_headline_a: 'ज़रूरतमंदों के लिए',
    lp_headline_b: 'सही समय पर रक्त.',
    lp_subhead:
      'Raktify एक मुफ़्त मंच है जो भारत भर में स्वैच्छिक रक्तदाताओं, अस्पतालों और ब्लड बैंकों को जोड़ता है — ताकि कोई भी अनुरोध अनुत्तरित न रहे.',
    lp_cta_donor: 'रक्तदाता बनें',
    lp_cta_login: 'लॉग इन करें',
    lp_cta_staff: 'अस्पताल / ब्लड बैंक लॉगिन',
    // Top-nav labels (new in May 2026 redesign)
    lp_nav_how: 'यह कैसे काम करता है',
    lp_hero_how: 'नए हैं? देखें Raktify कैसे काम करता है',
    lp_nav_host_camp: 'शिविर आयोजित करें',
    lp_nav_institutions: 'अस्पताल और ब्लड बैंक',
    lp_nav_inst_signin: 'अपनी संस्था में साइन इन करें',
    lp_nav_inst_signin_sub: 'पहले से खाता रखने वाले अस्पताल और ब्लड बैंक कर्मचारियों के लिए.',
    lp_nav_inst_apply: 'अपना अस्पताल या ब्लड बैंक जोड़ें',
    lp_nav_inst_apply_sub: 'Raktify खाते के लिए आवेदन करें (मुफ़्त). 48 घंटे में समीक्षा.',
    lp_nav_menu: 'मेनू',
    lp_nav_lang_label: 'भाषा',
    // Setup-link password setup (institutional admins)
    setup_subtitle: 'पासवर्ड सेट करें',
    setup_loading: 'लिंक की जाँच की जा रही है...',
    setup_welcome: 'स्वागत है',
    setup_intro_for: 'पासवर्ड सेट करें',
    setup_intro_username: 'उपयोगकर्ता नाम:',
    setup_password: 'नया पासवर्ड',
    setup_confirm: 'पासवर्ड की पुष्टि करें',
    setup_pwd_min: 'कम से कम 12 अक्षर',
    setup_pwd_letter: 'कम से कम एक अक्षर',
    setup_pwd_digit: 'कम से कम एक अंक',
    setup_pwd_ok: 'पासवर्ड मज़बूत है',
    setup_pwd_mismatch: 'पासवर्ड मेल नहीं खाते',
    setup_submit: 'पासवर्ड सेट करें',
    setup_submitting: 'सेट किया जा रहा है...',
    setup_submit_error: 'त्रुटि',
    setup_already_set: 'पहले से सेट किया गया?',
    setup_login_link: 'लॉग इन करें',
    setup_invalid_title: 'अमान्य लिंक',
    setup_invalid_body: 'यह पासवर्ड-सेट लिंक गलत या क्षतिग्रस्त है.',
    setup_expired_title: 'लिंक की अवधि समाप्त',
    setup_expired_body: 'यह लिंक 7 दिनों के लिए वैध थी. कृपया अपने समन्वयक से नई लिंक माँगें.',
    setup_used_title: 'लिंक पहले उपयोग की जा चुकी है',
    setup_used_body: 'इस लिंक से पहले ही पासवर्ड सेट किया जा चुका है. कृपया लॉग इन करें.',
    setup_error_title: 'एक त्रुटि हुई',
    setup_error_body: 'लिंक की जाँच में समस्या आई.',
    setup_contact_admin: 'सहायता के लिए संपर्क करें: contact@choudhari.ngo',
    setup_back_to_login: 'लॉगिन पर वापस जाएँ',
    lp_reassure: 'मुफ़्त · 2 मिनट में पंजीकरण · कभी भी रद्द करें',
    lp_card_live: 'लाइव अनुरोध',
    lp_card_matched: 'मिलान हुआ',
    lp_card_alerted: '3 रक्तदाताओं को सूचना',
    lp_card_critical: 'अत्यावश्यक',
    lp_how_title: 'यह कैसे काम करता है',
    lp_how_sub: 'पंजीकरण से मिलान तक तीन आसान चरण.',
    lp_how_full_link: 'पूरी यात्रा देखें — अनुरोध से रक्ताधान तक',
    lp_step1_title: 'मिनटों में पंजीकरण',
    lp_step1_body:
      'एक छोटी स्वास्थ्य जाँच करें और बताएं कि आप कब उपलब्ध हैं. मराठी, हिंदी या अंग्रेज़ी में.',
    lp_step2_title: 'अस्पताल अनुरोध करता है',
    lp_step2_body:
      'जब किसी मरीज़ को रक्त चाहिए, अनुरोध तुरंत स्थानीय समन्वयक को भेजा जाता है.',
    lp_step3_title: 'हम मिलान करते हैं — निजी तौर पर',
    lp_step3_body:
      'संगत रक्तदाता और सत्यापित स्टॉक का मिलान होता है. आपका मोबाइल नंबर अस्पतालों को कभी नहीं दिखता.',
    lp_trust_title: 'सुरक्षा और निजता के लिए बनाया गया',
    lp_trust1_title: 'आपका नंबर निजी रहता है',
    lp_trust1_body:
      'अस्पतालों को रक्तदाता का संपर्क विवरण कभी नहीं दिखता. हर बातचीत समन्वयक के ज़रिए होती है.',
    lp_trust2_title: 'प्रयोगशाला-सत्यापित रक्त समूह',
    lp_trust2_body:
      'मिलान के लिए केवल ब्लड बैंक द्वारा सत्यापित समूह उपयोग होता है — स्वयं बताया अनुमान नहीं.',
    lp_trust3_title: 'हर क्रिया का ऑडिट',
    lp_trust3_body: 'हर बदलाव का छेड़छाड़-स्पष्ट रिकॉर्ड शुरू से अंत तक रखा जाता है.',
    lp_final_title: 'एक जान बचाने के लिए तैयार हैं?',
    lp_final_body: 'पंजीकरण में बस दो मिनट लगते हैं. आज एक रक्तदाता बनें.',
    lp_footer_org: 'चौधरी एज्युहेल्थ इंडिया फाउंडेशन',
    enter_mobile: 'मोबाइल नंबर',
    send_otp: 'OTP भेजें',
    enter_otp: '6-अंकीय OTP',
    verify_otp: 'सत्यापित करें',
    available_today: 'आज उपलब्ध हूँ',
    not_available_today: 'अभी उपलब्ध नहीं',
    next_eligible: 'अगली पात्रता तिथि',
    total_donations: 'कुल रक्तदान',
    blood_group: 'रक्त समूह',
    unverified: 'अप्रमाणित',
    logout: 'लॉगआउट',
    queue_title: 'अनुरोध सूची',
    raise_request: 'नया अनुरोध',
    units: 'यूनिट',
    urgency: 'अत्यावश्यकता',
    back: 'पीछे',
    submit: 'सबमिट',
    accept: 'स्वीकार करें',
    cancel: 'रद्द करें',
    confirm: 'पुष्टि करें',
    sign_in: 'साइन इन करें',
    loading: 'लोड हो रहा है…',
    no_records: 'कोई रिकॉर्ड नहीं',
    open: 'खोलें',
    open_count: 'खुले',
    raised_ago: 'पहले उठाया',
    my_requests: 'मेरे अनुरोध',
    raise_new: 'नया उठाएँ',
    confirm_crossmatch: 'क्रॉसमैच पुष्टि करें',
    inventory: 'इन्वेंटरी',
    record_donation: 'दान दर्ज करें',
    tti_screening: 'TTI जाँच',
    opening_stock: 'प्रारंभिक स्टॉक',
    donor_lookup: 'दाता खोज',
    dob_day: 'दिन',
    dob_month: 'महीना',
    dob_year: 'वर्ष',
    dob_out_of_range: 'उम्र {min} से {max} वर्ष के बीच होनी चाहिए।',
    donor_lang_label: 'संदेश की भाषा',
    donor_lang_hint:
      'WhatsApp और SMS संदेश इसी भाषा में आएंगे। बाद में प्रोफ़ाइल में बदल सकते हैं।',
    // OTP errors, donor-facing. otp_err_no_whatsapp is shown ONLY when Meta
    // rejected the number itself — never for an outage or a missing template.
    otp_err_no_whatsapp:
      'यह नंबर WhatsApp पर नहीं दिख रहा, इसलिए कोड नहीं भेजा जा सका। WhatsApp चालू नंबर डालें। WhatsApp इस्तेमाल न करते हों तो +91 98505 41412 पर कॉल करें।',
    otp_err_send_failed:
      'कोड भेजने में दिक्कत हुई। यह हमारी तरफ़ की दिक्कत है — कुछ देर बाद फिर कोशिश करें।',
    otp_err_rate_limited: 'बहुत बार कोड मंगाया गया है। कुछ देर रुककर फिर कोशिश करें।',
    otp_err_wrong_code: 'यह कोड सही नहीं है या इसकी अवधि ख़त्म हो गई है। नया कोड मंगाएँ।',
    otp_err_expired: 'कोड की अवधि ख़त्म हो गई है। नया कोड मंगाएँ।',
    otp_err_locked:
      'कई ग़लत कोशिशों के बाद यह खाता कुछ समय के लिए बंद है। कुछ देर बाद फिर कोशिश करें।',
    otp_err_bad_mobile: 'मोबाइल नंबर जाँचें — 10 अंकों का भारतीय नंबर डालें।',
    otp_err_six_digits: '6 अंकों का कोड डालें।',
    otp_err_leader_unknown:
      'यह नंबर समुदाय प्रमुख के रूप में दर्ज नहीं है। एनजीओ एडमिन से संपर्क करें।',
    otp_err_offline: 'इंटरनेट जुड़ा नहीं दिख रहा। कनेक्शन जाँचकर फिर कोशिश करें।',
    otp_err_generic: 'कुछ ग़लत हुआ। कुछ देर बाद फिर कोशिश करें।',
    otp_send_failed_title: 'कोड नहीं भेजा जा सका',
    otp_resend: 'कोड फिर भेजें',
    reg_saved_otp_pending:
      'आपकी जानकारी सुरक्षित हो गई है। लेकिन मोबाइल जाँच का कोड नहीं भेजा जा सका, इसलिए रजिस्ट्रेशन अभी पूरा नहीं हुआ।',
    reg_err_consent_required: 'आगे बढ़ने के लिए सहमति देना ज़रूरी है।',
    reg_err_invalid_details: 'कुछ जानकारी अधूरी या ग़लत है। ऊपर के ख़ाने जाँचें।',
    reg_err_submit_failed: 'रजिस्ट्रेशन पूरा नहीं हो सका। कुछ देर बाद फिर कोशिश करें।',
    pending_sync_one: '1 बदलाव सिंक होने की प्रतीक्षा में',
    pending_sync_many: '{n} बदलाव सिंक होने की प्रतीक्षा में',
    retry: 'पुनः प्रयास करें',
    will_sync_when_online: 'ऑनलाइन होने पर सिंक होगा',
  },
  en: {
    ...camps.en,
    ...bloodbank.en,
    app_name: 'Raktify',
    tagline: 'Donate blood. Save lives.',
    role_donor: 'I am a donor',
    role_staff: 'Hospital / Blood Bank / NGO',
    login_mobile_hint: 'Donors & community leaders — sign in with your mobile number',
    login_go_staff: 'Hospital / blood bank / NGO staff? Sign in with email',
    login_go_mobile: 'Donor or coordinator? Log in with your mobile',
    // Landing page
    lp_eyebrow: "India's voluntary blood network",
    lp_headline_a: 'The right blood,',
    lp_headline_b: 'right on time.',
    lp_subhead:
      'Raktify is a free platform that links voluntary donors, hospitals, and blood banks across India — so no request goes unanswered.',
    lp_cta_donor: 'Become a donor',
    lp_cta_login: 'Log in',
    lp_cta_staff: 'Hospital / blood bank sign-in',
    // Top-nav labels (new in May 2026 redesign)
    lp_nav_how: 'How it works',
    lp_hero_how: 'New here? See how Raktify works',
    lp_nav_host_camp: 'Host a camp',
    lp_nav_institutions: 'For hospitals & blood banks',
    lp_nav_inst_signin: 'Sign in to your institution',
    lp_nav_inst_signin_sub: 'For hospital + blood-bank staff who already have an account.',
    lp_nav_inst_apply: 'Onboard your hospital or blood bank',
    lp_nav_inst_apply_sub: 'Apply for a free Raktify account. Reviewed within 48 hours.',
    lp_nav_menu: 'Menu',
    lp_nav_lang_label: 'Language',
    // Setup-link password setup (institutional admins)
    setup_subtitle: 'Set your password',
    setup_loading: 'Checking link…',
    setup_welcome: 'Welcome',
    setup_intro_for: 'Set the admin password for',
    setup_intro_username: 'Username:',
    setup_password: 'New password',
    setup_confirm: 'Confirm password',
    setup_pwd_min: 'At least 12 characters',
    setup_pwd_letter: 'At least one letter',
    setup_pwd_digit: 'At least one digit',
    setup_pwd_ok: 'Password looks good',
    setup_pwd_mismatch: 'Passwords do not match',
    setup_submit: 'Set password',
    setup_submitting: 'Setting…',
    setup_submit_error: 'Error',
    setup_already_set: 'Already set up?',
    setup_login_link: 'Log in',
    setup_invalid_title: 'Invalid link',
    setup_invalid_body: 'This password-setup link is wrong or corrupted.',
    setup_expired_title: 'Link expired',
    setup_expired_body: 'This link was valid for 7 days. Please ask your NGO admin to re-issue a fresh one.',
    setup_used_title: 'Link already used',
    setup_used_body: 'The password has already been set via this link. Please log in instead.',
    setup_error_title: 'Something went wrong',
    setup_error_body: 'We could not check the link.',
    setup_contact_admin: 'For help: contact@choudhari.ngo',
    setup_back_to_login: 'Back to login',
    lp_reassure: 'Free · 2-minute sign-up · opt out anytime',
    lp_card_live: 'Live request',
    lp_card_matched: 'Matched',
    lp_card_alerted: '3 donors alerted',
    lp_card_critical: 'Critical',
    lp_how_title: 'How it works',
    lp_how_sub: 'Three simple steps from sign-up to a matched donation.',
    lp_how_full_link: 'New here? See the complete journey — from request to transfusion',
    lp_step1_title: 'Register in minutes',
    lp_step1_body:
      'Answer a short health check and set when you are available. In Marathi, Hindi, or English.',
    lp_step2_title: 'A hospital raises a request',
    lp_step2_body:
      'When a patient needs blood, the request is routed to a local coordinator instantly.',
    lp_step3_title: 'We match — privately',
    lp_step3_body:
      'Compatible donors and verified inventory are matched. Your mobile number is never shown to hospitals.',
    lp_trust_title: 'Built for safety and privacy',
    lp_trust1_title: 'Your number stays private',
    lp_trust1_body:
      'Hospitals never see donor contact details. Every conversation goes through a coordinator.',
    lp_trust2_title: 'Lab-verified blood groups',
    lp_trust2_body:
      'Only blood-bank-verified groups are used for matching — never self-reported guesses.',
    lp_trust3_title: 'Every action audited',
    lp_trust3_body:
      'A tamper-evident audit trail records every change from end to end.',
    lp_final_title: 'Ready to save a life?',
    lp_final_body: 'It takes two minutes to register. Become a donor today.',
    lp_footer_org: 'Choudhari EduHealth India Foundation',
    enter_mobile: 'Mobile number',
    send_otp: 'Send OTP',
    enter_otp: '6-digit OTP',
    verify_otp: 'Verify',
    available_today: 'Available today',
    not_available_today: 'Not available right now',
    next_eligible: 'Next eligible',
    total_donations: 'Total donations',
    blood_group: 'Blood group',
    unverified: 'Unverified',
    logout: 'Log out',
    queue_title: 'Request queue',
    raise_request: 'Raise request',
    units: 'units',
    urgency: 'Urgency',
    back: 'Back',
    submit: 'Submit',
    accept: 'Accept',
    cancel: 'Cancel',
    confirm: 'Confirm',
    sign_in: 'Sign in',
    loading: 'Loading…',
    no_records: 'No records',
    open: 'Open',
    open_count: 'open',
    raised_ago: 'ago',
    my_requests: 'My requests',
    raise_new: 'Raise new',
    confirm_crossmatch: 'Confirm crossmatch',
    inventory: 'Inventory',
    record_donation: 'Record donation',
    tti_screening: 'TTI screening',
    opening_stock: 'Opening stock',
    donor_lookup: 'Donor lookup',
    dob_day: 'Day',
    dob_month: 'Month',
    dob_year: 'Year',
    dob_out_of_range: 'Age must be between {min} and {max} years.',
    donor_lang_label: 'Language for messages',
    donor_lang_hint:
      'Your WhatsApp and SMS messages will come in this language. You can change it later in your profile.',
    // OTP errors, donor-facing. otp_err_no_whatsapp is shown ONLY when Meta
    // rejected the number itself — never for an outage or a missing template.
    otp_err_no_whatsapp:
      'This number doesn’t appear to be on WhatsApp, so we could not send the code. Try a number that has WhatsApp, or call +91 98505 41412 if you don’t use WhatsApp.',
    otp_err_send_failed:
      'We could not send the code just now. This one is on our side — please try again in a few minutes.',
    otp_err_rate_limited:
      'Too many codes have been requested for this number. Please wait a while and try again.',
    otp_err_wrong_code: 'That code is not correct, or it has expired. Ask for a new code.',
    otp_err_expired: 'That code has expired. Ask for a new code.',
    otp_err_locked:
      'This account is locked for a while after several wrong attempts. Please try again later.',
    otp_err_bad_mobile: 'Check the mobile number — enter a 10-digit Indian number.',
    otp_err_six_digits: 'Enter the 6-digit code.',
    otp_err_leader_unknown:
      'This number is not registered as a community leader. Please contact the NGO admin.',
    otp_err_offline: 'You appear to be offline. Check your connection and try again.',
    otp_err_generic: 'Something went wrong. Please try again in a little while.',
    otp_send_failed_title: 'We could not send the code',
    otp_resend: 'Send the code again',
    reg_saved_otp_pending:
      'Your details are saved. But we could not send the verification code, so your registration is not finished yet.',
    reg_err_consent_required: 'Please give your consent to continue.',
    reg_err_invalid_details: 'Some details are missing or not valid. Check the fields above.',
    reg_err_submit_failed: 'We could not complete your registration. Please try again shortly.',
    pending_sync_one: '1 change waiting to sync',
    pending_sync_many: '{n} changes waiting to sync',
    retry: 'Retry',
    will_sync_when_online: 'will sync when you’re back online',
  },
};

export function tFor(lang) {
  const table = dict[lang] || dict.en;
  return (key, vars) => {
    const raw = table[key] ?? dict.en[key] ?? key;
    if (!vars) return raw;
    return Object.keys(vars).reduce(
      (acc, k) => acc.replace(new RegExp(`\\{${k}\\}`, 'g'), String(vars[k])),
      raw,
    );
  };
}
