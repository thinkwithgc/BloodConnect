/**
 * WhatsApp Business Cloud API provider (Meta-hosted, direct).
 *
 * Sends template messages via the Meta Graph API:
 *   POST https://graph.facebook.com/<version>/<phone-number-id>/messages
 *
 * No BSP middleman, and no India DLT registration — WhatsApp messages clear
 * Meta's own template review, not the telecom DLT system.
 *
 * Contract (matches console/msg91 providers):
 *   send(payload) -> { success, provider, messageId, deliveryStatus }
 *   payload = { recipientId, recipientMobile, templateType, variables, language }
 *
 * Activation: NOTIFICATIONS_PROVIDER=whatsapp_cloud + the WHATSAPP_* env vars.
 * Until the Meta WhatsApp Business Account, access token, and approved
 * templates exist, this provider returns a clean failure rather than throwing.
 */
const env = require('../../config/env');
const logger = require('../../config/logger');

const GRAPH = 'https://graph.facebook.com';
const SEND_TIMEOUT_MS = 10_000;

// Meta language codes for our three supported languages.
const LANG = { mr: 'mr', hi: 'hi', en: 'en' };

function isConfigured() {
  return Boolean(env.whatsapp.accessToken && env.whatsapp.phoneNumberId);
}

// WhatsApp `to` wants the number in international form, digits only, no '+'.
// donors.mobile is stored as +91XXXXXXXXXX -> 91XXXXXXXXXX.
function toWhatsAppNumber(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits || null;
}

/**
 * Build the `components` array for a template send.
 *
 * OTP (templateType 'OTP') is an Authentication-category template: it needs
 * the code in BOTH the body parameter and the copy-code/URL button parameter.
 * If your approved authentication template uses a copy-code button instead of
 * a URL button, change sub_type to 'copy_code'.
 *
 * All other templates are treated as Utility templates: the body's {{1}},
 * {{2}}, … positional params are filled from `variables` in insertion order —
 * so the order the caller passes variables MUST match the approved template.
 */
// Per-template component builders. Templates with dynamic URL buttons MUST
// have an explicit handler here — otherwise the URL variable goes missing
// and Meta rejects with "param mismatch" or substitutes an empty path.
//
// The default handler (used by templates with no URL button) just stuffs
// Object.values(variables) into the body in insertion order. Caller MUST
// pass variables in the same order as the template's {{1}}, {{2}}, ...
const TEMPLATE_HANDLERS = {
  // donor_otp (Authentication) — same code in body + copy-code/URL button.
  OTP: (vars) => {
    const code = String(vars.otp ?? '');
    return [
      { type: 'body', parameters: [{ type: 'text', text: code }] },
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: code }],
      },
    ];
  },

  // institution_link (Meta-approved template name) — 2 body vars + 1 URL button.
  // Body: {{1}}=signatory_name, {{2}}=institution_name
  // Button URL pattern: https://raktify.choudhari.ngo/activate/{{1}}  (token)
  // (Earlier draft included an `expires_in` var — Meta rejected templates
  // mentioning "7 days" / expiry framing as auth-flavoured. The user
  // dropped that line + got approval as `institution_link` Utility.)
  SETUP_LINK: (vars) => [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: String(vars.signatory_name || '') },
        { type: 'text', text: String(vars.institution_name || '') },
      ],
    },
    {
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: String(vars.setup_token || '') }],
    },
  ],

  // community_leader_welcome — DEPRECATED. Original Utility template was
  // re-classified MARKETING by Meta after the URL switch (constant-value
  // dynamic URL didn't read as transactional). Kept here so the handler
  // doesn't break if anything still references the templateType during
  // rollout. New code uses COMMUNITY_LEADER_SIGNIN below.
  COMMUNITY_LEADER_WELCOME: (vars) => [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: String(vars.leader_name || '') },
        { type: 'text', text: String(vars.organization_name || '') },
      ],
    },
    {
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: 'community_leader' }],
    },
  ],

  // community_leader_signin — Utility-class welcome with per-recipient URL.
  // The URL button variable is the recipient's mobile (digits only, no '+');
  // template URL is `?role=community_leader&m={{1}}`. Per-message unique URL
  // = Meta classifier reads transactional. Frontend /login reads ?m= to
  // pre-fill the mobile field for one-tap OTP.
  COMMUNITY_LEADER_SIGNIN: (vars) => {
    // Mobile must be digits only for the URL — the leading + sign breaks
    // URL templating in Meta's button substitution and the frontend doesn't
    // need it either.
    const mobileDigits = String(vars.mobile || '').replace(/\D/g, '');
    return [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: String(vars.leader_name || '') },
          { type: 'text', text: String(vars.organization_name || '') },
        ],
      },
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: mobileDigits }],
      },
    ];
  },

  // ── V2 donor-alert-gate templates ────────────────────────────────────────
  // Handlers below fill body variables in Meta template order and set a URL
  // button variable that's used to build the deep link on the recipient's
  // device. See docs/Raktify_WhatsApp_Templates.md §8–14 for full text +
  // approval status. Callers MUST pass variables using the exact key names
  // below so the positional order to Meta stays deterministic.

  // donor_alert_bb_routed — Utility. Body vars: blood_group_component,
  // bb_name, distance_km. URL button token: public alert JWT.
  DONOR_ALERT_BB: (vars) => [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: String(vars.blood_group_component || '') },
        { type: 'text', text: String(vars.bb_name || '') },
        { type: 'text', text: String(vars.distance_km || '') },
      ],
    },
    {
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: String(vars.alert_token || '') }],
    },
  ],

  // donor_alert_replacement — Utility. Body vars: donor_first_name,
  // bb_name, component_received, timeframe. URL button token: public alert JWT.
  DONOR_ALERT_REPLACE: (vars) => [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: String(vars.donor_first_name || '') },
        { type: 'text', text: String(vars.bb_name || '') },
        { type: 'text', text: String(vars.component_received || '') },
        { type: 'text', text: String(vars.timeframe || '') },
      ],
    },
    {
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: String(vars.alert_token || '') }],
    },
  ],

  // donor_alert_community_first — Utility. Body vars: donor_first_name,
  // leader_name, blood_group_component, district. URL button token: public alert JWT.
  DONOR_ALERT_COMMUNITY: (vars) => [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: String(vars.donor_first_name || '') },
        { type: 'text', text: String(vars.leader_name || '') },
        { type: 'text', text: String(vars.blood_group_component || '') },
        { type: 'text', text: String(vars.district || '') },
      ],
    },
    {
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: String(vars.alert_token || '') }],
    },
  ],

  // bb_donor_incoming — Utility. Body vars: donor_display_name,
  // donor_blood_group, request_short_code, arrival_window. URL button: donor id.
  BB_DONOR_INCOMING: (vars) => [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: String(vars.donor_display_name || '') },
        { type: 'text', text: String(vars.donor_blood_group || '') },
        { type: 'text', text: String(vars.request_short_code || '') },
        { type: 'text', text: String(vars.arrival_window || '') },
      ],
    },
    {
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: String(vars.donor_id || '') }],
    },
  ],

  // coord_prefire_warning — Utility. Body vars: request_short_code,
  // request_summary, time_until_fire. URL button: request_id.
  COORD_PREFIRE_WARN: (vars) => [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: String(vars.request_short_code || '') },
        { type: 'text', text: String(vars.request_summary || '') },
        { type: 'text', text: String(vars.time_until_fire || '') },
      ],
    },
    {
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: String(vars.request_id || '') }],
    },
  ],

  // coord_critical_new — Utility. Body vars: district, request_summary,
  // needed_by, facility_name. URL button: request_id.
  COORD_CRITICAL_NEW: (vars) => [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: String(vars.district || '') },
        { type: 'text', text: String(vars.request_summary || '') },
        { type: 'text', text: String(vars.needed_by || '') },
        { type: 'text', text: String(vars.facility_name || '') },
      ],
    },
    {
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: String(vars.request_id || '') }],
    },
  ],

  // community_leader_mobilise — Utility. Body vars: leader_first_name,
  // district, request_summary. URL button: mobilisation token / id.
  COMMUNITY_LEADER_MOBILISE: (vars) => [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: String(vars.leader_first_name || '') },
        { type: 'text', text: String(vars.district || '') },
        { type: 'text', text: String(vars.request_summary || '') },
      ],
    },
    {
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: String(vars.mobilise_token || '') }],
    },
  ],

  // donor_consent_invite — Utility. Magic-link asking a donor pushed into
  // Raktify by a BB software vendor to accept / decline / defer on our own
  // /consent/:token screen. Body vars: donor_first_name,
  // source_institution_display_name. URL button variable is the consent token.
  DONOR_CONSENT_INVITE: (vars) => [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: String(vars.donor_first_name || '') },
        { type: 'text', text: String(vars.source_institution_display_name || '') },
      ],
    },
    {
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: String(vars.consent_token || '') }],
    },
  ],
};

function buildComponents(templateType, variables) {
  const handler = TEMPLATE_HANDLERS[templateType];
  if (handler) return handler(variables);

  // Default: positional body, no button. Works for body-only templates;
  // templates with URL buttons MUST register an explicit handler above
  // (latent-bug guard — previously these were silently malformed).
  const params = Object.values(variables || {}).map((v) => ({
    type: 'text',
    text: String(v),
  }));
  return params.length ? [{ type: 'body', parameters: params }] : [];
}

async function send({
  recipientId,
  recipientMobile,
  templateType,
  variables = {},
  language = 'mr',
}) {
  if (!isConfigured()) {
    logger.warn({ templateType }, 'whatsapp_cloud provider not configured — send skipped');
    return { success: false, provider: 'whatsapp_cloud', messageId: null, deliveryStatus: 'FA' };
  }

  const to = toWhatsAppNumber(recipientMobile || recipientId);
  if (!to) {
    logger.warn({ templateType }, 'whatsapp_cloud: no resolvable recipient mobile');
    return { success: false, provider: 'whatsapp_cloud', messageId: null, deliveryStatus: 'FA' };
  }

  const templateName = env.whatsapp.templates?.[String(templateType).toLowerCase()];
  if (!templateName) {
    logger.warn({ templateType }, 'whatsapp_cloud: no template name configured for this type');
    return { success: false, provider: 'whatsapp_cloud', messageId: null, deliveryStatus: 'FA' };
  }

  const body = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: LANG[language] || 'en' },
      components: buildComponents(templateType, variables),
    },
  };

  const url = `${GRAPH}/${env.whatsapp.apiVersion}/${env.whatsapp.phoneNumberId}/messages`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.whatsapp.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
      logger.error(
        { status: res.status, error: json?.error?.message, templateType },
        'whatsapp_cloud send failed',
      );
      return { success: false, provider: 'whatsapp_cloud', messageId: null, deliveryStatus: 'FA' };
    }

    const messageId = json?.messages?.[0]?.id || null;
    // Meta accepted the message — it's 'SE' (sent/accepted). The terminal
    // delivered/read status arrives later via the webhook.
    return { success: true, provider: 'whatsapp_cloud', messageId, deliveryStatus: 'SE' };
  } catch (err) {
    logger.error({ err: err.message, templateType }, 'whatsapp_cloud send error');
    return { success: false, provider: 'whatsapp_cloud', messageId: null, deliveryStatus: 'FA' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { send, providerName: 'whatsapp_cloud' };
