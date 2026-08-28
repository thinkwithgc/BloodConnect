import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';

import { DateOfBirthInput } from '../DateOfBirthInput.jsx';
import { apiRequest } from '../../lib/api.js';

/**
 * Shared bulk donor upload UI — usable from /admin (ngo_admin) or the
 * blood-bank portal (blood_bank). Backend POST /donors/bulk-upload
 * branches on caller role to set registration_source (IMP vs BBK).
 *
 * Flow:
 *   1. Operator picks a CSV file
 *   2. Frontend parses CSV client-side, shows a preview of first 5 rows
 *      + total count + validates required headers
 *   3. Operator clicks Upload → backend processes per-row + returns a
 *      result table: imported / skipped_duplicate / invalid (with reason)
 *
 * Conservative columns per the design decision:
 *   Required: full_name, mobile, blood_group_code (A+ / O- etc)
 *   Optional: date_of_birth (YYYY-MM-DD), gender (M/F/O), pincode, village_id
 *
 * Donors are imported as inert (consent_data_use=FALSE). They become
 * matchable only after activating at next donation (BB inline flow) or
 * via web self-register that merges into the imported row.
 */
const REQUIRED_HEADERS = ['full_name', 'mobile', 'blood_group_code'];
const OPTIONAL_HEADERS = ['date_of_birth', 'gender', 'pincode', 'village_id'];
const VALID_BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const VALID_GENDERS = ['M', 'F', 'O'];

// Sample CSV with realistic example rows. Operators download → open in
// Excel/Sheets → replace the example rows with their own data → save as
// CSV → upload. Keeps column names + value formats exact.
const SAMPLE_CSV = [
  'full_name,mobile,blood_group_code,date_of_birth,gender,pincode,village_id',
  '"Anjali Sharma",+918586999911,B+,1990-05-15,F,444601,',
  '"Rajesh Patil",+919876543210,O-,1985-11-22,M,,',
  '"Sunita Deshmukh",+919123456789,A+,,F,,',
].join('\n') + '\n';

function downloadSampleCsv() {
  const blob = new Blob([SAMPLE_CSV], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'raktify-donor-upload-sample.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Per-row client-side validation — mirrors the backend Zod schema so the
// operator sees errors in the preview before uploading. Returns null if
// the row is valid, otherwise a short error string.
function validateRow(row) {
  if (!row.full_name || row.full_name.length < 2) return 'full_name too short';
  if (!row.mobile || !/^(\+?91[-\s]?)?[6-9]\d{9}$/.test(row.mobile.replace(/\s/g, '')))
    return 'invalid mobile';
  if (!row.blood_group_code) return 'blood_group_code missing';
  if (!VALID_BLOOD_GROUPS.includes(row.blood_group_code.toUpperCase()))
    return `blood group must be one of ${VALID_BLOOD_GROUPS.join('/')}`;
  if (row.gender && !VALID_GENDERS.includes(row.gender.toUpperCase()))
    return `gender must be M, F, or O (or blank)`;
  if (row.date_of_birth && !/^\d{4}-\d{2}-\d{2}$/.test(row.date_of_birth))
    return 'date_of_birth must be YYYY-MM-DD (or blank)';
  if (row.pincode && !/^[1-9]\d{5}$/.test(row.pincode))
    return 'pincode must be 6 digits, not starting with 0';
  return null;
}

function parseCsv(text) {
  // Tiny CSV parser — handles quoted fields and embedded commas. No
  // escape-quote support (`""`); good enough for the conservative
  // 3-required-column shape. Operators paste from Excel which uses this
  // dialect by default.
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const parseLine = (line) => {
    const out = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        inQ = !inQ;
      } else if (ch === ',' && !inQ) {
        out.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const headers = parseLine(lines[0]).map((h) => h.toLowerCase());
  const rows = lines.slice(1).map((line) => {
    const cols = parseLine(line);
    const obj = {};
    headers.forEach((h, i) => {
      if (cols[i] !== undefined && cols[i] !== '') obj[h] = cols[i];
    });
    return obj;
  });
  return { headers, rows };
}

export function DonorBulkUpload() {
  const [csvText, setCsvText] = useState('');
  const [filename, setFilename] = useState('');
  const [parseError, setParseError] = useState(null);
  const [results, setResults] = useState(null);

  const parsed = csvText
    ? (() => {
        try {
          return parseCsv(csvText);
        } catch (e) {
          return { error: e.message };
        }
      })()
    : null;
  const missingHeaders = parsed?.headers
    ? REQUIRED_HEADERS.filter((h) => !parsed.headers.includes(h))
    : [];
  // Per-row validation (only when headers are valid). Lets the operator
  // see + fix problems in their spreadsheet before burning a server
  // round-trip. Backend re-validates anyway.
  const rowErrors =
    parsed && !parsed.error && missingHeaders.length === 0
      ? parsed.rows.map((r) => validateRow(r))
      : [];
  const invalidRowCount = rowErrors.filter((e) => e !== null).length;
  const canUpload =
    parsed &&
    !parsed.error &&
    missingHeaders.length === 0 &&
    parsed.rows.length > 0 &&
    invalidRowCount === 0;

  const upload = useMutation({
    mutationFn: () => {
      // Coerce numeric village_id from string.
      const rows = parsed.rows.map((r) => ({
        ...r,
        ...(r.village_id ? { village_id: Number(r.village_id) } : {}),
      }));
      return apiRequest('POST', '/donors/bulk-upload', { rows });
    },
    onSuccess: (data) => setResults(data),
    onError: (err) =>
      setParseError(
        err?.response?.data?.error
          ? `${err.response.data.error}: ${err.response.data.details ? JSON.stringify(err.response.data.details).slice(0, 200) : ''}`
          : 'upload_failed',
      ),
  });

  function handleFile(e) {
    setParseError(null);
    setResults(null);
    const file = e.target.files?.[0];
    if (!file) return;
    setFilename(file.name);
    const reader = new FileReader();
    reader.onload = () => setCsvText(String(reader.result || ''));
    reader.onerror = () => setParseError('Could not read file');
    reader.readAsText(file);
  }

  function reset() {
    setCsvText('');
    setFilename('');
    setResults(null);
    setParseError(null);
  }

  return (
    <section className="space-y-4">
      <div className="rk-card">
        <h2 className="text-lg font-semibold text-stone-900">Bulk donor upload</h2>
        <p className="mt-1 text-sm text-stone-600">
          Imported donors are <strong>inert</strong> — they don&apos;t receive any WhatsApp
          messages and are excluded from emergency matching until they activate (in person at
          their next donation, or via web self-register).
        </p>
        <div className="mt-3 flex items-start justify-between gap-3 rounded border border-slate-200 bg-slate-50 p-3 text-xs text-stone-700">
          <div className="min-w-0">
            <p className="font-semibold">CSV format</p>
            <p className="mt-1">
              Required columns (header row, exact names):{' '}
              <code className="font-mono text-[11px]">{REQUIRED_HEADERS.join(', ')}</code>
            </p>
            <p className="mt-1">
              Optional columns:{' '}
              <code className="font-mono text-[11px]">{OPTIONAL_HEADERS.join(', ')}</code>
            </p>
            <p className="mt-2">
              <strong>Blood group:</strong> must be one of{' '}
              <code className="font-mono text-[11px]">{VALID_BLOOD_GROUPS.join(' / ')}</code>
            </p>
            <p>
              <strong>Gender:</strong>{' '}
              <code className="font-mono text-[11px]">M</code> (male),{' '}
              <code className="font-mono text-[11px]">F</code> (female),{' '}
              <code className="font-mono text-[11px]">O</code> (other) — or blank
            </p>
            <p>
              <strong>Date of birth:</strong>{' '}
              <code className="font-mono text-[11px]">YYYY-MM-DD</code> (e.g. 1990-05-15) — or
              blank
            </p>
            <p className="mt-2 text-stone-500">Max 2000 rows per upload.</p>
          </div>
          <button
            type="button"
            onClick={downloadSampleCsv}
            className="rk-button-secondary shrink-0 text-xs"
          >
            ⬇ Sample CSV
          </button>
        </div>
      </div>

      <div className="rk-card space-y-3">
        <label className="block">
          <span className="rk-label">Pick a CSV file</span>
          <input
            type="file"
            accept=".csv,text/csv"
            className="rk-input w-full"
            onChange={handleFile}
          />
        </label>
        {filename ? (
          <p className="text-xs text-stone-600">
            Loaded: <code>{filename}</code>
          </p>
        ) : null}

        {parseError ? (
          <p className="text-sm text-rk-700">{parseError}</p>
        ) : null}

        {parsed?.error ? <p className="text-sm text-rk-700">Parse error: {parsed.error}</p> : null}

        {parsed && !parsed.error ? (
          <div className="rounded border border-slate-200 bg-slate-50 p-3 text-xs">
            <p className="font-semibold">Preview: {parsed.rows.length} rows</p>
            <p className="mt-1 text-stone-600">
              Headers detected: <code className="font-mono">{parsed.headers.join(', ')}</code>
            </p>
            {missingHeaders.length > 0 ? (
              <p className="mt-1 text-rk-700">
                Missing required: <code>{missingHeaders.join(', ')}</code>
              </p>
            ) : (
              <>
                {invalidRowCount > 0 ? (
                  <p className="mt-1 text-rk-700">
                    ⚠ {invalidRowCount} row{invalidRowCount === 1 ? '' : 's'} have validation
                    errors — fix in your spreadsheet + reload. Upload disabled until all rows
                    are valid.
                  </p>
                ) : (
                  <p className="mt-1 text-emerald-700">✓ All {parsed.rows.length} rows valid</p>
                )}
                <table className="mt-2 min-w-full text-[11px]">
                  <thead>
                    <tr className="text-left text-slate-500">
                      <th className="px-2 py-1">Row</th>
                      {parsed.headers.map((h) => (
                        <th key={h} className="px-2 py-1">{h}</th>
                      ))}
                      <th className="px-2 py-1">Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* Show invalid rows first (up to 5), then a sample of valid rows */}
                    {parsed.rows
                      .map((r, i) => ({ r, i, err: rowErrors[i] }))
                      .filter(({ err }) => err !== null)
                      .slice(0, 5)
                      .map(({ r, i, err }) => (
                        <tr key={`bad-${i}`} className="border-t border-slate-200 bg-rk-50/40">
                          <td className="px-2 py-1 font-mono">{i + 2}</td>
                          {parsed.headers.map((h) => (
                            <td key={h} className="px-2 py-1 font-mono">{r[h] || ''}</td>
                          ))}
                          <td className="px-2 py-1 text-rk-700">{err}</td>
                        </tr>
                      ))}
                    {parsed.rows
                      .map((r, i) => ({ r, i, err: rowErrors[i] }))
                      .filter(({ err }) => err === null)
                      .slice(0, invalidRowCount > 0 ? 2 : 5)
                      .map(({ r, i }) => (
                        <tr key={`ok-${i}`} className="border-t border-slate-200">
                          <td className="px-2 py-1 font-mono">{i + 2}</td>
                          {parsed.headers.map((h) => (
                            <td key={h} className="px-2 py-1 font-mono">{r[h] || ''}</td>
                          ))}
                          <td className="px-2 py-1 text-emerald-700">✓</td>
                        </tr>
                      ))}
                    {parsed.rows.length > 5 ? (
                      <tr>
                        <td
                          colSpan={parsed.headers.length + 2}
                          className="px-2 py-1 text-center text-slate-500"
                        >
                          … and {parsed.rows.length - Math.min(5, parsed.rows.length)} more rows
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </>
            )}
          </div>
        ) : null}

        <div className="flex gap-2">
          <button
            type="button"
            className="rk-button-primary flex-1"
            disabled={!canUpload || upload.isPending}
            onClick={() => upload.mutate()}
          >
            {upload.isPending
              ? 'Uploading…'
              : parsed && !parsed.error
                ? `Upload ${parsed.rows.length} rows`
                : 'Upload'}
          </button>
          {csvText ? (
            <button type="button" className="rk-button-secondary" onClick={reset}>
              Clear
            </button>
          ) : null}
        </div>
      </div>

      {results ? (
        <div className="rk-card">
          <h3 className="text-base font-semibold text-stone-900">Results</h3>
          <p className="mt-1 text-sm text-stone-600">
            Total <strong>{results.total}</strong> · Imported{' '}
            <strong className="text-emerald-700">{results.imported}</strong> · Skipped (duplicate){' '}
            <strong className="text-amber-700">{results.skipped_duplicate}</strong> · Invalid{' '}
            <strong className="text-rk-700">{results.invalid}</strong> · Source{' '}
            <code className="font-mono">{results.source}</code>
          </p>
          <div className="mt-3 max-h-96 overflow-y-auto">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-2 py-1 text-left">Row</th>
                  <th className="px-2 py-1 text-left">Status</th>
                  <th className="px-2 py-1 text-left">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(results.results || []).map((r) => (
                  <tr key={r.row_index}>
                    <td className="px-2 py-1 font-mono">{r.row_index + 1}</td>
                    <td className="px-2 py-1">
                      {r.status === 'imported' ? (
                        <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-800">
                          imported
                        </span>
                      ) : r.status === 'skipped_duplicate' ? (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">
                          duplicate
                        </span>
                      ) : (
                        <span className="rounded bg-rk-100 px-1.5 py-0.5 text-rk-800">invalid</span>
                      )}
                    </td>
                    <td className="px-2 py-1 font-mono text-stone-600">
                      {r.reason || r.donor_id || ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Inline activation modal for a single imported donor at the point of
 * donation. Captures the missing fields (DOB, gender) + a consent
 * checkbox, posts to /donors/:id/complete-import. On success, the parent
 * (RecordDonation in BloodBankPortal) re-runs the lookup to refresh state.
 */
export function ActivateImportButton({ donor, onActivated }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="rk-button-primary mt-2 text-xs"
        onClick={() => setOpen(true)}
      >
        Activate donor (complete registration)
      </button>
      {open ? (
        <ActivateImportModal
          donor={donor}
          onClose={() => setOpen(false)}
          onActivated={(result) => {
            setOpen(false);
            if (onActivated) onActivated(result);
          }}
        />
      ) : null}
    </>
  );
}

function ActivateImportModal({ donor, onClose, onActivated }) {
  const [form, setForm] = useState({
    date_of_birth: donor.date_of_birth || '',
    gender: donor.gender || '',
    blood_group_self_reported: donor.blood_group_self_reported || '',
    pincode: '',
    consent_given: false,
  });
  const [error, setError] = useState(null);

  const submit = useMutation({
    mutationFn: () => {
      const body = {
        date_of_birth: form.date_of_birth,
        gender: form.gender,
        consent_given: true,
      };
      if (form.blood_group_self_reported)
        body.blood_group_self_reported = Number(form.blood_group_self_reported);
      if (form.pincode) body.pincode = form.pincode;
      return apiRequest('POST', `/donors/${donor.donor_id}/complete-import`, body);
    },
    onSuccess: (data) => {
      if (data.status === 'soft_decline') {
        setError(
          'Donor failed pre-screening: ' + (data.blocks?.join(', ') || data.reason || 'declined'),
        );
        return;
      }
      onActivated(data);
    },
    onError: (err) => setError(err?.response?.data?.error || 'activate_failed'),
  });

  const canSubmit = form.date_of_birth && form.gender && form.consent_given;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-lg max-h-[90vh] overflow-y-auto">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            if (canSubmit) submit.mutate();
          }}
          className="space-y-3"
        >
          <h3 className="text-lg font-semibold text-stone-900">Activate donor</h3>
          <p className="text-xs text-stone-600">
            <strong>{donor.full_name}</strong> — was bulk-imported and needs to complete consent
            + verify their details before this donation can be recorded.
          </p>

          <label className="block">
            <span className="rk-label">Date of birth *</span>
            <DateOfBirthInput
              value={form.date_of_birth}
              onChange={(iso) => setForm({ ...form, date_of_birth: iso })}
              required
            />
          </label>

          <label className="block">
            <span className="rk-label">Gender *</span>
            <select
              className="rk-input w-full"
              value={form.gender}
              onChange={(e) => setForm({ ...form, gender: e.target.value })}
              required
            >
              <option value="">—</option>
              <option value="M">Male</option>
              <option value="F">Female</option>
              <option value="O">Other / prefer not to say</option>
            </select>
          </label>

          <label className="block">
            <span className="rk-label">Confirm blood group (self-reported)</span>
            <select
              className="rk-input w-full"
              value={form.blood_group_self_reported}
              onChange={(e) =>
                setForm({ ...form, blood_group_self_reported: e.target.value })
              }
            >
              <option value="">— keep imported value —</option>
              <option value="1">A+</option>
              <option value="2">A-</option>
              <option value="3">B+</option>
              <option value="4">B-</option>
              <option value="5">AB+</option>
              <option value="6">AB-</option>
              <option value="7">O+</option>
              <option value="8">O-</option>
            </select>
          </label>

          <label className="block">
            <span className="rk-label">Pincode (optional)</span>
            <input
              type="text"
              className="rk-input w-full font-mono"
              value={form.pincode}
              onChange={(e) => setForm({ ...form, pincode: e.target.value.replace(/\D/g, '').slice(0, 6) })}
              pattern="^[1-9]\d{5}$"
            />
          </label>

          <label className="flex items-start gap-2 text-sm text-stone-700">
            <input
              type="checkbox"
              checked={form.consent_given}
              onChange={(e) => setForm({ ...form, consent_given: e.target.checked })}
              className="mt-1"
            />
            <span>
              <strong>Donor has verbally agreed</strong> to Raktify processing their data + being
              contacted for future blood-donation matches.
            </span>
          </label>

          {error ? <p className="text-sm text-rk-700">{error}</p> : null}

          <div className="flex gap-2 pt-2">
            <button type="button" className="rk-button-secondary flex-1" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="rk-button-primary flex-1"
              disabled={!canSubmit || submit.isPending}
            >
              {submit.isPending ? 'Activating…' : 'Activate'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
