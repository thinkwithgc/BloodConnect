// Marathi + English copy for the organiser-facing camp surfaces.
//
// Lives outside strings.js because that file is already 400+ lines of mostly
// landing copy for three languages; folding ~150 more keys into it would make
// every future diff unreviewable. strings.js spreads this pack FIRST in each
// block, so an existing literal key always wins a collision.
//
// There is deliberately no `hi` export. A Hindi session falls through tFor's
// existing chain to English, which is honest, rather than showing rushed
// Marathi-shaped Hindi. Adding a `hi` here later needs no other change.
//
// Latin digits throughout (10 अंकी, not १० अंकी) — the API returns Latin, the
// printed forms use Latin, and Marathi phone UIs use Latin. One rule, no
// formatter, no mixed rows.

export const mr = {
  // ---- chrome -------------------------------------------------------------
  camp_host_subtitle: 'शिबिर आयोजित करा',
  camp_host_title: 'रक्तदान शिबिर आयोजित करा',
  camp_host_intro:
    'कोणीही शिबिर नोंदवू शकतो — रुग्णालय, रक्तपेढी, शाळा, महाविद्यालय, कंपनी, ' +
    'गृहनिर्माण संस्था, रोटरी / लायन्स क्लब, ग्रामपंचायत किंवा इतर स्वयंसेवी संस्था. ' +
    'Raktify चे खाते असण्याची गरज नाही. आमचे समन्वयक तुमची माहिती पडताळतील आणि ' +
    'तुमच्या स्वयंसेवकांना Raktify चे प्रशिक्षण देतील, जेणेकरून शिबिरातील प्रत्येक ' +
    'रक्तदाता नोंदला जाईल आणि प्रत्येक युनिटचा माग राहील.',
  camp_select: '— निवडा —',
  camp_optional: '— ऐच्छिक —',

  // ---- who is hosting -----------------------------------------------------
  camp_who_hosting: 'शिबिर कोण आयोजित करत आहे?',
  camp_org_type: 'संस्थेचा प्रकार',
  camp_org_type_CC: 'कंपनी / कॉर्पोरेट',
  camp_org_type_EI: 'शाळा / महाविद्यालय',
  camp_org_type_EO: 'स्वयंसेवी संस्था (एनजीओ)',
  camp_org_type_MC: 'वैद्यकीय महाविद्यालय / रुग्णालय',
  camp_org_type_CO: 'वसाहत / मंडळ / सोसायटी',
  camp_org_type_OT: 'इतर',
  camp_org_name: 'संस्थेचे नाव',
  camp_org_name_ph: 'उदा. रोटरी क्लब, अमरावती',

  // ---- when + who collects ------------------------------------------------
  camp_when_who: 'तारीख आणि रक्त कोण गोळा करणार?',
  camp_state: 'राज्य',
  camp_district: 'जिल्हा',
  camp_bb_explainer_1:
    'रक्तपेढी पथक, बेड आणि कोल्ड-चेन पेट्या घेऊन येते. तुमचा एखाद्या रक्तपेढीशी ' +
    'संबंध असेल तर तिचे नाव द्या. माहीत नसेल तर ',
  camp_bb_explainer_strong: 'काहीच अडचण नाही',
  camp_bb_explainer_2: ' — Raktify तुमच्यासाठी व्यवस्था करेल.',
  camp_bb_pick_district_first: 'आधी वरती जिल्हा निवडा, मग येथे रक्तपेढी निवडा.',
  camp_bb_none_1: 'या जिल्ह्यात अजून एकही रक्तपेढी Raktify वर नाही — ',
  camp_bb_none_strong: 'आम्ही रक्त संकलनाची व्यवस्था करू.',
  camp_bb_none_2: ' या प्रश्नाबद्दल तुम्हाला काही करायचे नाही.',
  camp_bb_label: 'पसंतीची रक्तपेढी',
  camp_bb_hint: 'ऐच्छिक. अर्ज तपासताना आमचे एनजीओ पथक रक्तपेढी निश्चित करते.',
  camp_bb_dont_know: 'माहीत नाही — तुम्हीच व्यवस्था करा',
  camp_date: 'शिबिराची तारीख',
  camp_date_hint: 'वरती दिवसावर टॅप करा, किंवा येथे तारीख लिहा.',

  // ---- camp details -------------------------------------------------------
  camp_details: 'शिबिराची माहिती',
  camp_name: 'शिबिराचे नाव',
  camp_name_ph: 'उदा. प्रजासत्ताक दिन रक्तदान शिबिर',
  camp_target: 'अपेक्षित रक्तदाते',
  camp_target_hint: 'ऐच्छिक — अंदाजे किती रक्तदाते येतील?',
  camp_target_ph: 'उदा. 50',
  camp_start_time: 'सुरू होण्याची वेळ',
  camp_end_time: 'संपण्याची वेळ',

  // ---- location -----------------------------------------------------------
  camp_where: 'शिबिर कुठे होणार?',
  camp_taluka: 'तालुका',
  camp_taluka_hint: 'ऐच्छिक — तुम्ही निवडलेल्या जिल्ह्यातील',
  camp_venue: 'ठिकाण',
  camp_venue_ph: 'उदा. सभागृह, संत गाडगे बाबा विद्यापीठ',
  camp_address: 'पत्ता',
  camp_address_ph: 'इमारत / रस्ता / परिसर',
  camp_pincode: 'पिनकोड',

  // ---- volunteer training -------------------------------------------------
  camp_vt: 'स्वयंसेवक प्रशिक्षण',
  camp_vt_check:
    'होय — आमच्या स्वयंसेवकांना Raktify चे प्रशिक्षण द्या, जेणेकरून शिबिरात प्रत्येक ' +
    'रक्तदाता नोंदेल आणि प्रत्येक युनिटचा माग राहील.',
  camp_vt_count: 'किती स्वयंसेवकांना प्रशिक्षण लागेल?',
  camp_vt_count_ph: 'उदा. 6',

  // ---- contact ------------------------------------------------------------
  camp_contact: 'तुमची संपर्क माहिती',
  camp_full_name: 'पूर्ण नाव',
  camp_your_role: 'तुमचे पद',
  camp_your_role_hint: 'उदा. अध्यक्ष, मुख्याध्यापिका, एचआर मॅनेजर',
  camp_mobile: 'मोबाइल (10 अंकी)',
  camp_mobile_hint: 'आमचे समन्वयक याच नंबरवर व्हॉट्सअ‍ॅप / फोन करतील',
  camp_email: 'ईमेल (ऐच्छिक)',
  camp_notes: 'आणखी काही सांगायचे आहे?',
  camp_notes_hint: 'भागीदारी, रक्तपेढीशी संबंध, दिव्यांगांसाठी सोय, इत्यादी.',
  camp_consent_line:
    'अर्ज पाठवून तुम्ही सहमती देता की आमचे समन्वयक तुम्ही दिलेल्या नंबरवर संपर्क करू ' +
    'शकतात. शिबिर आयोजक आणि रक्तदात्यांसाठी Raktify नेहमी मोफत आहे.',
  camp_submit: 'अर्ज पाठवा',

  // ---- validation + errors ------------------------------------------------
  camp_err_review: 'ठळक केलेली माहिती पुन्हा तपासा.',
  camp_err_future: 'तारीख पुढील असावी',
  camp_err_future_top: 'शिबिराची तारीख पुढील असावी.',
  camp_err_end_after_start: 'सुरू होण्याच्या वेळेनंतर असावी',
  camp_err_end_after_start_top: 'संपण्याची वेळ सुरू होण्याच्या वेळेनंतर असावी.',
  camp_err_day_full_field: 'त्या दिवशी ती रक्तपेढी पूर्ण भरली आहे',
  camp_err_day_full:
    '{date} रोजी ती रक्तपेढी अजून एक शिबिर घेऊ शकत नाही. खाली दाखवलेल्या मोकळ्या ' +
    'दिवसांपैकी एक निवडा, किंवा रक्तपेढीचा रकाना रिकामा ठेवा — आम्ही व्यवस्था करू.',
  camp_err_day_full_nodate:
    'ती रक्तपेढी त्या दिवशी अजून एक शिबिर घेऊ शकत नाही. खाली दाखवलेल्या मोकळ्या ' +
    'दिवसांपैकी एक निवडा, किंवा रक्तपेढीचा रकाना रिकामा ठेवा — आम्ही व्यवस्था करू.',
  camp_err_submit_failed: 'अर्ज पाठवता आला नाही. कृपया पुन्हा प्रयत्न करा.',

  // ---- success screen -----------------------------------------------------
  camp_ok_title: 'अर्ज मिळाला',
  camp_ok_thanks:
    'रक्तदान शिबिर आयोजित करण्याची तयारी दाखवल्याबद्दल आभार. आमचे एनजीओ समन्वयक ' +
    'तुम्ही दिलेल्या मोबाइल नंबरवर संपर्क करून माहिती पडताळतील आणि शिबिरात Raktify ' +
    'कसे वापरायचे याचे स्वयंसेवक प्रशिक्षण ठरवतील.',
  camp_ok_app_id: 'अर्ज क्रमांक',
  camp_ok_scheduled: 'तारीख',
  camp_ok_status: 'स्थिती',
  camp_ok_bb_named_1: 'रक्त गोळा करण्यासाठी तुम्ही ',
  camp_ok_bb_named_2:
    ' यांचे नाव सुचवले आहे. आम्ही त्यांच्याशी निश्चित करून तुम्हाला कळवू — ' +
    'सामान्यतः 2-3 दिवसांत.',
  camp_ok_bb_arrange_strong: 'आम्ही रक्तपेढीची व्यवस्था करू',
  camp_ok_bb_arrange_rest:
    ' आणि कोणती रक्तपेढी येणार ते तुम्हाला कळवू. तुम्हाला स्वतः शोधण्याची गरज नाही.',
  camp_ok_track_mine_strong: 'हे शिबिर आता तुमच्या प्रोफाइलमध्ये आहे.',
  camp_ok_track_mine_1:
    ' नोंदणी पाहण्यासाठी, आयोजक लिंक मिळवण्यासाठी आणि अर्ज प्रलंबित असेपर्यंत माहिती ' +
    'दुरुस्त करण्यासाठी ',
  camp_ok_track_mine_2: ' उघडा.',
  camp_ok_track_signin_strong: 'या मोबाइल नंबरने साइन इन करा',
  camp_ok_track_signin_rest:
    ' — हे शिबिर आणि तुम्ही आयोजित केलेली इतर सर्व शिबिरे एकाच ठिकाणी दिसतील. ' +
    'आम्ही ते तुमच्या नावाशी स्वतः जोडू.',
  camp_ok_cta_my_camps: 'माझी शिबिरे पहा',
  camp_ok_cta_signin: 'पाहण्यासाठी साइन इन करा',
  camp_ok_cta_home: 'मुख्यपृष्ठावर परत',
  camp_my_camps: 'माझी शिबिरे',

  // ---- shared status vocabulary (campStatus.js + every camp surface) ------
  camp_status_PE: 'पडताळणी बाकी',
  camp_status_PL: 'नियोजित',
  camp_status_LV: 'सुरू आहे',
  camp_status_CO: 'पूर्ण झाले',
  camp_status_CA: 'रद्द',
  camp_status_DC: 'नाकारले',
  camp_bbr_PE: 'उत्तर बाकी',
  camp_bbr_AC: 'स्वीकारले',
  camp_bbr_DC: 'नाकारले',

  // ---- availability calendar (organiser side) -----------------------------
  camp_cal_heading: 'मोकळे दिवस',
  camp_cal_this_bb: 'ही रक्तपेढी',
  camp_cal_closed: 'बंद',
  camp_cal_closed_title: 'या दिवशी रक्तपेढी शिबिरांसाठी बंद आहे',
  camp_cal_not_planned: 'नियोजन झाले नाही — तरीही तुम्ही हा दिवस मागू शकता',
  camp_cal_slots_left: '{n} मोकळ्या',
  camp_cal_full: 'भरले',
  camp_cal_loading: 'दिवस पाहत आहोत…',
  camp_cal_prev_month: 'मागील महिना',
  camp_cal_next_month: 'पुढील महिना',
  camp_cal_full_title: 'दिवसाच्या सर्व {n} जागा भरल्या आहेत',
  camp_cal_booked_title: '{m} पैकी {c} जागा ठरल्या आहेत',
  camp_cal_lg_free: 'मोकळे',
  camp_cal_lg_full: 'भरले',
  camp_cal_lg_closed: 'बंद',
  camp_cal_lg_unplanned: 'नियोजन नाही',
  camp_cal_lg_pending: '+n? = पडताळणी सुरू असलेले अर्ज',

  // The verdict on the day actually chosen. Each line names the date, because
  // the organiser reads this after tapping around the grid a few times.
  camp_cal_v_dayfull:
    '{date} रोजी जागा नाही — {m} पैकी {c} शिबिरे आधीच ठरली आहेत. वर दुसरा दिवस निवडा.',
  camp_cal_v_closed: '{date} रोजी ते शिबिरांसाठी बंद आहेत. वर दुसरा दिवस निवडा.',
  camp_cal_v_full:
    '{date} रोजी जागा भरली आहे — {m} पैकी {c} शिबिरे ठरली आहेत. वर दुसरा दिवस निवडा.',
  camp_cal_v_room: '{date} रोजी जागा आहे — {m} पैकी {n} जागा मोकळ्या.',
  camp_cal_v_room_pending: ' त्या दिवसासाठी अजून {n} अर्ज पडताळणीत आहे.',
  camp_cal_v_unplanned:
    '{date} साठी त्यांनी नियोजन दिलेले नाही. तरीही अर्ज करा — पडताळणीच्या वेळी आमची ' +
    'टीम त्यांच्याशी निश्चित करते.',
  camp_cal_v_pick: 'शिबिराची तारीख निवडण्यासाठी दिवसावर टॅप करा.',
  camp_cal_footer:
    'तुम्ही कोणतीही तारीख मागू शकता. शिबिर जाहीर करण्यापूर्वी आमची टीम रक्तपेढीशी ' +
    'निश्चित करते.',

  // Month + weekday names are a hardcoded list, NOT toLocaleDateString('mr-IN').
  // Intl's Marathi short-weekday data is not reliably present and its forms are
  // unpredictable — a calendar cell cannot absorb a surprise 6-character
  // weekday. DateOfBirthInput reads the same array, so the DOB picker and the
  // camp calendar can never disagree on a month name.
  // ---- public camp page (/c/:slug) ----------------------------------------
  camp_pub_loading: 'शिबिराची माहिती पाहत आहोत…',
  camp_pub_nf_title: 'शिबिर सापडले नाही',
  camp_pub_nf_body:
    'ही लिंक ओळखता आली नाही — शिबिर रद्द झाले असेल, पूर्ण झाले असेल, किंवा पत्ता ' +
    'चुकीचा लिहिला गेला असेल.',
  camp_pub_nf_cta: 'Raktify मुख्यपृष्ठावर जा',
  camp_pub_eyebrow: 'रक्तदान शिबिर · {district}',
  camp_pub_hosted_by: 'आयोजक: {name}',
  camp_pub_f_date: 'तारीख',
  camp_pub_f_time: 'वेळ',
  camp_pub_f_venue: 'ठिकाण',
  camp_pub_f_signed_up: 'नोंदणी झालेले',
  camp_pub_slots_left: '{n} जागा मोकळ्या',
  camp_pub_partner_bb: 'रक्त गोळा करणारी रक्तपेढी: ',
  camp_pub_done_title: 'तुमचे नाव यादीत आले',
  camp_pub_already_title: 'तुमची नोंदणी आधीच झाली आहे',
  camp_pub_done_body: 'शिबिराच्या एक दिवस आधी आठवण पाठवू. {venue} येथे भेटू.',
  camp_pub_already_body:
    'धन्यवाद — {name} साठी तुमची नोंदणी निश्चित झाली आहे. एक दिवस आधी ठिकाणाची ' +
    'माहिती पाठवू.',
  camp_pub_open_profile: 'माझे रक्तदाता प्रोफाइल उघडा',
  camp_pub_wrong_role_pre: 'तुम्ही ',
  camp_pub_wrong_role_post:
    ' म्हणून साइन इन आहात, रक्तदाता म्हणून नाही. रक्तदाते त्यांच्या स्वतःच्या ' +
    'लॉगिनमधून नोंदणी करू शकतात.',
  camp_pub_back_home: 'मुख्यपृष्ठावर परत',
  camp_pub_reg_title: 'या शिबिरासाठी नोंदणी करा',
  camp_pub_reg_body_rsvp:
    'एका टॅपवर तुमचे नाव यादीत येईल — तुमचा नंबर आयोजकाला दिला जात नाही.',
  camp_pub_reg_body_new:
    'Raktify वर नवीन आहात? मोबाइल OTP ने पटकन नोंदणी, मग तुमचे नाव शिबिरात जोडले जाईल.',
  camp_pub_cta_rsvp: 'मी येणार',
  camp_pub_cta_signup: 'नोंदणी करा आणि सहभागी व्हा',
  camp_pub_already_donor: 'आधीच Raktify रक्तदाता आहात? ',
  camp_pub_login_link: 'साइन इन करून नोंदणी करा',
  camp_pub_err: '{err} — कृपया पुन्हा प्रयत्न करा.',
  camp_pub_expect_title: 'काय अपेक्षित आहे',
  camp_pub_expect_1: 'सरकारी ओळखपत्र आणा (आधार, मतदान कार्ड, वाहन परवाना).',
  camp_pub_expect_2: 'रक्तदानाच्या 2–3 तास आधी नेहमीचे जेवण घ्या. पाणी पित राहा.',
  camp_pub_expect_3:
    'खुर्चीवर बसल्यावर रक्तदानाला सुमारे 10 मिनिटे लागतात. तपासणी आणि नंतरची ' +
    'विश्रांती मिळून एकूण 30–45 मिनिटे.',
  camp_pub_expect_4:
    'तुमचे रक्त HIV, हिपॅटायटीस B, हिपॅटायटीस C, सिफिलीस आणि मलेरियासाठी तपासले ' +
    'जाते — निकाल पूर्णपणे गोपनीय राहतात.',
  camp_pub_expect_5:
    'Raktify तुमचा मोबाइल नंबर आयोजकाला कधीही देत नाही. आयोजक आणि रक्तदाता ' +
    'यांच्यातील सर्व संपर्क प्लॅटफॉर्ममार्फत होतो.',
  camp_pub_powered_pre: '',
  camp_pub_powered_post: ' द्वारे',

  // ---- my camps list + inline edit + collecting-bank line -----------------
  camp_mine_heading: 'माझी शिबिरे',
  camp_mine_empty:
    'तुम्ही आयोजित करण्यासाठी अर्ज केलेली शिबिरे येथे दिसतील — सर्व एकाच ठिकाणी.',
  camp_mine_load_err: 'तुमची शिबिरे आणता आली नाहीत.',
  camp_mine_c_registered: 'नोंदणी',
  camp_mine_c_donated: 'रक्तदान',
  camp_mine_c_deferred: 'देऊ शकले नाहीत',
  camp_mine_c_noshow: 'आले नाहीत',
  camp_mine_declined_why: 'नाकारण्याचे कारण:',
  camp_mine_derived:
    'रक्तपेढी नोंद करेल तसे रक्तदान येथे मोजले जाईल — सहसा पुढच्या कामाच्या दिवशी. ' +
    'हाताने काही खुणा करायची गरज नाही.',
  camp_mine_manage: 'आयोजक पान उघडा →',
  camp_mine_public: 'शिबिराचे सार्वजनिक पान',
  camp_mine_edit: 'माहिती बदला',
  camp_mine_saved: 'जतन झाले.',
  camp_mine_saved_notified: 'जतन झाले. {n} रक्तदात्यांना बदल कळवला.',
  camp_mine_unchanged: 'काहीच बदललेले नव्हते.',

  camp_ed_name: 'शिबिराचे नाव',
  camp_ed_venue: 'ठिकाण',
  camp_ed_address: 'पत्ता',
  camp_ed_org: 'आयोजक संस्था',
  camp_ed_contact_person: 'संपर्क व्यक्ती',
  camp_ed_date: 'तारीख',
  camp_ed_pin: 'पिन कोड',
  camp_ed_starts: 'सुरू',
  camp_ed_ends: 'समाप्त',
  camp_ed_mobile: 'संपर्क मोबाइल',
  camp_ed_mobile_ph: 'रिकामे ठेवले तर आताचाच नंबर राहील',
  camp_ed_donors: 'अपेक्षित रक्तदाते',
  camp_ed_volunteers: 'अपेक्षित स्वयंसेवक',
  camp_ed_training: 'शिबिरापूर्वी स्वयंसेवकांना प्रशिक्षण हवे आहे',
  camp_ed_notify_strong: 'नोंदणी झालेल्या {n} रक्तदात्यांना हा बदल कळवला जाईल',
  camp_ed_notify_rest: ' — जतन केल्यावर लगेच WhatsApp वर.',
  camp_ed_save: 'बदल जतन करा',
  camp_ed_saving: 'जतन करत आहोत…',
  camp_ed_cancel: 'रद्द',
  camp_ed_blank_note:
    'रिकामी ठेवलेली जागा आताचीच माहिती ठेवते. शिबिराची स्थिती बदलत नाही.',
  camp_ed_err_generic: 'जतन झाले नाही ({err}).',
  camp_ed_e_past: 'होऊन गेलेली तारीख निवडू नका.',
  camp_ed_e_reject: 'समाप्तीची वेळ सुरुवातीच्या वेळेनंतर असावी.',
  camp_ed_e_not_editable:
    'हे शिबिर आता बदलता येत नाही. सध्याची स्थिती पाहण्यासाठी पान रिफ्रेश करा.',
  camp_ed_e_not_owner: 'हे शिबिर तुमचे नाही.',
  camp_ed_e_mobile: '10 अंकी भारतीय मोबाइल नंबर टाका.',
  camp_ed_e_invalid: 'वरची माहिती तपासा — काहीतरी अपेक्षित स्वरूपात नाही.',
  camp_ed_e_not_found: 'हे शिबिर आता अस्तित्वात नाही.',

  camp_cbl_declined: 'तुमच्या शिबिरासाठी दुसरी रक्तपेढी ठरवत आहोत — लवकरच कळवू.',
  camp_cbl_confirmed: 'रक्त गोळा करणार: {bb} — निश्चित.',
  camp_cbl_pending: 'रक्त गोळा करणार: {bb} — त्यांच्या होकाराची वाट पाहत आहोत.',
  camp_cbl_plain: 'रक्त गोळा करणार: {bb}.',
  camp_cbl_requested:
    'तुम्ही {bb} मागितली आहे. रक्त कोण गोळा करणार ते लवकरच कळवू.',

  // ---- organiser dashboard (magic-link) -----------------------------------
  camp_od_loading: 'तुमचा आढावा उघडत आहोत…',
  camp_od_no_access: 'हे पान उघडता आले नाही',
  camp_od_e_expired:
    'या दुव्याची मुदत संपली आहे. Raktify एनजीओ प्रशासकाकडून नवा दुवा मागवा.',
  camp_od_e_revoked: 'हा दुवा बंद करण्यात आला आहे. Raktify एनजीओ प्रशासकाशी संपर्क करा.',
  camp_od_e_invalid: 'हा दुवा ओळखता आला नाही. URL पुन्हा तपासा.',
  camp_od_home: 'Raktify मुख्यपृष्ठावर जा',
  camp_od_eyebrow: 'आयोजक आढावा',
  camp_od_shell_tag: 'शिबिर आयोजक',
  camp_od_granted:
    'हा दुवा {name} यांना दिला आहे. मुदत {date} पर्यंत. दुवा सर्वांना पाठवू नका.',

  camp_od_k_registered: 'नोंदणी झाली',
  camp_od_k_target: 'लक्ष्य {n}',
  camp_od_k_donated: 'रक्तदान झाले',
  camp_od_k_donated_sub: 'रक्तपेढीच्या नोंदीनुसार',
  camp_od_k_deferred: 'देऊ शकले नाहीत',
  camp_od_k_deferred_sub: 'तपासणीत नाकारले',
  camp_od_k_turnout: 'प्रत्यक्ष आले',
  camp_od_k_turnout_ns: '{n} आले नाहीत',
  camp_od_k_turnout_sub: 'रक्तदान + नाकारलेले',
  camp_od_k_units: 'गोळा झालेली युनिट',
  camp_od_k_units_sub: 'रक्तपेढीकडून',

  camp_od_st_RG: 'नोंदणी झाली',
  camp_od_st_AT: 'रक्तदान झाले',
  camp_od_st_DF: 'आले, देऊ शकले नाहीत',
  camp_od_st_NS: 'आले नाहीत',
  camp_od_st_CN: 'रद्द',

  camp_od_bc_title: 'नोंदणी झालेल्या रक्तदात्यांना निरोप पाठवा',
  camp_od_bc_hint:
    'नोंदणी केलेल्या सर्वांना WhatsApp वर (नाही जमले तर SMS) निरोप जाईल. ' +
    'ठिकाण बदलले, ओळखपत्र आणायची आठवण, किंवा शिबिरानंतर आभार — यासाठी वापरा.',
  camp_od_bc_ph:
    'उदा. ठिकाण बदलले आहे — संत गाडगे बाबा विद्यापीठ, हॉल 2. सरकारी ओळखपत्र आणा. ' +
    'सकाळी 8 पासून अल्पोपाहार मिळेल.',
  camp_od_bc_send: '{n} रक्तदात्यांना पाठवा',
  camp_od_bc_queued: '{n} निरोप पाठवायला दिले.',

  // ---- organiser branding -------------------------------------------------
  // camp_brand_organiser is the label above the organiser's own name on the
  // public camp page. Everything else here is the organiser's dashboard block.
  camp_brand_organiser: 'आयोजक',
  camp_brand_title: 'शिबिराच्या पानावर तुमची ओळख',
  camp_brand_hint:
    'तुमच्या संस्थेचा लोगो आणि तुमच्या शब्दांत थोडक्यात ओळख — तुम्ही जो दुवा रक्तदात्यांना ' +
    'पाठवता त्या पानावर दिसेल. दोन्ही न दिले तरी चालते.',
  camp_brand_logo_label: 'संस्थेचा लोगो किंवा फोटो',
  camp_brand_logo_help: 'JPG किंवा PNG. फोटो पाठवण्याआगोदर आपोआप लहान केला जातो.',
  camp_brand_logo_pick: 'फाइल निवडा',
  camp_brand_logo_replace: 'बदला',
  camp_brand_uploading: 'पाठवत आहे…',
  camp_brand_logo_saved: 'लोगो पाठवला.',
  camp_brand_tagline_label: 'तुमच्या शब्दांत एक ओळ',
  camp_brand_tagline_ph: 'उदा. 1985 पासून अमरावतीत समाजकार्य.',
  camp_brand_save: 'जतन करा',
  camp_brand_saved: 'जतन झाले.',
  camp_brand_st_PE: 'पडताळणी बाकी',
  camp_brand_st_AP: 'मंजूर',
  camp_brand_st_RJ: 'नाकारले',
  camp_brand_st_PE_hint:
    'पडताळणी होईपर्यंत हे शिबिराच्या पानावर दिसणार नाही. सामान्यतः एक-दोन दिवसांत होते.',
  camp_brand_st_AP_hint: 'हे शिबिराच्या पानावर दिसत आहे.',
  camp_brand_st_RJ_note: 'कारण: {note}',
  camp_brand_recheck_hint: 'येथे काही बदलले तर पुन्हा एकदा पडताळणी होते.',
  camp_brand_e_too_large: 'फाइल खूप मोठी आहे. लहान फोटो निवडा.',
  camp_brand_e_type: 'फक्त JPG किंवा PNG फाइल चालेल.',
  camp_brand_e_failed: 'पाठवता आले नाही. पुन्हा प्रयत्न करा.',
  camp_brand_e_decode: 'ही फाइल वाचता आली नाही. दुसरा फोटो निवडून पहा.',

  camp_od_roster: 'यादी ({n})',
  camp_od_roster_auto: 'रक्तपेढी नोंद करेल तसे हजेरी आपोआप भरेल.',
  camp_od_note_1:
    ' — हे रक्तपेढीने नोंद केल्यावर आपोआप दिसते, बहुतेक शिबिराच्या दिवशीच, कधी ' +
    'दुसऱ्या दिवशी सकाळी. शिबिरानंतर दोन दिवसांनी जे अजूनही ',
  camp_od_note_2: ' असतील ते आपोआप ',
  camp_od_note_3: ' होतात. येथे हाताने नोंदवायची एकच गोष्ट — आलेला पण ',
  camp_od_note_turned: 'तपासणीत नाकारलेला',
  camp_od_note_4: ' रक्तदाता; तेवढेच नोंदवा, कारण नको.',
  camp_od_e_derived:
    'हजेरी हाताने लावता येत नाही — रक्तपेढी या शिबिरावर नोंदवेल त्या रक्तदानातून ती येते.',

  camp_od_th_donor: 'रक्तदाता',
  camp_od_th_group: 'रक्तगट',
  camp_od_th_rsvp: 'नोंदणी',
  camp_od_th_status: 'स्थिती',
  camp_od_th_record: 'नोंद',
  camp_od_deferred_warn: '⚠ सध्या थांबवलेले — आज रक्तदान करू शकत नाहीत',
  camp_od_btn_df: 'देऊ शकले नाहीत',
  camp_od_btn_cancel: 'रद्द',
  camp_od_btn_undo: 'पूर्वीसारखे करा',
  camp_od_by_bb: 'रक्तपेढीने नोंदवले',
  camp_od_no_rsvp: 'अजून नोंदणी नाही — रक्तदाते नोंदणी करतील तसे येथे दिसतील.',
  camp_od_help: 'मदत हवी? एनजीओ समन्वयकांनी दिलेल्या नंबरवर WhatsApp करा.',

  camp_od_share_title: 'रक्तदात्यांना बोलवा',
  camp_od_share_hint: 'प्रत्येक दुव्यावर वेगळी खूण असते, त्यामुळे कोणता मार्ग चालतो ते कळते.',
  camp_od_copy: 'कॉपी करा',
  camp_od_copied: 'कॉपी झाले!',
  camp_od_copy_fail: 'कॉपी झाले नाही — दुव्यावर बोट दाबून धरा.',
  camp_od_ig: 'Instagram (मजकूर कॉपी)',
  camp_od_ig_title:
    'Instagram थेट दुवा घेत नाही — हा मजकूर कॉपी करून Story किंवा bio मध्ये टाका',
  camp_od_ig_hint:
    'Instagram थेट share दुवा देत नाही. वरचे बटण दाबून तयार मजकूर कॉपी करा आणि ' +
    'Story च्या link sticker मध्ये किंवा bio मध्ये टाका.',
  camp_od_scan: 'नोंदणीसाठी स्कॅन करा',
  camp_od_print: 'हे पान छापा',
  camp_od_share_subject: 'रक्तदान शिबिर: {name}',
  camp_od_share_body:
    '🩸 रक्तदान शिबिर: {name}\n📅 {date} · {time}\n📍 {venue}\n\n' +
    'तुम्ही रक्तदान करू शकत असाल तर येथे नोंदणी करा:',

  camp_od_mix_title: 'नोंदणी कुठून आली',
  camp_od_mix_hint: 'तुमच्या दुव्यांवरील खुणेवरून मोजले जाते.',
  camp_od_ch_qr: 'QR पोस्टर',
  camp_od_ch_direct: 'थेट दुवा',
  camp_od_ch_web: 'वेब',

  camp_months: [
    'जानेवारी', 'फेब्रुवारी', 'मार्च', 'एप्रिल', 'मे', 'जून',
    'जुलै', 'ऑगस्ट', 'सप्टेंबर', 'ऑक्टोबर', 'नोव्हेंबर', 'डिसेंबर',
  ],
  camp_weekdays_short: ['रवि', 'सोम', 'मंगळ', 'बुध', 'गुरु', 'शुक्र', 'शनि'],
  camp_weekdays: [
    'रविवार', 'सोमवार', 'मंगळवार', 'बुधवार', 'गुरुवार', 'शुक्रवार', 'शनिवार',
  ],
  // Short forms for the one-line day chip ("शनि 14 सप्टें"). Kept separate from
  // camp_months because a chip and a month heading have very different budgets.
  camp_months_short: [
    'जाने', 'फेब्रु', 'मार्च', 'एप्रि', 'मे', 'जून',
    'जुलै', 'ऑग', 'सप्टें', 'ऑक्टो', 'नोव्हें', 'डिसें',
  ],
};

// Every key needs an English value too. It is what the `en` picker serves, what
// Hindi falls back to, and the reviewable reference for each Marathi line above.
export const en = {
  camp_host_subtitle: 'Host a camp',
  camp_host_title: 'Host a blood donation camp',
  camp_host_intro:
    'Anyone can register a camp — hospitals, blood banks, schools, colleges, ' +
    'corporates, housing societies, Rotary / Lions clubs, panchayats, or other ' +
    'NGOs. You do not need a Raktify account. Our NGO coordinator will verify ' +
    'your details and train your volunteers on how to use Raktify so every ' +
    'donor at the camp gets registered and every unit gets traced.',
  camp_select: '— select —',
  camp_optional: '— optional —',

  camp_who_hosting: 'Who is hosting?',
  camp_org_type: 'Organisation type',
  camp_org_type_CC: 'Corporate / company',
  camp_org_type_EI: 'Educational institution / college',
  camp_org_type_EO: 'NGO or external organisation',
  camp_org_type_MC: 'Medical college / hospital',
  camp_org_type_CO: 'Community / neighbourhood group',
  camp_org_type_OT: 'Other',
  camp_org_name: 'Organisation name',
  camp_org_name_ph: 'e.g. Rotary Club of Amravati',

  camp_when_who: 'When, and who will collect the blood?',
  camp_state: 'State',
  camp_district: 'District',
  camp_bb_explainer_1:
    'The blood bank sends the team, the beds and the cold-chain boxes. If you ' +
    'already work with one, name it here. If you do not know one, ',
  camp_bb_explainer_strong: 'that is perfectly fine',
  camp_bb_explainer_2: ' - Raktify will arrange it for you.',
  camp_bb_pick_district_first:
    'Choose the district above first, then pick a blood bank here.',
  camp_bb_none_1: 'No blood bank is on Raktify in this district yet - ',
  camp_bb_none_strong: 'we will arrange collection for you.',
  camp_bb_none_2: ' Nothing to do on this question.',
  camp_bb_label: 'Preferred blood bank',
  camp_bb_hint:
    'Optional. Our NGO team confirms the blood bank when we review your application.',
  camp_bb_dont_know: 'I do not know - please arrange one for us',
  camp_date: 'Camp date',
  camp_date_hint: 'Tap a day above, or type it here.',

  camp_details: 'Camp details',
  camp_name: 'Camp name',
  camp_name_ph: 'e.g. Republic Day Donation Drive',
  camp_target: 'Target donors',
  camp_target_hint: 'Optional — roughly how many donors are you expecting?',
  camp_target_ph: 'e.g. 50',
  camp_start_time: 'Start time',
  camp_end_time: 'End time',

  camp_where: 'Where will it be held?',
  camp_taluka: 'Taluka',
  camp_taluka_hint: 'Optional — inside the district you chose above',
  camp_venue: 'Venue',
  camp_venue_ph: 'e.g. Auditorium, Sant Gadge Baba University',
  camp_address: 'Address',
  camp_address_ph: 'Building / street / locality',
  camp_pincode: 'Pincode',

  camp_vt: 'Volunteer training',
  camp_vt_check:
    'Yes — please train our volunteers on Raktify so we can register every ' +
    'donor and trace every unit during the camp.',
  camp_vt_count: 'How many volunteers will need training?',
  camp_vt_count_ph: 'e.g. 6',

  camp_contact: 'Your contact details',
  camp_full_name: 'Full name',
  camp_your_role: 'Your role',
  camp_your_role_hint: 'e.g. President, Headmistress, HR Manager',
  camp_mobile: 'Mobile (10-digit)',
  camp_mobile_hint: 'Our coordinator will WhatsApp / call you on this number',
  camp_email: 'Email (optional)',
  camp_notes: "Anything else you'd like us to know?",
  camp_notes_hint: 'Partnerships, blood-bank tie-ups, accessibility needs, etc.',
  camp_consent_line:
    'By submitting you agree that our coordinator may contact you on the number ' +
    'you provided. Raktify is free for camp hosts and donors — always.',
  camp_submit: 'Submit application',

  camp_err_review: 'Please review the highlighted fields.',
  camp_err_future: 'must be a future date',
  camp_err_future_top: 'Camp date must be in the future.',
  camp_err_end_after_start: 'must be after start time',
  camp_err_end_after_start_top: 'End time must be after start time.',
  camp_err_day_full_field: 'that blood bank is full on this day',
  camp_err_day_full:
    'That blood bank cannot take another camp on {date}. Pick one of the open ' +
    'days shown below, or leave the blood bank blank and we will arrange one.',
  camp_err_day_full_nodate:
    'That blood bank cannot take another camp on that date. Pick one of the ' +
    'open days shown below, or leave the blood bank blank and we will arrange one.',
  camp_err_submit_failed: 'Could not send the application. Please try again.',

  camp_ok_title: 'Application received',
  camp_ok_thanks:
    'Thank you for offering to host a donation camp. Our NGO coordinator will ' +
    'contact you on the mobile number you provided to verify details and arrange ' +
    'volunteer training on how to use Raktify during the camp.',
  camp_ok_app_id: 'Application ID',
  camp_ok_scheduled: 'Scheduled',
  camp_ok_status: 'Status',
  camp_ok_bb_named_1: 'You asked for ',
  camp_ok_bb_named_2:
    ' to collect. We will confirm it with them and tell you - normally within 2-3 days.',
  camp_ok_bb_arrange_strong: 'We will arrange a blood bank',
  camp_ok_bb_arrange_rest:
    ' and tell you which one is coming. You do not have to find one yourself.',
  camp_ok_track_mine_strong: 'This camp is now in your profile.',
  camp_ok_track_mine_1: ' Open ',
  camp_ok_track_mine_2:
    ' to follow registrations, get the organiser link and correct the details ' +
    'while it is still pending.',
  camp_ok_track_signin_strong: 'Sign in with this mobile number',
  camp_ok_track_signin_rest:
    ' to track this camp - and any other you host - from one place. We will ' +
    'link it to you automatically.',
  camp_ok_cta_my_camps: 'Go to my camps',
  camp_ok_cta_signin: 'Sign in to track it',
  camp_ok_cta_home: 'Back to home',
  camp_my_camps: 'My camps',

  camp_status_PE: 'Pending review',
  camp_status_PL: 'Planned',
  camp_status_LV: 'Live',
  camp_status_CO: 'Completed',
  camp_status_CA: 'Cancelled',
  camp_status_DC: 'Declined',
  camp_bbr_PE: 'Awaiting reply',
  camp_bbr_AC: 'Accepted',
  camp_bbr_DC: 'Declined',

  camp_cal_heading: 'Open days',
  camp_cal_this_bb: 'This blood bank',
  camp_cal_closed: 'Closed',
  camp_cal_closed_title: 'The blood bank is closed for camps this day',
  camp_cal_not_planned: 'Not planned yet — you can still ask for this day',
  camp_cal_slots_left: '{n} left',
  camp_cal_full: 'Full',
  camp_cal_loading: 'Checking days…',
  camp_cal_prev_month: 'Previous month',
  camp_cal_next_month: 'Next month',
  camp_cal_full_title: 'All {n} camp slots are taken',
  camp_cal_booked_title: '{c} of {m} slots booked',
  camp_cal_lg_free: 'free',
  camp_cal_lg_full: 'full',
  camp_cal_lg_closed: 'closed',
  camp_cal_lg_unplanned: 'not planned yet',
  camp_cal_lg_pending: '+n? = applications being reviewed',

  camp_cal_v_dayfull:
    'Fully booked on {date} — {c} of {m} camps already taken. Pick another day above.',
  camp_cal_v_closed: 'They are closed for camps on {date}. Pick another day above.',
  camp_cal_v_full:
    'Already full on {date} — {c} of {m} camps taken. Pick another day above.',
  camp_cal_v_room: 'Room on {date} — {n} of {m} slots still free.',
  camp_cal_v_room_pending: ' {n} other application for that day is being reviewed.',
  camp_cal_v_unplanned:
    'They have not published a plan for {date} yet. Go ahead — our team confirms it ' +
    'with them when we review your application.',
  camp_cal_v_pick: 'Tap a day to choose it as your camp date.',
  camp_cal_footer:
    'You can still apply for any date. Our NGO team confirms the blood bank before ' +
    'the camp is published.',

  camp_pub_loading: 'Loading camp…',
  camp_pub_nf_title: 'Camp not found',
  camp_pub_nf_body:
    'This camp link is not recognised — it may have been cancelled, completed, or the ' +
    'URL was mistyped.',
  camp_pub_nf_cta: 'Go to Raktify home',
  camp_pub_eyebrow: 'Blood donation camp · {district}',
  camp_pub_hosted_by: 'Hosted by {name}',
  camp_pub_f_date: 'Date',
  camp_pub_f_time: 'Time',
  camp_pub_f_venue: 'Venue',
  camp_pub_f_signed_up: 'Already signed up',
  camp_pub_slots_left: '{n} slots left',
  camp_pub_partner_bb: 'Partner blood bank: ',
  camp_pub_done_title: 'You’re on the list',
  camp_pub_already_title: 'You’re already registered',
  camp_pub_done_body:
    'We’ll send you a reminder a day before the camp. See you at {venue}.',
  camp_pub_already_body:
    'Thanks — your RSVP for {name} is confirmed. We’ll message you a day before with ' +
    'the venue details.',
  camp_pub_open_profile: 'Open my donor profile',
  camp_pub_wrong_role_pre: 'You’re signed in as ',
  camp_pub_wrong_role_post: ', not a donor. Donors can RSVP from their own login.',
  camp_pub_back_home: 'Back to home',
  camp_pub_reg_title: 'Register for this camp',
  camp_pub_reg_body_rsvp:
    'One tap and you’re on the roster — we won’t share your phone with the organiser.',
  camp_pub_reg_body_new:
    'New to Raktify? Quick mobile-OTP signup, then you’ll be added to the camp.',
  camp_pub_cta_rsvp: 'I will be there',
  camp_pub_cta_signup: 'Sign up & register',
  camp_pub_already_donor: 'Already a Raktify donor? ',
  camp_pub_login_link: 'Log in to RSVP',
  camp_pub_err: '{err} — please try again.',
  camp_pub_expect_title: 'What to expect',
  camp_pub_expect_1: 'Bring a government photo ID (Aadhaar, voter ID, driving licence).',
  camp_pub_expect_2: 'Eat a normal meal 2–3 hours before. Stay hydrated.',
  camp_pub_expect_3:
    'Donation takes ~10 minutes once you are on the couch. The full visit (screening ' +
    '+ post-donation rest) is about 30–45 minutes.',
  camp_pub_expect_4:
    'Your donation will be tested for HIV, Hepatitis B, Hepatitis C, syphilis and ' +
    'malaria before being released — your results stay confidential.',
  camp_pub_expect_5:
    'Raktify never shares your phone number with the organiser. All ' +
    'organiser-to-donor communication goes through the platform.',
  camp_pub_powered_pre: 'Powered by ',
  camp_pub_powered_post: '',

  camp_mine_heading: 'Camps I host',
  camp_mine_empty:
    'Camps you apply to host will appear here so you can track every one of them in ' +
    'one place.',
  camp_mine_load_err: 'Could not load your camps.',
  camp_mine_c_registered: 'registered',
  camp_mine_c_donated: 'donated',
  camp_mine_c_deferred: 'couldn’t donate',
  camp_mine_c_noshow: 'did not come',
  camp_mine_declined_why: 'Why this was declined:',
  camp_mine_derived:
    'Donations are counted here as soon as the blood bank records them - usually the ' +
    'next working day. Nothing to mark by hand.',
  camp_mine_manage: 'Open organiser dashboard →',
  camp_mine_public: 'Public camp page',
  camp_mine_edit: 'Edit details',
  camp_mine_saved: 'Saved.',
  camp_mine_saved_notified: 'Saved. {n} donors told about the change.',
  camp_mine_unchanged: 'Nothing had changed.',

  camp_ed_name: 'Camp name',
  camp_ed_venue: 'Venue',
  camp_ed_address: 'Address',
  camp_ed_org: 'Organisation hosting',
  camp_ed_contact_person: 'Contact person',
  camp_ed_date: 'Date',
  camp_ed_pin: 'PIN code',
  camp_ed_starts: 'Starts',
  camp_ed_ends: 'Ends',
  camp_ed_mobile: 'Contact mobile',
  camp_ed_mobile_ph: 'Leave blank to keep the current number',
  camp_ed_donors: 'Donors expected',
  camp_ed_volunteers: 'Volunteers expected',
  camp_ed_training: 'We would like volunteer training before the camp',
  camp_ed_notify_strong: '{n} registered donors will be told about this change',
  camp_ed_notify_rest: ' on WhatsApp as soon as you save.',
  camp_ed_save: 'Save changes',
  camp_ed_saving: 'Saving…',
  camp_ed_cancel: 'Cancel',
  camp_ed_blank_note: 'A box left blank keeps its current value. The camp keeps its status.',
  camp_ed_err_generic: 'Could not save ({err}).',
  camp_ed_e_past: 'Pick a date that has not already passed.',
  camp_ed_e_reject: 'The end time has to be later than the start time.',
  camp_ed_e_not_editable:
    'This camp can no longer be edited. Refresh to see its current state.',
  camp_ed_e_not_owner: 'This camp is not yours to edit.',
  camp_ed_e_mobile: 'Enter a 10-digit Indian mobile number.',
  camp_ed_e_invalid: 'Please check the details above - something is not in the expected format.',
  camp_ed_e_not_found: 'This camp no longer exists.',

  camp_cbl_declined:
    'We’re arranging a different blood bank for your camp — we’ll confirm shortly.',
  camp_cbl_confirmed: 'Collection by {bb} — confirmed.',
  camp_cbl_pending: 'Collection by {bb} — waiting for them to confirm.',
  camp_cbl_plain: 'Collection by {bb}.',
  camp_cbl_requested:
    'You asked for {bb}. We’ll confirm the collecting blood bank shortly.',

  camp_od_loading: 'Loading your dashboard…',
  camp_od_no_access: 'Access not available',
  camp_od_e_expired: 'This link has expired. Please ask the Raktify NGO admin for a fresh link.',
  camp_od_e_revoked: 'This link has been revoked. Please contact the Raktify NGO admin.',
  camp_od_e_invalid: 'This link is not recognised. Double-check the URL.',
  camp_od_home: 'Go to Raktify home',
  camp_od_eyebrow: 'Camp organizer dashboard',
  camp_od_shell_tag: 'Camp organizer',
  camp_od_granted:
    'Access granted to {name}. Link expires {date}. Don’t share this link publicly.',

  camp_od_k_registered: 'Registered',
  camp_od_k_target: 'Target {n}',
  camp_od_k_donated: 'Donated',
  camp_od_k_donated_sub: 'from blood bank records',
  camp_od_k_deferred: 'Couldn’t donate',
  camp_od_k_deferred_sub: 'turned away at screening',
  camp_od_k_turnout: 'Turnout',
  camp_od_k_turnout_ns: '{n} did not come',
  camp_od_k_turnout_sub: 'donated + turned away',
  camp_od_k_units: 'Units collected',
  camp_od_k_units_sub: 'from blood bank',

  camp_od_st_RG: 'Registered',
  camp_od_st_AT: 'Donated',
  camp_od_st_DF: 'Came, couldn’t donate',
  camp_od_st_NS: 'No-show',
  camp_od_st_CN: 'Cancelled',

  camp_od_bc_title: 'Send an update to registered donors',
  camp_od_bc_hint:
    'The message goes via WhatsApp (or SMS as fallback) to everyone who’s RSVP’d for this ' +
    'camp. Use it for venue changes, ID reminders, or thank-yous after the camp.',
  camp_od_bc_ph:
    'e.g. Venue updated to Hall 2 of Sant Gadge Baba University. Please carry a govt ID. ' +
    'Light breakfast will be served from 8am.',
  camp_od_bc_send: 'Send to {n} donors',
  camp_od_bc_queued: 'Queued {n} messages.',

  camp_brand_organiser: 'Organiser',
  camp_brand_title: 'Your identity on the camp page',
  camp_brand_hint:
    'Your organisation’s logo and a short line in your own words — both appear on the page ' +
    'donors see when you share the link. Neither is required.',
  camp_brand_logo_label: 'Organisation logo or photo',
  camp_brand_logo_help: 'JPG or PNG. The image is shrunk automatically before it is sent.',
  camp_brand_logo_pick: 'Choose a file',
  camp_brand_logo_replace: 'Replace',
  camp_brand_uploading: 'Sending…',
  camp_brand_logo_saved: 'Logo sent.',
  camp_brand_tagline_label: 'One line in your own words',
  camp_brand_tagline_ph: 'e.g. Serving Amravati since 1985.',
  camp_brand_save: 'Save',
  camp_brand_saved: 'Saved.',
  camp_brand_st_PE: 'Awaiting check',
  camp_brand_st_AP: 'Approved',
  camp_brand_st_RJ: 'Not approved',
  camp_brand_st_PE_hint:
    'This stays off the camp page until it has been checked, usually within a day or two.',
  camp_brand_st_AP_hint: 'This is showing on the camp page.',
  camp_brand_st_RJ_note: 'Reason: {note}',
  camp_brand_recheck_hint: 'Any change here goes for a fresh check.',
  camp_brand_e_too_large: 'That file is too large. Choose a smaller image.',
  camp_brand_e_type: 'Only JPG or PNG files work.',
  camp_brand_e_failed: 'Could not send that. Please try again.',
  camp_brand_e_decode: 'That image could not be read. Please try a different file.',

  camp_od_roster: 'Roster ({n})',
  camp_od_roster_auto: 'Attendance fills itself as the blood bank records donations.',
  camp_od_note_1:
    ' appears on its own when the blood bank records that donation - usually during the ' +
    'camp, sometimes the next morning. Anyone still ',
  camp_od_note_2: ' two days after the camp becomes a ',
  camp_od_note_3: ' automatically. The one thing to record here is a donor who came and was ',
  camp_od_note_turned: 'turned away at screening',
  camp_od_note_4: ' - and only that they were, never why.',
  camp_od_e_derived:
    'Attendance is not set by hand - it comes from the donation the blood bank records ' +
    'against this camp.',

  camp_od_th_donor: 'Donor',
  camp_od_th_group: 'Blood group',
  camp_od_th_rsvp: 'RSVP’d',
  camp_od_th_status: 'Status',
  camp_od_th_record: 'Record',
  camp_od_deferred_warn: '⚠ currently deferred — may not donate today',
  camp_od_btn_df: 'Couldn’t donate',
  camp_od_btn_cancel: 'Cancel',
  camp_od_btn_undo: 'Undo',
  camp_od_by_bb: 'recorded by blood bank',
  camp_od_no_rsvp: 'No RSVPs yet — registrations will appear here as donors sign up.',
  camp_od_help: 'Need help? WhatsApp the NGO coordinator on the number they shared with you.',

  camp_od_share_title: 'Invite donors',
  camp_od_share_hint: 'Every share carries a different ?via= so you can see which channels work.',
  camp_od_copy: 'Copy',
  camp_od_copied: 'Copied!',
  camp_od_copy_fail: 'Copy failed — long-press the link.',
  camp_od_ig: 'Instagram (copy text)',
  camp_od_ig_title:
    'Instagram doesn’t accept direct share links — copy this text then paste into your ' +
    'Story or bio',
  camp_od_ig_hint:
    'Instagram doesn’t support direct share URLs. Tap the button above to copy a ' +
    'ready-to-paste message; add it to your Story link sticker or bio.',
  camp_od_scan: 'Scan to register',
  camp_od_print: 'Print this page',
  camp_od_share_subject: 'Blood donation camp: {name}',
  camp_od_share_body:
    '🩸 Blood donation camp: {name}\n📅 {date} · {time}\n📍 {venue}\n\n' +
    'If you can donate, please register here:',

  camp_od_mix_title: 'Where RSVPs came from',
  camp_od_mix_hint: 'Tracked from the ?via= parameter on your share links.',
  camp_od_ch_qr: 'QR poster',
  camp_od_ch_direct: 'Direct link',
  camp_od_ch_web: 'Web',

  camp_months: [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ],
  camp_weekdays_short: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  camp_weekdays: [
    'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
  ],
  camp_months_short: [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ],
};
