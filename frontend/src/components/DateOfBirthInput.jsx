import { useMemo } from 'react';

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

// Native month names, so a Marathi session reads महिने rather than '08'. CLDR
// covers mr and hi; the try/catch is for an engine that does not, where an
// English month name beats a crash or a bare number.
function monthNames(lang) {
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
  const months = useMemo(() => monthNames(lang), [lang]);

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

  const [vy = '', vm = '', vd = ''] = String(value || '').split('-');

  // Only a complete triple is a date. A half-filled picker emits '' so the
  // parent's `required` still fires rather than posting '1998--07'.
  const emit = (y, m, d) => {
    onChange(y && m && d ? `${y}-${pad(m)}-${pad(d)}` : '');
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
          value={String(Number(vd) || '')}
          onChange={(e) => emit(vy, vm, e.target.value)}
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
          value={String(Number(vm) || '')}
          onChange={(e) => emit(vy, e.target.value, keepDay(vy, e.target.value))}
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
          value={vy || ''}
          onChange={(e) => emit(e.target.value, vm, keepDay(e.target.value, vm))}
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
