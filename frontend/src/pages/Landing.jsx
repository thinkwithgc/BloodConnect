import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useT } from '../i18n/useT.js';
import { LANG_LABELS } from '../i18n/strings.js';
import { Wordmark } from '../components/Wordmark.jsx';
import { Footer } from '../components/Footer.jsx';

// ── Inline icons (lucide-style, stroke-based — no icon-lib dependency) ──────
function Icon({ path, className = 'h-6 w-6', fill = false }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill={fill ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {path}
    </svg>
  );
}
const DropletIcon = (p) => (
  <Icon {...p} path={<path d="M12 2.5c4 4.8 7 8.3 7 11.5a7 7 0 0 1-14 0c0-3.2 3-6.7 7-11.5Z" />} />
);
const HospitalIcon = (p) => (
  <Icon
    {...p}
    path={
      <>
        <path d="M3 21h18M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16" />
        <path d="M12 7v6M9 10h6" />
      </>
    }
  />
);
const ShieldIcon = (p) => (
  <Icon {...p} path={<path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3Z" />} />
);
const LockIcon = (p) => (
  <Icon
    {...p}
    path={
      <>
        <rect x="4" y="11" width="16" height="9" rx="2" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </>
    }
  />
);
const FlaskIcon = (p) => (
  <Icon {...p} path={<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3M7 14h10" />} />
);
const CheckIcon = (p) => <Icon {...p} path={<path d="m20 6-11 11-5-5" />} />;
const ArrowIcon = (p) => <Icon {...p} path={<path d="M5 12h14M13 5l7 7-7 7" />} />;
const UserPlusIcon = (p) => (
  <Icon
    {...p}
    path={
      <>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M19 8v6M22 11h-6" />
      </>
    }
  />
);
const SendIcon = (p) => <Icon {...p} path={<path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z" />} />;

// Small chevron used inside dropdown triggers. Rotates 180° when open.
function NavChevron({ open }) {
  return (
    <svg
      className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="m3 5 3 3 3-3" />
    </svg>
  );
}

export function Landing() {
  const { t, lang, setLang, supported } = useT();

  // Three clusters in the top nav: brand · primary CTAs · utility (language,
  // institutions, log in). The institutions and language buttons are
  // dropdowns; clicking outside closes them. Mobile collapses everything
  // except the brand + the donor CTA + a hamburger into a drawer.
  const [langOpen, setLangOpen] = useState(false);
  const [instOpen, setInstOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const navRef = useRef(null);

  useEffect(() => {
    function onPointerDown(e) {
      if (navRef.current && !navRef.current.contains(e.target)) {
        setLangOpen(false);
        setInstOpen(false);
      }
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        setLangOpen(false);
        setInstOpen(false);
        setMobileOpen(false);
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <div className="min-h-full bg-cream font-sans text-stone-800">
      {/* ── Nav ─────────────────────────────────────────────────────────── */}
      <header
        ref={navRef}
        className="sticky top-0 z-30 border-b border-sand/80 bg-cream/85 backdrop-blur"
      >
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-5 py-3">
          {/* Cluster 1 — brand + orientation link */}
          <div className="flex items-center gap-4">
            <Link to="/" className="flex items-center" aria-label="Raktify home">
              <Wordmark tm className="text-2xl" />
            </Link>
            {/* First-time visitors (esp. via search) need "what is this?" up
                front — a quiet, always-visible link into the full explainer.
                Static page, so a plain <a>, not a router <Link>. */}
            <a
              href="/how-raktify-works.html"
              className="hidden text-sm font-semibold text-stone-600 transition-colors hover:text-rk-700 md:inline"
            >
              {t('lp_nav_how')}
            </a>
          </div>

          {/* Cluster 2 — primary public CTAs (desktop only) */}
          <div className="hidden items-center gap-2 md:flex">
            <Link
              to="/register"
              className="rounded-lg bg-rk-700 px-4 py-2 text-sm font-semibold text-white shadow-soft transition-colors hover:bg-rk-800"
            >
              {t('lp_cta_donor')}
            </Link>
            <Link
              to="/camps/host"
              className="rounded-lg border border-rk-700/40 px-4 py-2 text-sm font-semibold text-rk-700 transition-colors hover:bg-rk-50"
            >
              {t('lp_nav_host_camp')}
            </Link>
          </div>

          {/* Cluster 3 — utility (language, institutions, log in, mobile menu) */}
          <div className="flex items-center gap-2 sm:gap-3">
            {/* Visual divider between primary CTAs and utility chrome */}
            <div className="hidden h-6 w-px bg-sand md:block" />

            {/* Language dropdown */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setLangOpen((o) => !o);
                  setInstOpen(false);
                }}
                className="flex items-center gap-1 rounded-full bg-white px-3 py-1.5 text-xs font-semibold uppercase text-stone-600 shadow-soft ring-1 ring-sand transition-colors hover:text-stone-900"
                aria-haspopup="true"
                aria-expanded={langOpen}
                aria-label={t('lp_nav_lang_label')}
              >
                {lang}
                <NavChevron open={langOpen} />
              </button>
              {langOpen && (
                <div
                  role="menu"
                  className="absolute right-0 top-full z-40 mt-1 w-44 rounded-xl border border-sand bg-white p-1.5 shadow-lift"
                >
                  {supported.map((l) => (
                    <button
                      key={l}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setLang(l);
                        setLangOpen(false);
                      }}
                      className={
                        'flex w-full items-center justify-between rounded-lg px-3 py-2 transition-colors ' +
                        (lang === l ? 'bg-cream' : 'hover:bg-cream')
                      }
                    >
                      <span
                        className={
                          'text-sm ' +
                          (lang === l
                            ? 'font-semibold text-stone-900'
                            : 'font-medium text-stone-700')
                        }
                      >
                        {LANG_LABELS[l]}
                      </span>
                      <span
                        className={
                          'text-xs font-semibold ' +
                          (lang === l ? 'text-rk-700' : 'text-stone-400')
                        }
                      >
                        {l.toUpperCase()}
                        {lang === l ? ' ✓' : ''}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Institutions dropdown (desktop only) */}
            <div className="relative hidden md:block">
              <button
                type="button"
                onClick={() => {
                  setInstOpen((o) => !o);
                  setLangOpen(false);
                }}
                className={
                  'flex items-center gap-1 text-sm font-semibold transition-colors hover:text-rk-700 ' +
                  (instOpen ? 'text-rk-700' : 'text-stone-600')
                }
                aria-haspopup="true"
                aria-expanded={instOpen}
              >
                {t('lp_nav_institutions')}
                <NavChevron open={instOpen} />
              </button>
              {instOpen && (
                <div
                  role="menu"
                  className="absolute right-0 top-full z-40 mt-2 w-80 rounded-xl border border-sand bg-white p-2 shadow-lift"
                >
                  <Link
                    to="/staff/login"
                    role="menuitem"
                    onClick={() => setInstOpen(false)}
                    className="block rounded-lg p-3 transition-colors hover:bg-cream"
                  >
                    <div className="text-sm font-semibold text-stone-900">
                      {t('lp_nav_inst_signin')}
                    </div>
                    <div className="mt-0.5 text-xs text-stone-500">
                      {t('lp_nav_inst_signin_sub')}
                    </div>
                  </Link>
                  <Link
                    to="/onboarding/apply"
                    role="menuitem"
                    onClick={() => setInstOpen(false)}
                    className="block rounded-lg p-3 transition-colors hover:bg-cream"
                  >
                    <div className="text-sm font-semibold text-stone-900">
                      {t('lp_nav_inst_apply')}
                    </div>
                    <div className="mt-0.5 text-xs text-stone-500">
                      {t('lp_nav_inst_apply_sub')}
                    </div>
                  </Link>
                </div>
              )}
            </div>

            {/* Donor log-in (desktop only) */}
            <Link
              to="/login"
              className="hidden text-sm font-semibold text-stone-600 transition-colors hover:text-rk-700 md:inline"
            >
              {t('lp_cta_login')}
            </Link>

            {/* Mobile-only: keep the donor CTA visible + hamburger */}
            <Link
              to="/register"
              className="rounded-lg bg-rk-700 px-3 py-1.5 text-xs font-semibold text-white shadow-soft transition-colors hover:bg-rk-800 md:hidden"
            >
              {t('lp_cta_donor')}
            </Link>
            <button
              type="button"
              onClick={() => setMobileOpen((o) => !o)}
              className="rounded-md p-1.5 text-stone-700 ring-1 ring-sand transition-colors hover:bg-white md:hidden"
              aria-label={t('lp_nav_menu')}
              aria-expanded={mobileOpen}
            >
              {mobileOpen ? (
                <svg
                  className="h-5 w-5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <path d="M6 6l12 12M18 6l-12 12" />
                </svg>
              ) : (
                <svg
                  className="h-5 w-5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <path d="M3 6h18M3 12h18M3 18h18" />
                </svg>
              )}
            </button>
          </div>
        </div>

        {/* Mobile drawer — only visible when hamburger is open */}
        {mobileOpen && (
          <nav className="border-t border-sand bg-white px-2 py-2 md:hidden">
            {/* Orientation link first + highlighted — first-time visitors
                on mobile need "what is this?" before anything else. */}
            <a
              href="/how-raktify-works.html"
              onClick={() => setMobileOpen(false)}
              className="mb-1 flex items-center gap-2 rounded-lg bg-rk-50 px-3 py-3 text-sm font-semibold text-rk-700 transition-colors hover:bg-rk-100"
            >
              <span aria-hidden="true">🗺️</span>
              {t('lp_nav_how')}
            </a>
            <Link
              to="/camps/host"
              onClick={() => setMobileOpen(false)}
              className="block rounded-lg px-3 py-3 text-sm font-semibold text-stone-800 transition-colors hover:bg-cream"
            >
              {t('lp_nav_host_camp')}
            </Link>
            <div className="my-1 border-t border-sand/70" />
            <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-stone-400">
              {t('lp_nav_institutions')}
            </div>
            <Link
              to="/staff/login"
              onClick={() => setMobileOpen(false)}
              className="block rounded-lg px-3 py-2.5 text-sm text-stone-700 transition-colors hover:bg-cream"
            >
              {t('lp_nav_inst_signin')}
            </Link>
            <Link
              to="/onboarding/apply"
              onClick={() => setMobileOpen(false)}
              className="block rounded-lg px-3 py-2.5 text-sm text-stone-700 transition-colors hover:bg-cream"
            >
              {t('lp_nav_inst_apply')}
            </Link>
            <div className="my-1 border-t border-sand/70" />
            <Link
              to="/login"
              onClick={() => setMobileOpen(false)}
              className="block rounded-lg px-3 py-3 text-sm font-semibold text-stone-800 transition-colors hover:bg-cream"
            >
              {t('lp_cta_login')}
            </Link>
          </nav>
        )}
      </header>

      {/* ── Hero ────────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 -z-10"
          style={{
            background:
              'radial-gradient(60% 50% at 85% 0%, rgba(239,74,50,0.10), transparent 70%), radial-gradient(50% 40% at 0% 100%, rgba(239,74,50,0.07), transparent 70%)',
          }}
        />
        <div className="mx-auto grid max-w-6xl gap-12 px-5 py-16 lg:grid-cols-2 lg:items-center lg:py-24">
          {/* Left — copy */}
          <div>
            <Wordmark
              tm
              className="block animate-fade-up pt-6 text-6xl sm:text-7xl"
              style={{ animationDelay: '0ms' }}
            />

            <span
              className="mt-6 inline-flex animate-fade-up items-center gap-2 rounded-full bg-white px-3 py-1 text-xs font-semibold text-rk-700 shadow-soft ring-1 ring-sand"
              style={{ animationDelay: '80ms' }}
            >
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-rk-500" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-rk-600" />
              </span>
              {t('lp_eyebrow')}
            </span>

            <h1
              className="mt-4 animate-fade-up font-display text-3xl font-bold leading-tight tracking-tight text-stone-900 sm:text-4xl"
              style={{ animationDelay: '140ms' }}
            >
              {t('lp_headline_a')}{' '}
              <span className="text-rk-700">{t('lp_headline_b')}</span>
            </h1>

            <p
              className="mt-4 max-w-md animate-fade-up text-lg leading-relaxed text-stone-600"
              style={{ animationDelay: '200ms' }}
            >
              {t('lp_subhead')}
            </p>

            <div
              className="mt-8 flex animate-fade-up flex-wrap items-center gap-3"
              style={{ animationDelay: '240ms' }}
            >
              <Link
                to="/register"
                className="group inline-flex items-center gap-2 rounded-xl bg-rk-700 px-6 py-3.5 font-semibold text-white shadow-lift transition-all hover:-translate-y-0.5 hover:bg-rk-800"
              >
                {t('lp_cta_donor')}
                <ArrowIcon className="h-5 w-5 transition-transform group-hover:translate-x-0.5" />
              </Link>
              <Link
                to="/login"
                className="inline-flex items-center gap-2 rounded-xl bg-white px-6 py-3.5 font-semibold text-stone-700 shadow-soft ring-1 ring-sand transition-colors hover:text-rk-700"
              >
                {t('lp_cta_login')}
              </Link>
            </div>

            {/* Orientation link for first-time visitors — sits directly under
                the CTAs where a confused reader's eye lands. Visible on all
                screen sizes (mobile users don't scroll to the footer). */}
            <a
              href="/how-raktify-works.html"
              className="mt-5 inline-flex animate-fade-up items-center gap-2 text-sm font-semibold text-rk-700 underline-offset-4 hover:underline"
              style={{ animationDelay: '280ms' }}
            >
              <span aria-hidden="true">🗺️</span>
              {t('lp_hero_how')}
              <ArrowIcon className="h-4 w-4" />
            </a>

            <p
              className="mt-4 animate-fade-up text-sm text-stone-500"
              style={{ animationDelay: '320ms' }}
            >
              {t('lp_reassure')}
            </p>
          </div>

          {/* Right — product mock card */}
          <div className="animate-fade-in" style={{ animationDelay: '300ms' }}>
            <HeroCard t={t} />
          </div>
        </div>
      </section>

      {/* ── How it works ────────────────────────────────────────────────── */}
      <section className="border-t border-sand bg-white">
        <div className="mx-auto max-w-6xl px-5 py-16 lg:py-20">
          <div className="text-center">
            <h2 className="font-display text-3xl font-bold tracking-tight text-stone-900">
              {t('lp_how_title')}
            </h2>
            <p className="mx-auto mt-2 max-w-md text-stone-500">{t('lp_how_sub')}</p>
          </div>
          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {[
              { n: 1, Icon: UserPlusIcon, k: 'step1' },
              { n: 2, Icon: SendIcon, k: 'step2' },
              { n: 3, Icon: ShieldIcon, k: 'step3' },
            ].map((step, i) => (
              <article
                key={step.k}
                className="group relative animate-fade-up rounded-2xl bg-cream p-6 ring-1 ring-sand transition-all hover:-translate-y-1 hover:shadow-soft"
                style={{ animationDelay: `${i * 100}ms` }}
              >
                <div className="flex items-center justify-between">
                  <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-rk-700 text-white shadow-soft">
                    <step.Icon className="h-6 w-6" />
                  </span>
                  <span className="font-display text-5xl font-extrabold text-sand">
                    {step.n}
                  </span>
                </div>
                <h3 className="mt-4 text-lg font-bold text-stone-900">
                  {t(`lp_${step.k}_title`)}
                </h3>
                <p className="mt-1.5 text-sm leading-relaxed text-stone-600">
                  {t(`lp_${step.k}_body`)}
                </p>
              </article>
            ))}
          </div>
          {/* Deep-dive link for first-time visitors landing via search — the
              full story lives on a static page (/how-raktify-works.html) so
              it is crawlable + shareable + printable outside the SPA. */}
          <div className="mt-10 text-center">
            <a
              href="/how-raktify-works.html"
              className="inline-flex items-center gap-2 rounded-full border border-rk-200 bg-rk-50 px-6 py-3 text-sm font-semibold text-rk-700 transition-colors hover:border-rk-700 hover:bg-white"
            >
              <span aria-hidden="true">🗺️</span>
              {t('lp_how_full_link')}
              <span aria-hidden="true">→</span>
            </a>
          </div>
        </div>
      </section>

      {/* ── Trust band ──────────────────────────────────────────────────── */}
      <section className="bg-cream">
        <div className="mx-auto max-w-6xl px-5 py-16 lg:py-20">
          <h2 className="font-display text-3xl font-bold tracking-tight text-stone-900">
            {t('lp_trust_title')}
          </h2>
          <div className="mt-10 grid gap-6 md:grid-cols-3">
            {[
              { Icon: LockIcon, k: 'trust1' },
              { Icon: FlaskIcon, k: 'trust2' },
              { Icon: ShieldIcon, k: 'trust3' },
            ].map((row, i) => (
              <article
                key={row.k}
                className="animate-fade-up rounded-2xl bg-white p-6 shadow-soft ring-1 ring-sand"
                style={{ animationDelay: `${i * 100}ms` }}
              >
                <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-rk-50 text-rk-700 ring-1 ring-rk-100">
                  <row.Icon className="h-5 w-5" />
                </span>
                <h3 className="mt-4 font-bold text-stone-900">{t(`lp_${row.k}_title`)}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-stone-600">
                  {t(`lp_${row.k}_body`)}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── Final CTA ───────────────────────────────────────────────────── */}
      <section className="bg-white">
        <div className="mx-auto max-w-6xl px-5 pb-20">
          <div className="relative overflow-hidden rounded-3xl bg-rk-700 px-8 py-14 text-center shadow-lift">
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  'radial-gradient(40% 60% at 100% 0%, rgba(255,255,255,0.16), transparent 70%)',
              }}
            />
            <h2 className="relative font-display text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
              {t('lp_final_title')}
            </h2>
            <p className="relative mx-auto mt-3 max-w-md text-rk-100">
              {t('lp_final_body')}
            </p>
            <Link
              to="/register"
              className="relative mt-7 inline-flex items-center gap-2 rounded-xl bg-white px-7 py-3.5 font-semibold text-rk-700 shadow-lift transition-transform hover:-translate-y-0.5"
            >
              {t('lp_cta_donor')}
              <ArrowIcon className="h-5 w-5" />
            </Link>
            <p className="relative mt-5 text-sm text-rk-100">
              Hospital or blood bank?{' '}
              <Link
                to="/onboarding/apply"
                className="font-semibold text-white underline underline-offset-2 hover:text-rk-50"
              >
                Apply to join Raktify
              </Link>
              {' · '}
              Hosting a camp?{' '}
              <Link
                to="/camps/host"
                className="font-semibold text-white underline underline-offset-2 hover:text-rk-50"
              >
                Register your camp
              </Link>
            </p>
          </div>
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <Footer />
    </div>
  );
}

// ── Hero product mock — a stylised "live request matched" card ─────────────
function HeroCard({ t }) {
  return (
    <div className="relative mx-auto max-w-sm">
      {/* soft offset glow */}
      <div className="absolute -inset-3 -z-10 rounded-3xl bg-rk-100/60 blur-xl" />
      <div className="animate-float rounded-3xl bg-white p-5 shadow-lift ring-1 ring-sand">
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-stone-500">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-rk-500" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-rk-600" />
            </span>
            {t('lp_card_live')} · Pune
          </span>
          <span className="rounded-full bg-rk-700 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-white">
            {t('lp_card_critical')}
          </span>
        </div>

        <div className="mt-4 flex items-end gap-3">
          <span className="font-display text-5xl font-extrabold leading-none text-rk-700">
            O&minus;
          </span>
          <div className="pb-1">
            <div className="font-semibold text-stone-900">Whole blood</div>
            <div className="text-sm text-stone-500">2 units needed</div>
          </div>
        </div>

        <div className="mt-5 space-y-2">
          <div className="flex items-center gap-2.5 rounded-xl bg-green-50 px-3 py-2.5 ring-1 ring-green-100">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-green-600 text-white">
              <CheckIcon className="h-4 w-4" />
            </span>
            <div className="text-sm">
              <div className="font-semibold text-green-900">{t('lp_card_matched')}</div>
              <div className="text-xs text-green-700">Ruby Hall blood bank · 2.1 km</div>
            </div>
          </div>
          <div className="flex items-center gap-2.5 rounded-xl bg-cream px-3 py-2.5 ring-1 ring-sand">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-rk-700 text-white">
              <DropletIcon className="h-4 w-4" fill />
            </span>
            <div className="text-sm">
              <div className="font-semibold text-stone-900">{t('lp_card_alerted')}</div>
              <div className="text-xs text-stone-500">Coordinator: Asha P.</div>
            </div>
          </div>
        </div>

        <div className="mt-5 flex items-center justify-between border-t border-sand pt-3">
          <span className="text-xs text-stone-400">BC-2026-04812</span>
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-green-700">
            <CheckIcon className="h-3.5 w-3.5" />
            Matched in 11 min
          </span>
        </div>
      </div>
    </div>
  );
}
