// Canonical camp lifecycle labels, shared so a declined camp never renders as
// the raw code 'DC' to the host who most needs to read why.
//
// PE pending review · PL planned (verified) · LV live · CO completed
// CA cancelled · DC declined by the NGO.
//
// Each entry carries BOTH a hardcoded English `label` and an i18n `key`. The
// key is the translated path; the label is the fallback for the surfaces that
// have no `t` in hand yet (the admin CampsTab, CommunityDetail). Keeping both
// means translating a caller is a one-line change and never a signature change
// rippling through every consumer.
export const CAMP_STATUS = {
  PE: { label: 'Pending review', key: 'camp_status_PE', cls: 'bg-amber-100 text-amber-800' },
  PL: { label: 'Planned', key: 'camp_status_PL', cls: 'bg-sky-100 text-sky-800' },
  LV: { label: 'Live', key: 'camp_status_LV', cls: 'bg-green-100 text-green-800' },
  CO: { label: 'Completed', key: 'camp_status_CO', cls: 'bg-slate-200 text-slate-700' },
  CA: { label: 'Cancelled', key: 'camp_status_CA', cls: 'bg-rk-700/80 text-white' },
  DC: { label: 'Declined', key: 'camp_status_DC', cls: 'bg-rk-700/80 text-white' },
};

export function campStatus(code) {
  return CAMP_STATUS[code] || { label: code || '—', cls: 'bg-slate-100 text-slate-700' };
}

// Translated label for a status code. Falls back to the English label, then to
// the raw code, so an unknown code from a future migration still renders.
export function campStatusLabel(code, t) {
  const st = campStatus(code);
  return st.key && t ? t(st.key) : st.label;
}
