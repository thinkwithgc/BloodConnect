/**
 * Institution activation — the VE → AC transition.
 *
 * This is the single code path that turns a verified application into a live
 * institution: it files the MoU version, flips the parent (and any paired
 * in-house blood-bank child) to `AC`, and provisions the admin `platform_users`
 * rows with magic-link setup tokens.
 *
 * It was lifted out of the Leegality eSign webhook (POST /onboarding/mou-signed)
 * when MoU signing moved offline to paper — the transaction body is unchanged,
 * only its trigger is. `signingMode` keeps it usable from either path, so
 * re-enabling eSign later means calling this with `signingMode: 'ES'` rather
 * than rewriting the activation logic.
 *
 * Callers own the HTTP-level guards (exists / is-a-parent / is-in-VE /
 * not-already-AC) — this function assumes they passed and will happily file a
 * second MoU version if called twice.
 */
const crypto = require('crypto');

const { pool } = require('../../config/db');
const { withRlsContextRaw } = require('../../middleware/rlsContext');
const setupSvc = require('../users/setup');

/**
 * @param {object}  args
 * @param {string}  args.institutionId        Parent institution UUID.
 * @param {object}  args.mou
 * @param {'PA'|'ES'} args.mou.signingMode    'PA' = paper (offline), 'ES' = Aadhaar eSign.
 * @param {string}  args.mou.signedOn         'YYYY-MM-DD' — the date on the signed document.
 * @param {string}  args.mou.signatoryName
 * @param {string} [args.mou.signatoryDesignation]
 * @param {string} [args.mou.scanKey]         Storage key of the scanned original (optional).
 * @param {string} [args.mou.scanSha256]      Hex sha256 of that scan. Both or neither.
 * @param {string} [args.mou.leegalityDocId]  eSign path only.
 * @param {string} [args.mou.templateId]      eSign path only.
 * @param {string} [args.mou.signatoryAadhaarLast4] eSign path only.
 * @param {string}  args.recordedByUserId     Admin who recorded this (audit trail).
 * @returns {Promise<object>} usernames, plaintext setup tokens + expiries, version, childId
 */
async function activateInstitution({ institutionId, mou, recordedByUserId }) {
  const inst = await pool.query(
    `SELECT id, shortname, display_name, primary_contact_name,
            primary_contact_mobile, kind, onboarding_status,
            parent_institution_id
       FROM institutions WHERE id = $1`,
    [institutionId],
  );
  if (inst.rowCount === 0) {
    const err = new Error('institution_not_found');
    err.code = 'institution_not_found';
    throw err;
  }
  const i = inst.rows[0];

  // The child BB, if this HO onboarded with an in-house blood bank. One MoU
  // covers the pair — the child inherits the parent's.
  const childR = await pool.query(
    `SELECT id, shortname, primary_contact_mobile FROM institutions
      WHERE parent_institution_id = $1 AND kind = 'BB'
      ORDER BY created_at ASC LIMIT 1`,
    [institutionId],
  );
  const child = childR.rows[0] || null;

  const versionR = await pool.query(
    `SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM mou_versions WHERE institution_id = $1`,
    [institutionId],
  );
  const versionNumber = versionR.rows[0].next;

  // Both admin usernames derive from the parent shortname. The regex constraint
  // on platform_users.username is ^[a-z][a-z0-9_-]{2,31}$; the child's
  // `-bb_admin` suffix adds 9 chars, and applySchema caps the parent shortname
  // at 23 when has_inhouse_blood_bank=true so the child username always fits.
  const hoAdminUsername = `${i.shortname}_admin`;
  const bbAdminUsername = child ? `${child.shortname}_admin` : null;
  const hoRole = 'hospital';
  const bbRole = 'blood_bank';

  const placeholderHash = await setupSvc.unusablePasswordHash();

  const isPaper = mou.signingMode === 'PA';

  // What we can reproduce about the document that was actually signed. For
  // eSign that is the Leegality doc reference; for paper it is the admin's
  // attestation — who recorded it, on whose signature, and whether a scan of
  // the original is on file.
  const templateSnapshot = isPaper
    ? {
        signing_mode: 'PA',
        version: versionNumber,
        recorded_by: recordedByUserId || null,
        signatory_name: mou.signatoryName,
        signatory_designation: mou.signatoryDesignation || null,
        signed_on: mou.signedOn,
        scan_on_file: Boolean(mou.scanKey),
      }
    : {
        signing_mode: 'ES',
        version: versionNumber,
        doc_id: mou.leegalityDocId || null,
      };

  const result = await withRlsContextRaw(
    {
      actor_role: 'onboarding',
      change_reason: isPaper ? 'paper MoU recorded then activate' : 'eSign signed then activate',
    },
    async (c) => {
      // 1. mou_versions — one row for the parent; the child inherits it.
      //    effective_from is the SIGNING date, not today: a paper MoU may be
      //    recorded on the platform days after it was physically signed.
      await c.query(
        `INSERT INTO mou_versions (
            institution_id, version_number, effective_from, effective_until,
            signing_mode,
            leegally_doc_id, leegally_template_id,
            signed_at, signatory_name, signatory_designation,
            signatory_aadhaar_last4,
            pdf_storage_key, pdf_sha256, template_snapshot)
         VALUES ($1,$2, $3::date, ($3::date + INTERVAL '1 year')::date,
            $4,
            $5,$6,
            $3::date::timestamptz, $7,$8,
            $9,
            $10,$11, $12::jsonb)`,
        [
          institutionId,
          versionNumber,
          mou.signedOn,
          mou.signingMode,
          mou.leegalityDocId || null,
          mou.templateId || null,
          mou.signatoryName,
          mou.signatoryDesignation || null,
          mou.signatoryAadhaarLast4 || null,
          mou.scanKey || null,
          mou.scanSha256 || null,
          JSON.stringify(templateSnapshot),
        ],
      );

      // 2. Flip parent + any children to AC in one UPDATE. `onboarded_at` is
      //    stamped by the migration-004 trigger on this transition — never set
      //    it by hand. Also clears any stale in-flight eSign fields so a
      //    future renewal starts from a clean slate.
      await c.query(
        `UPDATE institutions
            SET onboarding_status = 'AC',
                current_esign_doc_id     = NULL,
                current_esign_url        = NULL,
                current_esign_expires_at = NULL
          WHERE id = $1 OR parent_institution_id = $1`,
        [institutionId],
      );
      // Convenience pointers to the LATEST MoU, on the parent row only.
      await c.query(
        `UPDATE institutions
            SET mou_signed_at       = $1::date::timestamptz,
                mou_leegally_doc_id = $2,
                mou_signatory_name  = $3,
                mou_signing_mode    = $4,
                mou_expires_at      = ($1::date + INTERVAL '1 year')::date
          WHERE id = $5`,
        [
          mou.signedOn,
          mou.leegalityDocId || null,
          mou.signatoryName || null,
          mou.signingMode,
          institutionId,
        ],
      );

      // 3. HO admin — idempotent on username (handover / MoU renewal case).
      const hoExisting = await c.query(`SELECT id FROM platform_users WHERE username = $1`, [
        hoAdminUsername,
      ]);
      let hoUserId;
      if (hoExisting.rowCount === 0) {
        const created = await c.query(
          // is_institution_admin (migration 311) is what lets this person
          // invite the rest of their team and re-issue a colleague's setup
          // link. Activation is the only path that mints an institution's
          // first admin, so if it is not set here nobody at that institution
          // can ever manage their own logins.
          `INSERT INTO platform_users
             (role, username, mobile, password_hash, password_set_at,
              force_password_change, institution_id, is_institution_admin)
           VALUES ($1, $2, $3, $4, NOW(), TRUE, $5, TRUE)
           RETURNING id`,
          [hoRole, hoAdminUsername, i.primary_contact_mobile, placeholderHash, institutionId],
        );
        hoUserId = created.rows[0].id;
      } else {
        hoUserId = hoExisting.rows[0].id;
        await c.query(
          // Re-asserted, not just set on create: activation is the
          // authoritative provisioning event, so a handover must hand back a
          // usable admin even if the account had been demoted.
          `UPDATE platform_users
              SET password_hash = $1, password_set_at = NOW(),
                  mobile = $2,
                  force_password_change = TRUE,
                  is_institution_admin = TRUE
            WHERE id = $3`,
          [placeholderHash, i.primary_contact_mobile, hoUserId],
        );
      }
      const { token: hoSetupToken, expiresAt: hoExpiresAt } = await setupSvc.generateSetupToken(
        c,
        hoUserId,
      );

      // 4. BB admin (only if a child BB exists).
      //
      // Mobile now comes from the CHILD institution's own primary_contact_mobile
      // — the blood bank's contact, which POST /onboarding/apply asks for
      // separately whenever an in-house BB is ticked. Before that field existed
      // this login was always minted with mobile = NULL, and the roster offered
      // no way to correct it: every action there re-issues a link, resets 2FA or
      // retires the account, so "no mobile on file" was a dead end until
      // POST /institutions/:id/users/:userId/contact was added alongside this.
      //
      // It is still minted with NULL in two cases, both deliberate:
      //
      //   1. The blood bank's number is the SAME as the hospital's.
      //   2. That number already belongs to some other staff login.
      //
      // idx_platform_users_mobile_staff_cluster (migrations 269 + 282) makes
      // mobile unique across staff roles precisely so a SETUP_LINK can never
      // route to an ambiguous inbox. Case 1 is legitimate and common — at a
      // small hospital one person heads both, which is why apply accepts it
      // rather than rejecting a real application over a modelling detail. In
      // either case the pair share the number, the BB login takes none, and its
      // link is surfaced to the HO admin from
      // institutions.bb_admin_pending_setup_token below, exactly as before.
      //
      // Mobile is delivery-channel-only for staff (auth_path_required needs just
      // username + password_hash), so a NULL here never blocks a sign-in — it
      // only decides whether the link can be WhatsApp'd.
      let bbSetupToken = null;
      let bbExpiresAt = null;
      let bbUserId = null;
      // Reported back to the caller so it knows whether the BB's link can be
      // sent, or has to be surfaced on the hospital dashboard.
      let bbAdminMobile = null;
      if (child) {
        const parentMobile = (i.primary_contact_mobile || '').trim();
        const childMobile = (child.primary_contact_mobile || '').trim();
        bbAdminMobile = childMobile && childMobile !== parentMobile ? childMobile : null;

        // Pre-checked with a SELECT rather than caught as a unique violation: a
        // failed INSERT aborts this whole transaction, and a number that is
        // already spoken for is not a reason to refuse to activate a hospital.
        // The predicate mirrors the index exactly — same six roles, no
        // deactivated_at filter — because a lenient check here would let the
        // INSERT throw anyway, which is the outcome it exists to prevent.
        if (bbAdminMobile) {
          const taken = await c.query(
            `SELECT 1 FROM platform_users
              WHERE mobile = $1
                AND role IN ('hospital','blood_bank','ngo_admin','super_admin','dho','coordinator')
              LIMIT 1`,
            [bbAdminMobile],
          );
          if (taken.rowCount > 0) bbAdminMobile = null;
        }

        const bbExisting = await c.query(
          `SELECT id, mobile FROM platform_users WHERE username = $1`,
          [bbAdminUsername],
        );
        if (bbExisting.rowCount === 0) {
          const bbPlaceholder = await setupSvc.unusablePasswordHash();
          const created = await c.query(
            `INSERT INTO platform_users
               (role, username, mobile, password_hash, password_set_at,
                force_password_change, institution_id, is_institution_admin)
             VALUES ($1, $2, $3, $4, NOW(), TRUE, $5, TRUE)
             RETURNING id`,
            [bbRole, bbAdminUsername, bbAdminMobile, bbPlaceholder, child.id],
          );
          bbUserId = created.rows[0].id;
        } else {
          bbUserId = bbExisting.rows[0].id;
          const bbPlaceholder = await setupSvc.unusablePasswordHash();
          // Leaves any mobile the BB team already set for themselves alone — a
          // re-activation must not overwrite a number the blood bank corrected
          // for itself, which is precisely the number most likely to be right.
          await c.query(
            `UPDATE platform_users
                SET password_hash = $1, password_set_at = NOW(),
                    force_password_change = TRUE,
                    is_institution_admin = TRUE
              WHERE id = $2`,
            [bbPlaceholder, bbUserId],
          );
          // Whatever is actually on the row wins for the caller's send decision.
          bbAdminMobile = (bbExisting.rows[0].mobile || '').trim() || null;
        }
        const bb = await setupSvc.generateSetupToken(c, bbUserId);
        bbSetupToken = bb.token;
        bbExpiresAt = bb.expiresAt;

        // Stash the plaintext token on the PARENT so the HO admin's dashboard
        // can surface it. Trigger fn_clear_bb_admin_pending_token (migration
        // 306) wipes it when the BB admin consumes the token.
        await c.query(
          `UPDATE institutions
              SET bb_admin_pending_setup_token = $1
            WHERE id = $2`,
          [bbSetupToken, institutionId],
        );
      }

      return {
        hoUserId,
        hoAdminUsername,
        hoSetupToken,
        hoExpiresAt,
        bbUserId,
        bbAdminUsername,
        bbAdminMobile,
        bbSetupToken,
        bbExpiresAt,
      };
    },
  );

  return {
    ...result,
    institution: i,
    childId: child?.id || null,
    versionNumber,
  };
}

/**
 * SHA-256 of a buffer, hex — the integrity hash stored alongside a scanned MoU
 * original in `mou_versions.pdf_sha256` (CHAR(64)).
 */
function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

module.exports = { activateInstitution, sha256Hex };
