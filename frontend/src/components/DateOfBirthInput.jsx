import { useEffect, useMemo, useState } from 'react';

import { isoOffsetYears, todayISO } from '../lib/dateBounds.js';
import { useT } from '../i18n/useT.js';

/**
 * Date of birth as three selects — day, month, year.
 *
 * A bare <input type="date"> opens on the current month, so a 45-year-old donor
 * standing at a camp desk has to page back 540 months to reach their birth year.
 * Three lists is one tap each, needs no calendar literacy, and works the same on
 * every browser instead of whatever native picker the phone happens to ship.
 *
 * ── The year range MIRRORS the database, it does not replace it ─────────────
 *
 * `today − minAge` down to `today − maxAge` is exactly donors.age_min /
 * age_max (008_donors.sql:105-106). Hard rule 1 stands: the CHECK is still the
 * binding gate, and a bulk upload or the vendor webhook — neither of which comes
 * through this form — still hits it. This only stops the form from offering a
 * date the server is certain to reject.
 *
 * Patient DOBs are NOT donor DOBs: thalassemia patients are children, so the
 * range is a prop rather than a constant. Pass minAge={0} maxAge={90} there.
 *
 * ── Year, not age ──────────────────────────────────────────────────────────
 *
 * The list offers birth years, not "how old are you". People know the year they
 * were born with certainty; asking for age invites the answer that was true at
 * last birthday and turns a clinical field into arithmetic.
 *
 * The boundary year is deliberately offered in full: someone born in the cutoff
 * year but after today's date is under 18 by days, and the exact comparison
 * belongs to CURRENT_DATE on the server, not to a browser clock. The component
 * says so inline instead of silently hiding the year and leaving the donor with
 * no year to pick.
 */

// Month names come from the SAME string-pack array the camp calendar reads
// (`camp_months`), so the DOB picker and the camp calendar can never disagree on
// what September is called. Intl is kept only as the guard for an engine or a
// language where the key is missing — an English month name beats a bare number.
function monthNames(lang, t) {
  const packed = t('camp_months');
  if (Array.isArray(packed) && packed.length === 12) return packed;
  const locale = { mr: 'mr-IN', hi: 'hi-IN', en: 'en-IN' }[lang] || 'en-IN';
  const build = (loc) => {
    const fmt = new Intl.DateTimeFormat(loc, { month: 'long', timeZone: 'UTC' });
    return Array.from({ length: 12 }, (_, i) =>
      fmt.format(new Date(Date.UTC(2020, i, 15))),
    );
  };
  try {
    return build(locale);
  } catch {
    return build('en-IN');
  }
}

const pad = (n) => String(n).padStart(2, '0');

// Numbers, not zero-padded strings, because that is what the <option value>s
// hold — '07' would never match the month option whose value is '7' and the
// select would silently show its placeholder.
function splitISO(iso) {
  const [y = '', m = '', d = ''] = String(iso || '').split('-');
  return { y, m: String(Number(m) || ''), d: String(Number(d) || '') };
}

const joinISO = ({ y, m, d }) => (y && m && d ? `${y}-${pad(m)}-${pad(d)}` : '');

function daysInMonth(year, month) {
  if (!year || !month) return 31; // full list until both are chosen
  return new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
}

export function DateOfBirthInput({
  id,
  value = '',
  onChange,
  minAge = 18,
  maxAge = 65,
  required = false,
  disabled = false,
}) {
  const { t, lang } = useT();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const months = useMemo(() => monthNames(lang, t), [lang]);

  const today = todayISO();
  const latestISO = isoOffsetYears(-minAge, today); // youngest allowed
  const earliestISO = isoOffsetYears(-maxAge, today); // oldest allowed
  const latestYear = Number(latestISO.slice(0, 4));
  const earliestYear = Number(earliestISO.slice(0, 4));

  // Newest first: most donors are nearer the young end of the band, and the
  // youngest selectable year sitting at the top of the list is one scroll less.
  const years = useMemo(() => {
    const out = [];
    for (let y = latestYear; y >= earliestYear; y -= 1) out.push(y);
    return out;
  }, [latestYear, earliestYear]);

  // ── Why the parts live HERE and not in the parent's `value` ───────────────
  //
  // Only a complete triple is a date, so `onChange` emits '' until all three
  // selects are filled — otherwise `required` would pass on a half-filled
  // picker and the form would post '1998--07'. That contract is right, and it
  // is exactly why `value` cannot drive the selects: for two taps out of three
  // it is '', so a select whose value came from `value` would snap back to its
  // placeholder the instant the donor touched it, and the triple could never be
  // completed. The partial state is this component's own; `value` seeds it and
  // can override it, but does not define it.
  const [sel, setSel] = useState(() => splitISO(value));
  const emitted = joinISO(sel);

  // Re-seed only when the parent supplies something we did not just emit: an
  // edit form loading a saved DOB, or a reset clearing the field. While the
  // picker is half-filled both sides are '', so this stays out of the way.
  useEffect(() => {
    const incoming = String(value || '');
    if (incoming === emitted) return;
    if (incoming && !/^\d{4}-\d{2}-\d{2}$/.test(incoming)) return;
    setSel(splitISO(incoming));
  }, [value, emitted]);

  const { y: vy, m: vm, d: vd } = sel;

  const emit = (next) => {
    setSel(next);
    onChange(joinISO(next));
  };

  // Changing month or year can orphan the day (31 → February). Drop it rather
  // than quietly moving the birthday to the 28th.
  const dayCount = daysInMonth(vy, vm);
  const keepDay = (y, m) => (Number(vd) > daysInMonth(y, m) ? '' : vd);

  const outOfRange = value && (value > latestISO || value < earliestISO);

  const selectCls = 'rk-input';

  return (
    <div>
      <div className="grid grid-cols-3 gap-2">
        <select
          id={id}
          className={selectCls}
          value={vd}
          onChange={(e) => emit({ y: vy, m: vm, d: e.target.value })}
          required={required}
          disabled={disabled}
          aria-label={t('dob_day')}
        >
          <option value="">{t('dob_day')}</option>
          {Array.from({ length: dayCount }, (_, i) => i + 1).map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>

        <select
          className={selectCls}
          value={vm}
          onChange={(e) =>
            emit({ y: vy, m: e.target.value, d: keepDay(vy, e.target.value) })
          }
          required={required}
          disabled={disabled}
          aria-label={t('dob_month')}
        >
          <option value="">{t('dob_month')}</option>
          {months.map((name, i) => (
            <option key={name} value={i + 1}>
              {name}
            </option>
          ))}
        </select>

        <select
          className={selectCls}
          value={vy}
          onChange={(e) =>
            emit({ y: e.target.value, m: vm, d: keepDay(e.target.value, vm) })
          }
          required={required}
          disabled={disabled}
          aria-label={t('dob_year')}
        >
          <option value="">{t('dob_year')}</option>
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </div>

      {outOfRange ? (
        <p className="mt-1 text-xs font-medium text-rk-700">
          {t('dob_out_of_range', { min: minAge, max: maxAge })}
        </p>
      ) : null}
    </div>
  );
}

export default DateOfBirthInput;
