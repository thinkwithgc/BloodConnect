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
/**
 * Squash operator-typed free text onto one line.
 *
 * Meta rejects any template parameter containing a newline, a tab, or more than
 * four consecutive spaces, with a 132000-class error the send surfaces as a
 * plain 'FA' row. An organiser typing a two-line notice into the broadcast box
 * is the normal case, so scrubbing beats rejecting: the donor reads the message
 * on one line rather than not at all.
 */
function oneLine(value) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

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

  // camp_precheck_2d — Utility. 2 days before a donation camp with an RSVP.
  // Includes the 48-hour prep list (avoid alcohol, sleep, hydrate). Body vars:
  // donor_first_name, camp_name, camp_date_time. URL button = camp slug so
  // donors can view the full camp details / cancel RSVP.
  CAMP_PRECHECK_2D: (vars) => [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: String(vars.donor_first_name || '') },
        { type: 'text', text: String(vars.camp_name || '') },
        { type: 'text', text: String(vars.camp_date_time || '') },
      ],
    },
    {
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: String(vars.camp_slug || '') }],
    },
  ],

  // camp_day_of — Utility. Morning of the camp: "the camp you registered for is
  // scheduled for today, here is when and where". Body vars: donor_first_name,
  // camp_name, start_time, venue.
  //
  // Do NOT reintroduce "come donate" framing in the template copy. The original
  // camp_day_of record said "today is your donation day" and Meta's classifier
  // filed it MARKETING, which subjects a day-of reminder to per-user marketing
  // frequency caps — a capped donor silently gets nothing. The replacement
  // (camp_day_of_v2) is anchored on the registration the donor already made.
  // Same 4 variables in the same order and the same slug button, so this handler
  // serves both records unchanged — only the appsetting VALUE moves.
  CAMP_DAY_OF: (vars) => [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: String(vars.donor_first_name || '') },
        { type: 'text', text: String(vars.camp_name || '') },
        { type: 'text', text: String(vars.start_time || '') },
        { type: 'text', text: String(vars.venue || '') },
      ],
    },
    {
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: String(vars.camp_slug || '') }],
    },
  ],

  // camp_donor_thankyou — Utility. Evening after the camp for donors who
  // actually attended (status=AT). Body vars: donor_first_name, camp_name.
  //
  // BODY ONLY — deliberately no URL button. The only plausible CTA was the
  // donor dashboard at the CONSTANT path /donor, and a dynamic URL button whose
  // value never varies per recipient is exactly what got community_leader_welcome
  // re-classified MARKETING (see env.js:98-107). A Marketing-category template
  // is throttled and opt-out-blocked, which is unacceptable for a message that
  // reassures a first-time donor their results are coming. The approved template
  // carries no button, and sending a component the template does not declare is
  // rejected as an 'FA' row — i.e. it reads as a delivery failure, not a bug.
  CAMP_DONOR_THANKYOU: (vars) => [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: String(vars.donor_first_name || '') },
        { type: 'text', text: String(vars.camp_name || '') },
      ],
    },
  ],

  // ── Camp organiser + blood-bank coordination ───────────────────────────

  // camp_organizer_link_v2 — Utility, EN + MR + HI. The organiser's magic
  // dashboard link, sent when the NGO admin verifies a camp application.
  //
  // TWO body variables, not three. The original camp_organizer_link carried a
  // scheduled_date as {{3}}; Meta's Marathi classifier flagged that record
  // MARKETING and scripts/reword_marketing_templates.js replaced all three
  // languages with a two-variable body. Passing a third parameter here is a
  // param-count mismatch and Meta rejects the whole send — as an 'FA' row, so
  // it looks like a delivery failure rather than a code bug. Keep it at two.
  //
  // URL button = the raw camp_access_tokens token, NOT the assembled URL: the
  // approved button is `{BASE_URL}/camp/{{1}}` and Meta appends the parameter
  // to that path. Sending a full https:// URL would produce
  // /camp/https%3A%2F%2F… and a dead link.
  CAMP_LINK: (vars) => [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: String(vars.organiser_name || '') },
        { type: 'text', text: String(vars.camp_name || '') },
      ],
    },
    {
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: String(vars.camp_token || '') }],
    },
  ],

  // camp_announcement — Utility. The organiser's broadcast to donors who
  // RSVP'd, and the automatic notice when a verified camp's date, time or
  // venue is edited. Body vars: camp_name, camp_date, message.
  //
  // The message is operator-typed free text, so it is scrubbed to one line
  // first. Meta rejects any parameter containing a newline, a tab, or more
  // than four consecutive spaces — and an organiser typing a two-line notice
  // into the broadcast box is the normal case, not the edge case. Scrubbing
  // beats rejecting: the donor gets the message on one line instead of not at
  // all. Trimmed to 900 chars so body + variables stay inside Meta's 1024.
  CAMP_ANNC: (vars) => [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: String(vars.camp_name || '') },
        { type: 'text', text: String(vars.camp_date || '') },
        { type: 'text', text: oneLine(vars.message).slice(0, 900) },
      ],
    },
  ],

  // camp_bb_request — Utility. Sent to the partnered blood bank when a camp
  // is waiting on its answer (bb_response='PE'). Body vars: bb_name,
  // camp_date, venue, expected_donors.
  //
  // NO URL BUTTON, deliberately. A blood-bank user signs in with password +
  // TOTP, so any button here would be a CONSTANT /bb link — which is exactly
  // what got community_leader_welcome re-classified MARKETING (see env.js).
  // The BB acts on this in the portal's Camps tab; the message only has to
  // tell it there is something to act on.
  // camp_review_pending - Utility. To the NGO side (district coordinators +
  // ngo_admin) when a public camp application lands at status 'PE'. Body vars:
  // camp_name, camp_date, venue, organiser_name, district. Body-only, no
  // button - see the note on the env key in config/env.js.
  //
  // organiser_name is the ORGANISATION (a college, a Rotary club), never
  // submitted_by_name: the person's name is PII that does not need to ride a
  // WhatsApp message to decide whether a camp is worth reviewing, and the
  // admin sees it in the portal anyway.
  // Every string here comes off a PUBLIC form, and Meta rejects a PARAMETER
  // (not body text) that holds a newline, a tab or >4 consecutive spaces — so
  // each one goes through oneLine() rather than String().
  CAMP_REVIEW_PENDING: (vars) => [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: oneLine(vars.camp_name).slice(0, 160) },
        { type: 'text', text: oneLine(vars.camp_date) },
        { type: 'text', text: oneLine(vars.venue).slice(0, 200) },
        { type: 'text', text: oneLine(vars.organiser_name).slice(0, 160) },
        { type: 'text', text: oneLine(vars.district) },
      ],
    },
  ],

  CAMP_BB_REQUEST: (vars) => [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: String(vars.bb_name || '') },
        { type: 'text', text: String(vars.camp_date || '') },
        { type: 'text', text: String(vars.venue || '') },
        { type: 'text', text: String(vars.expected_donors || '') },
      ],
    },
  ],

  // camp_bb_accepted — Utility. To the ORGANISER: a blood bank has confirmed
  // it will collect. Body vars: organiser_name, camp_name, scheduled_date.
  CAMP_BB_ACCEPTED: (vars) => [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: String(vars.organiser_name || '') },
        { type: 'text', text: String(vars.camp_name || '') },
        { type: 'text', text: String(vars.scheduled_date || '') },
      ],
    },
  ],

  // camp_bb_changed — Utility. To the ORGANISER when the partnered blood bank
  // declines. Same three variables as camp_bb_accepted, and deliberately no
  // fourth: bb_decline_reason is NEVER passed here. An organiser told "no
  // capacity" starts phoning around, which is the behaviour this whole feature
  // exists to remove. The reason stays with the NGO admin, who is the one who
  // can act on it. See migration 317's COMMENT ON COLUMN.
  CAMP_BB_CHANGED: (vars) => [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: String(vars.organiser_name || '') },
        { type: 'text', text: String(vars.camp_name || '') },
        { type: 'text', text: String(vars.scheduled_date || '') },
      ],
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

// ── Why a failed send has to say WHICH kind of failed ────────────────────
//
// Every failure below used to collapse into a bare `deliveryStatus:'FA'`, so
// the caller could not tell "this number has no WhatsApp" (a permanent fact
// about the recipient, and the one thing a donor needs told) apart from "our
// template is not approved yet" (a permanent fact about US, which the donor
// must never be blamed for) or a 30-second Meta blip. That is why a donor with
// no WhatsApp sat watching a screen that said the code had been sent.
//
// Only the recipient-side codes may ever be reported as `no_whatsapp`. Meta
// offers no pre-check for whether a number is on WhatsApp, so this rejection is
// the only signal that exists — which makes misclassifying an outage or a
// template problem as `no_whatsapp` a real harm: it tells a donor holding a
// working WhatsApp that they cannot register.
const RECIPIENT_UNREACHABLE_CODES = new Set([
  131026, // "Message undeliverable" — not a WhatsApp user, or cannot receive
  1013, // "User is not valid" (legacy phrasing of the same rejection)
]);

const OPTED_OUT_CODES = new Set([
  131050, // recipient chose to stop receiving — mirrors the webhook's 'OP'
]);

function classifyFailure(json, httpStatus) {
  const err = json?.error || {};
  const code = Number(err.code ?? err?.error_data?.details_code ?? NaN);
  const detail = err?.error_data?.details || err.message || `http_${httpStatus}`;
  let reason = 'provider_error';
  if (RECIPIENT_UNREACHABLE_CODES.has(code)) reason = 'no_whatsapp';
  else if (OPTED_OUT_CODES.has(code)) reason = 'opted_out';
  return {
    errorCode: Number.isFinite(code) ? code : null,
    reason,
    // Meta's own words, capped — it lands in notification_log.failure_reason,
    // which is the only place anyone can read it after the fact.
    failureReason: String(detail).slice(0, 500),
  };
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
    return {
      success: false,
      provider: 'whatsapp_cloud',
      messageId: null,
      deliveryStatus: 'FA',
      reason: 'not_configured',
      failureReason: 'whatsapp_cloud provider not configured',
    };
  }

  const to = toWhatsAppNumber(recipientMobile || recipientId);
  if (!to) {
    logger.warn({ templateType }, 'whatsapp_cloud: no resolvable recipient mobile');
    return {
      success: false,
      provider: 'whatsapp_cloud',
      messageId: null,
      deliveryStatus: 'FA',
      reason: 'no_recipient',
      failureReason: 'no resolvable recipient mobile',
    };
  }

  const templateName = env.whatsapp.templates?.[String(templateType).toLowerCase()];
  if (!templateName) {
    logger.warn({ templateType }, 'whatsapp_cloud: no template name configured for this type');
    return {
      success: false,
      provider: 'whatsapp_cloud',
      messageId: null,
      deliveryStatus: 'FA',
      reason: 'template_not_configured',
      failureReason: `no WHATSAPP_TEMPLATE_* env key for ${templateType}`,
    };
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
      const cls = classifyFailure(json, res.status);
      logger.error(
        {
          status: res.status,
          error: json?.error?.message,
          errorCode: cls.errorCode,
          reason: cls.reason,
          templateType,
        },
        'whatsapp_cloud send failed',
      );
      return {
        success: false,
        provider: 'whatsapp_cloud',
        messageId: null,
        // Stays 'FA', even for an opt-out: fn_notif_propagate_opt_out (034) is
        // a BEFORE UPDATE OF delivery_status trigger, so an 'OP' written at
        // INSERT time would never propagate to donors.whatsapp_opted_in and
        // would sit in the log looking like the webhook's rows without having
        // done what they do. The chokepoint flips the flag itself instead.
        deliveryStatus: 'FA',
        ...cls,
      };
    }

    const messageId = json?.messages?.[0]?.id || null;
    // Meta accepted the message — it's 'SE' (sent/accepted). The terminal
    // delivered/read status arrives later via the webhook.
    return { success: true, provider: 'whatsapp_cloud', messageId, deliveryStatus: 'SE' };
  } catch (err) {
    logger.error({ err: err.message, templateType }, 'whatsapp_cloud send error');
    return {
      success: false,
      provider: 'whatsapp_cloud',
      messageId: null,
      deliveryStatus: 'FA',
      // A timeout or a DNS failure is ours, not the recipient's — it must never
      // reach a donor as "you have no WhatsApp".
      reason: 'transport_error',
      failureReason: String(err.message).slice(0, 500),
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { send, providerName: 'whatsapp_cloud' };
