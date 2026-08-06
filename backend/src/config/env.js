const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name, fallback) {
  return process.env[name] ?? fallback;
}

const env = {
  nodeEnv: optional('NODE_ENV', 'development'),
  port: parseInt(optional('PORT', '3000'), 10),
  frontendUrl: optional('FRONTEND_URL', 'http://localhost:5173'),
  logLevel: optional('LOG_LEVEL', 'info'),

  // Staging-only: when true, /auth/otp/send returns the OTP in the response
  // body so a live staging site can be demoed without a working SMS/WhatsApp
  // channel. MUST be false (unset) in real production.
  otpEcho: optional('OTP_ECHO', 'false') === 'true',

  // DPDP §8(7) retention: the data_retention_purge job scrubs PII payload
  // (template_variables, external mobile) from notification_log rows older than
  // this many days. The log row itself is kept for audit/analytics counts.
  piiLogRetentionDays: parseInt(optional('PII_LOG_RETENTION_DAYS', '90'), 10),

  jwt: {
    secret: required('JWT_SECRET'),
    expiresIn: optional('JWT_EXPIRES_IN', '8h'),
  },

  db: {
    url: required('DATABASE_URL'),
    urlProd: optional('DATABASE_URL_PROD', null),
  },

  aws: {
    region: optional('AWS_REGION', 'ap-south-1'),
    s3Bucket: optional('S3_BUCKET_NAME', null),
    kmsMainKeyArn: optional('KMS_MAIN_KEY_ARN', null),
    kmsScreeningKeyArn: optional('KMS_SCREENING_KEY_ARN', null),
  },

  providers: {
    encryption: optional('ENCRYPTION_PROVIDER', 'local'),
    notifications: optional('NOTIFICATIONS_PROVIDER', 'console'),
    storage: optional('STORAGE_PROVIDER', 'local'),
    mail: optional('MAIL_PROVIDER', 'console'),
  },

  local: {
    encryptionKeyHex: optional('LOCAL_ENCRYPTION_KEY_HEX', null),
    screeningEncryptionKeyHex: optional('LOCAL_SCREENING_ENCRYPTION_KEY_HEX', null),
    storageDir: optional('LOCAL_STORAGE_DIR', './.local-storage'),
    outboxDir: optional('LOCAL_OUTBOX_DIR', './.outbox'),
  },

  msg91: {
    authKey: optional('MSG91_AUTH_KEY', null),
    senderId: optional('MSG91_SENDER_ID', 'RAKTFY'),
    whatsappNumber: optional('MSG91_WHATSAPP_NUMBER', null),
    templates: {
      otp: optional('MSG91_TEMPLATE_OTP', null),
      emergencyMr: optional('MSG91_TEMPLATE_EMERGENCY_MR', null),
      emergencyHi: optional('MSG91_TEMPLATE_EMERGENCY_HI', null),
      thankyouMr: optional('MSG91_TEMPLATE_THANKYOU_MR', null),
      reminderMr: optional('MSG91_TEMPLATE_REMINDER_MR', null),
      cred: optional('MSG91_TEMPLATE_CRED', null),
    },
  },

  // WhatsApp Business Cloud API (Meta-hosted, direct — no BSP/DLT).
  // Activates when NOTIFICATIONS_PROVIDER=whatsapp_cloud and these are set.
  whatsapp: {
    phoneNumberId: optional('WHATSAPP_PHONE_NUMBER_ID', null),
    accessToken: optional('WHATSAPP_ACCESS_TOKEN', null),
    wabaId: optional('WHATSAPP_WABA_ID', null),
    webhookVerifyToken: optional('WHATSAPP_WEBHOOK_VERIFY_TOKEN', null),
    appSecret: optional('WHATSAPP_APP_SECRET', null),
    apiVersion: optional('WHATSAPP_API_VERSION', 'v21.0'),
    // Meta-approved template names, keyed by templateType (lower-cased).
    // Add a new entry here when registering a new template in the provider.
    templates: {
      otp: optional('WHATSAPP_TEMPLATE_OTP', null),
      emg: optional('WHATSAPP_TEMPLATE_EMERGENCY', null),
      thk: optional('WHATSAPP_TEMPLATE_THANKYOU', null),
      rem: optional('WHATSAPP_TEMPLATE_REMINDER', null),
      cred: optional('WHATSAPP_TEMPLATE_CRED', null),
      // institutional_setup_link — replaces the rejected `institutional_credentials`
      // template. Used by /onboarding/mou-signed to deliver the magic password-setup
      // link instead of a temp password. See docs/Raktify_WhatsApp_Templates.md.
      setup_link: optional('WHATSAPP_TEMPLATE_SETUP_LINK', null),
      // community_leader_welcome — DEPRECATED. Original Utility template was
      // re-classified MARKETING by Meta after we switched it to a dynamic URL
      // with a constant button value. Kept here so old code paths don't
      // break during rollout; new code uses community_leader_signin below.
      community_leader_welcome: optional('WHATSAPP_TEMPLATE_COMMUNITY_LEADER_WELCOME', null),
      // community_leader_signin — replacement. Per-recipient URL pattern
      // (?m={{1}} = leader's mobile) gives Meta's NLP classifier a unique
      // per-message URL → reads as transactional → Utility category preserved.
      // Frontend /login reads ?m= and pre-fills the mobile field for one-tap OTP.
      community_leader_signin: optional('WHATSAPP_TEMPLATE_COMMUNITY_LEADER_SIGNIN', null),
      // ── V2 donor-alert-gate templates (see docs/Raktify_WhatsApp_Templates.md §8–14) ──
      // All Utility-class. Body vars + a URL-button token pattern. Wiring
      // status: donor_alert_bb + bb_donor_incoming are fired by code today;
      // the other 5 have provider handlers ready but wait on scheduler /
      // coord-panel override wiring (follow-up tasks).
      donor_alert_bb: optional('WHATSAPP_TEMPLATE_DONOR_ALERT_BB', null),
      donor_alert_replace: optional('WHATSAPP_TEMPLATE_DONOR_ALERT_REPLACE', null),
      donor_alert_community: optional('WHATSAPP_TEMPLATE_DONOR_ALERT_COMMUNITY', null),
      bb_donor_incoming: optional('WHATSAPP_TEMPLATE_BB_DONOR_INCOMING', null),
      coord_prefire_warn: optional('WHATSAPP_TEMPLATE_COORD_PREFIRE_WARN', null),
      coord_critical_new: optional('WHATSAPP_TEMPLATE_COORD_CRITICAL_NEW', null),
      community_leader_mobilise: optional('WHATSAPP_TEMPLATE_COMMUNITY_LEADER_MOBILISE', null),
      // donor_consent_invite — magic-link WhatsApp to a donor whose data was
      // pushed into Raktify by a BB software vendor (Safetrans etc.). Asks the
      // donor to accept / decline / defer on Raktify's own /consent/:token
      // screen. See PR (a) of the vendor-webhook integration plan.
      donor_consent_invite: optional('WHATSAPP_TEMPLATE_DONOR_CONSENT_INVITE', null),
    },
  },

  // Leegality (Aadhaar eSign — leegality.com). The legacy `leegally` typo is
  // intentionally retained on the DB columns (mou_versions.leegally_doc_id,
  // .leegally_template_id) to avoid a migration; everywhere else uses the
  // correct spelling. Old LEEGALLY_* env vars are no longer read.
  leegality: {
    authToken: optional('LEEGALITY_AUTH_TOKEN', null),
    privateSalt: optional('LEEGALITY_PRIVATE_SALT', null),
    // Note: Leegality calls this `profileId` (Workflow ID). Our env name
    // is historical — it IS the workflow ID from the dashboard.
    templateId: optional('LEEGALITY_TEMPLATE_ID', null),
    // Production: https://app1.leegality.com/api · Sandbox: https://sandbox.leegality.com/api
    baseUrl: optional('LEEGALITY_BASE_URL', 'https://app1.leegality.com/api'),
  },

  lgd: {
    useApi: optional('LGD_USE_API', 'true') === 'true',
    apiBase: optional('LGD_API_BASE', 'https://lgdirectory.gov.in/api'),
    apiKey: optional('LGD_API_KEY', null),
    csvDir: optional('LGD_CSV_DIR', './data/lgd'),
  },

  matching: {
    // Whether the matcher automatically reserves compatible BB inventory on
    // request creation. Default OFF — Raktify has to earn BB trust before
    // mediating their supply. BBs voluntarily offer via /inventory/open-requests
    // /:requestId/offer instead. Flip to true once we operate our own blood
    // banks or have signed MoUs that authorise auto-reservation.
    bbAutoReserve: optional('MATCHING_BB_AUTO_RESERVE', 'false') === 'true',

    // Donor-alert timing gate (spec V2). Matcher writes to pending_donor_alerts
    // with scheduled_fire_at = now + window. Scheduler evaluates every minute.
    // BBs get an exclusive window to offer voluntarily before donors get pinged.
    donorAlertWindowCrMin: parseInt(optional('DONOR_ALERT_WINDOW_CR_MIN', '3'), 10),
    donorAlertWindowUrMin: parseInt(optional('DONOR_ALERT_WINDOW_UR_MIN', '30'), 10),
    // PLANNED requests now DO fire donor alerts (migration 305 horizon reframe):
    // a planned need days out is the one case a donor can genuinely FULFIL (time
    // to donate → TTI-test → release). BBs still get an exclusive head-start; no
    // minute-rush, so the window is longer.
    donorAlertWindowPlMin: parseInt(optional('DONOR_ALERT_WINDOW_PL_MIN', '120'), 10),

    // Horizon boundary between a donor FULFILLING a request vs only REPLENISHING
    // (donate → screen → TTI test → release). needed_by >= this ⇒ 'FU'; sooner
    // ⇒ 'RP'. Operational value (lab TTI turnaround), founder-set; NOT a clinical
    // constant. Default 24h.
    donationUsableLeadHours: parseInt(optional('DONATION_USABLE_LEAD_HOURS', '24'), 10),

    // Donor-fatigue caps. Rate-limits per donor to protect against "crying
    // wolf" alert-fatigue that kills voluntary-donation platforms.
    donorAlertPoolSizeCap: parseInt(optional('DONOR_ALERT_POOL_SIZE_CAP', '20'), 10),
    donorFatigueCapPerWeek: parseInt(optional('DONOR_FATIGUE_CAP_PER_WEEK', '2'), 10),
    donorRecencySkipHr: parseInt(optional('DONOR_RECENCY_SKIP_HR', '24'), 10),
  },
};

module.exports = env;
