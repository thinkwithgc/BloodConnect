import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { DateOfBirthInput } from '../../components/DateOfBirthInput.jsx';
import { apiRequest } from '../../lib/api.js';
import { todayISO } from '../../lib/dateBounds.js';

const COMPONENTS = [
  { id: 1, code: 'WB',   label: 'Whole blood' },
  { id: 2, code: 'PRBC', label: 'Packed RBC' },
  { id: 3, code: 'FFP',  label: 'Fresh frozen plasma' },
  { id: 4, code: 'PLT',  label: 'Platelet concentrate' },
  { id: 5, code: 'SDP',  label: 'Single-donor platelets' },
  { id: 6, code: 'CRY',  label: 'Cryoprecipitate' },
];

const BLOOD_GROUPS = [
  { id: 1, code: 'A+' },  { id: 2, code: 'A-' },
  { id: 3, code: 'B+' },  { id: 4, code: 'B-' },
  { id: 5, code: 'AB+' }, { id: 6, code: 'AB-' },
  { id: 7, code: 'O+' },  { id: 8, code: 'O-' },
];

function fmtDate(v) {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return String(v);
  }
}

function daysUntil(iso) {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
}

export function ThalassemiaTab() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);

  const listQ = useQuery({
    queryKey: ['admin', 'thalassemia'],
    queryFn: () => apiRequest('GET', '/registries/thalassemia'),
    staleTime: 30_000,
  });

  const bumpTransfusion = useMutation({
    mutationFn: (id) =>
      apiRequest('POST', `/registries/thalassemia/${id}/transfusion`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'thalassemia'] }),
  });

  const rows = listQ.data?.patients || [];

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Thalassemia patient registry
        </h2>
        <button
          type="button"
          className="rk-button-primary text-sm"
          onClick={() => setShowForm((s) => !s)}
        >
          {showForm ? 'Close' : '+ Enrol patient'}
        </button>
      </div>

      {showForm ? (
        <EnrolForm
          onCreated={() => {
            setShowForm(false);
            qc.invalidateQueries({ queryKey: ['admin', 'thalassemia'] });
          }}
        />
      ) : null}

      <div className="rk-card overflow-x-auto p-0">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left">Patient</th>
              <th className="px-3 py-2 text-left">Treating hospital</th>
              <th className="px-3 py-2 text-left">Group · Component</th>
              <th className="px-3 py-2 text-right">Interval</th>
              <th className="px-3 py-2 text-left">Last transfusion</th>
              <th className="px-3 py-2 text-left">Next due</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((p) => {
              const days = daysUntil(p.next_transfusion_due);
              const cls =
                days == null
                  ? 'text-slate-500'
                  : days <= 0
                    ? 'font-semibold text-rk-700'
                    : days <= 7
                      ? 'font-semibold text-amber-600'
                      : 'text-slate-700';
              return (
                <tr key={p.id}>
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-900">{p.full_name}</div>
                    <div className="text-xs text-slate-500">
                      {fmtDate(p.date_of_birth)} · {p.gender}
                      {p.diagnosis_subtype ? ` · ${p.diagnosis_subtype}` : ''}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-slate-700">{p.treating_hospital_name}</td>
                  <td className="px-3 py-2">
                    <span className="font-semibold text-rk-700">{p.blood_group_code}</span>
                    <span className="text-xs text-slate-500"> · {p.component_code} ×{p.default_units}</span>
                  </td>
                  <td className="px-3 py-2 text-right text-slate-700">
                    {p.transfusion_interval_days} d
                  </td>
                  <td className="px-3 py-2 text-slate-700">{fmtDate(p.last_transfusion_date)}</td>
                  <td className={`px-3 py-2 ${cls}`}>
                    {fmtDate(p.next_transfusion_due)}
                    {days != null ? (
                      <span className="ml-1 text-xs">
                        ({days <= 0 ? 'overdue' : `${days}d`})
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      className="text-xs font-medium text-rk-700 hover:underline"
                      onClick={() => bumpTransfusion.mutate(p.id)}
                      disabled={bumpTransfusion.isPending}
                    >
                      Record transfusion
                    </button>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && !listQ.isLoading ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-sm text-slate-500">
                  No patients enrolled yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function EnrolForm({ onCreated }) {
  const [form, setForm] = useState({
    full_name: '',
    date_of_birth: '',
    gender: 'M',
    guardian_name: '',
    guardian_mobile: '',
    blood_group_id: 1,
    default_component_id: 2,
    diagnosis_subtype: 'Beta major',
    transfusion_interval_days: 21,
    last_transfusion_date: '',
    default_units: 1,
    treating_hospital_id: '',
  });
  const [err, setErr] = useState('');

  const create = useMutation({
    mutationFn: () =>
      apiRequest('POST', '/registries/thalassemia', {
        ...form,
        blood_group_id: Number(form.blood_group_id),
        default_component_id: Number(form.default_component_id),
        default_units: Number(form.default_units),
        transfusion_interval_days: Number(form.transfusion_interval_days),
        guardian_name: form.guardian_name || undefined,
        guardian_mobile: form.guardian_mobile || undefined,
        last_transfusion_date: form.last_transfusion_date || undefined,
        diagnosis_subtype: form.diagnosis_subtype || undefined,
      }),
    onSuccess: () => onCreated(),
    onError: (e) => setErr(e?.response?.data?.error || 'create_failed'),
  });

  function set(k, v) {
    setForm((p) => ({ ...p, [k]: v }));
  }
  function submit(e) {
    e.preventDefault();
    setErr('');
    create.mutate();
  }

  return (
    <form onSubmit={submit} className="rk-card grid gap-3 sm:grid-cols-3">
      <h3 className="col-span-full text-sm font-semibold uppercase tracking-wide text-slate-500">
        Enrol new patient
      </h3>
      <label className="block">
        <span className="rk-label">Full name</span>
        <input className="rk-input" value={form.full_name} onChange={(e) => set('full_name', e.target.value)} required />
      </label>
      <label className="block">
        <span className="rk-label">Date of birth</span>
        {/* minAge 0 / maxAge 90: a thalassemia patient is usually a child, and
            024 puts no age CHECK on this column for exactly that reason. */}
        <DateOfBirthInput
          value={form.date_of_birth}
          onChange={(iso) => set('date_of_birth', iso)}
          minAge={0}
          maxAge={90}
          required
        />
      </label>
      <label className="block">
        <span className="rk-label">Gender</span>
        <select className="rk-input" value={form.gender} onChange={(e) => set('gender', e.target.value)}>
          <option value="M">Male</option>
          <option value="F">Female</option>
          <option value="O">Other</option>
        </select>
      </label>
      <label className="block">
        <span className="rk-label">Blood group</span>
        <select className="rk-input" value={form.blood_group_id} onChange={(e) => set('blood_group_id', e.target.value)}>
          {BLOOD_GROUPS.map((b) => (
            <option key={b.id} value={b.id}>{b.code}</option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="rk-label">Default component</span>
        <select className="rk-input" value={form.default_component_id} onChange={(e) => set('default_component_id', e.target.value)}>
          {COMPONENTS.map((c) => (
            <option key={c.id} value={c.id}>{c.code} — {c.label}</option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="rk-label">Diagnosis subtype</span>
        <input className="rk-input" value={form.diagnosis_subtype} onChange={(e) => set('diagnosis_subtype', e.target.value)} />
      </label>
      <label className="block">
        <span className="rk-label">Interval (days)</span>
        <input
          className="rk-input"
          inputMode="numeric"
          value={form.transfusion_interval_days}
          onChange={(e) => set('transfusion_interval_days', e.target.value.replace(/\D/g, '') || 21)}
        />
      </label>
      <label className="block">
        <span className="rk-label">Default units</span>
        <input
          className="rk-input"
          inputMode="numeric"
          value={form.default_units}
          onChange={(e) => set('default_units', e.target.value.replace(/\D/g, '') || 1)}
        />
      </label>
      <label className="block">
        <span className="rk-label">Last transfusion (optional)</span>
        <input type="date" className="rk-input" value={form.last_transfusion_date} onChange={(e) => set('last_transfusion_date', e.target.value)} max={todayISO()} />
      </label>
      <label className="block sm:col-span-2">
        <span className="rk-label">Guardian name (paediatric)</span>
        <input className="rk-input" value={form.guardian_name} onChange={(e) => set('guardian_name', e.target.value)} />
      </label>
      <label className="block">
        <span className="rk-label">Guardian mobile</span>
        <input className="rk-input" value={form.guardian_mobile} onChange={(e) => set('guardian_mobile', e.target.value)} placeholder="9XXXXXXXXX" />
      </label>
      <label className="block sm:col-span-3">
        <span className="rk-label">Treating hospital ID (UUID)</span>
        <input className="rk-input font-mono text-xs" value={form.treating_hospital_id} onChange={(e) => set('treating_hospital_id', e.target.value)} placeholder="paste hospital institution UUID" required />
        <span className="mt-1 block text-xs text-slate-500">
          For demo: copy a hospital ID from the Onboarding tab. We&apos;ll add a picker later.
        </span>
      </label>
      {err ? <p className="col-span-full text-sm text-rk-700">{err}</p> : null}
      <div className="col-span-full flex justify-end">
        <button type="submit" className="rk-button-primary text-sm" disabled={create.isPending}>
          {create.isPending ? '…' : 'Enrol patient'}
        </button>
      </div>
    </form>
  );
}
