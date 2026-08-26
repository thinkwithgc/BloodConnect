// Canonical camp lifecycle labels, shared so a declined camp never renders as
// the raw code 'DC' to the host who most needs to read why.
//
// PE pending review · PL planned (verified) · LV live · CO completed
// CA cancelled · DC declined by the NGO.
export const CAMP_STATUS = {
  PE: { label: 'Pending review', cls: 'bg-amber-100 text-amber-800' },
  PL: { label: 'Planned', cls: 'bg-sky-100 text-sky-800' },
  LV: { label: 'Live', cls: 'bg-green-100 text-green-800' },
  CO: { label: 'Completed', cls: 'bg-slate-200 text-slate-700' },
  CA: { label: 'Cancelled', cls: 'bg-rk-700/80 text-white' },
  DC: { label: 'Declined', cls: 'bg-rk-700/80 text-white' },
};

export function campStatus(code) {
  return CAMP_STATUS[code] || { label: code || '—', cls: 'bg-slate-100 text-slate-700' };
}
