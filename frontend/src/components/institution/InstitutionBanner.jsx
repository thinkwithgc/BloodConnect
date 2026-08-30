import { useQuery } from '@tanstack/react-query';

import { apiRequest } from '../../lib/api.js';
import { useT } from '../../i18n/useT.js';

/**
 * The signed-in institution's own name, at the top of its portal.
 *
 * A hospital or blood bank logging in used to see nothing but the Raktify
 * wordmark and a generic "Hospital portal" label, so the screen never confirmed
 * WHICH organisation the session belonged to — which matters most for the one
 * shape that has two portals: a hospital with an in-house blood bank, where the
 * two logins differ only by the `_bb_admin` suffix on a username nobody reads.
 *
 * `display_name` is what the applicant typed into "Public display name" on the
 * onboarding form (routes/onboarding.js applySchema), so it is their own words,
 * not a name we coined. `legal_name` sits underneath and only when it actually
 * differs — for most applicants the two are near-identical and repeating it
 * would just be noise.
 *
 * Product chrome stays product chrome: the wordmark above is untouched and the
 * institution name is the page's <h1> below it. That is the hierarchy a tenant
 * expects, and it keeps the LOCKED wordmark from being co-branded.
 */
export function InstitutionBanner({ fallback }) {
  const { t } = useT();

  const q = useQuery({
    queryKey: ['institution', 'me'],
    queryFn: () => apiRequest('GET', '/institutions/me'),
    staleTime: 5 * 60_000,
    // Never retried, never surfaced as an error. Deploy skew means the SPA is
    // live ~60-90s before the API (see CLAUDE.md), so this route can honestly
    // answer route_not_found for a minute after a release; a coordinator or NGO
    // admin who lands here at all has no institution and gets a 400. Either way
    // the banner falls back to the portal label rather than shouting.
    retry: false,
  });

  const inst = q.data;
  // institutions.kind is CHAR(2) — 'HO' / 'BB' (migration 004:19), not a long
  // name. Compared against 'hospital' this label silently never rendered.
  const kindLabel =
    inst?.kind === 'BB'
      ? t('inst_kind_blood_bank')
      : inst?.kind === 'HO'
        ? t('inst_kind_hospital')
        : '';
  const meta = [kindLabel, inst?.district_name].filter(Boolean).join(' \u00b7 ');
  const showLegal =
    inst?.legal_name && inst.legal_name.trim() !== (inst.display_name || '').trim();

  return (
    <div className="mb-5 border-b border-rk-100 pb-4">
      <h1 className="text-xl font-semibold tracking-tight text-stone-900 sm:text-2xl">
        {inst?.display_name || fallback}
      </h1>
      {meta ? <p className="mt-1 text-sm text-stone-500">{meta}</p> : null}
      {showLegal ? <p className="mt-0.5 text-xs text-stone-400">{inst.legal_name}</p> : null}
    </div>
  );
}
