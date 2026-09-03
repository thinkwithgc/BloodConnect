'use strict';

/**
 * Per-camp Open Graph tags for /c/<slug> share links.
 *
 * WHY A FUNCTION AT ALL
 * =====================
 * frontend/index.html carries ONE static OG block hardcoded to the site root,
 * and WhatsApp's crawler does not execute JavaScript - so an SPA can only ever
 * preview that one generic card, whatever /c/<slug> renders in a browser. The
 * markup, the routing and the image were all verified fine in prod; the gap is
 * structural. The only fix is a server-rendered <head> for that one path.
 *
 * WHY IT LIVES AT THE EXISTING ORIGIN AND NOT A SUBDOMAIN
 * ======================================================
 * https://raktify.choudhari.ngo/c/{{1}} is baked into NINE APPROVED Meta
 * template buttons. Moving the share URL would drop all nine to PENDING for
 * 1-3 days x 3 languages (or need nine _v3 names) and would orphan the printed
 * 130mm QR posters. So the preview has to be served where the link already
 * points, which forces a Static Web Apps MANAGED function: SWA `rewrite`
 * cannot target an external absolute URL, and route rules cannot match a user
 * agent. A *linked* backend would need Standard tier (~$9/mo) and still mounts
 * under /api.
 *
 * ZERO DEPENDENCIES, ON PURPOSE
 * =============================
 * Setting `api_location` puts the SPA's only deploy path behind this folder
 * building. Node 20 has global fetch, so there is nothing to install and
 * nothing to go stale. Do not add a dependency here without a very good reason.
 *
 * IT SERVES *ALL* /c/* TRAFFIC, NOT JUST CRAWLERS
 * ===============================================
 * Route rules cannot match a user agent, so every human visit comes through
 * here too. That is why the failure mode everywhere below is "return
 * index.html untouched": a crawler then gets the generic card (degraded, never
 * broken) and a human gets the normal SPA, which is exactly what /c/<slug> did
 * before this function existed. The only 502 is when the shell itself is
 * unreachable, and even that carries a readable page rather than a blank one.
 *
 * WHATSAPP CACHES A PREVIEW PER EXACT URL, FAILURES INCLUDED, FOR DAYS.
 * When testing, add a throwaway ?v=2 - re-sharing the same URL will show you a
 * stale card and tell you nothing about the change you just deployed.
 */

// Hardcoded with an env override, deliberately: an appsetting somebody must
// remember to add is a deploy step that can be forgotten, and the symptom is a
// silently generic preview. The SPA's own workflow hardcodes VITE_API_URL for
// the same reason.
const API_BASE = (process.env.RAKTIFY_API_BASE || 'https://raktify-api.azurewebsites.net').replace(
  /\/+$/,
  '',
);

const SHELL_TTL_MS = 5 * 60 * 1000;
const CAMP_TTL_MS = 60 * 1000;
const SHELL_TIMEOUT_MS = 3000;
const CAMP_TIMEOUT_MS = 2500;
const CACHE_MAX = 50;

// The slug column's own shape. Anything else is not looked up at all - the SPA
// still renders, it just gets the generic card.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/i;

const NAME_MAX = 90;
const DESC_MAX = 200;

// Module scope survives between invocations on a warm host, which is the whole
// point: a shared camp link is crawled repeatedly within seconds.
const shellCache = new Map(); // origin -> { value, at }
const campCache = new Map(); // slug   -> { value, at }

function cacheGet(map, key, ttl) {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttl) return null;
  return hit.value;
}

function cachePut(map, key, value) {
  map.delete(key);
  map.set(key, { value, at: Date.now() });
  // Map iterates in insertion order, so the first key is the oldest.
  while (map.size > CACHE_MAX) map.delete(map.keys().next().value);
}

async function fetchWithTimeout(url, ms, headers) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { signal: ac.signal, headers, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The SPA's own index.html.
 *
 * Fetched over HTTP because a managed function cannot read the static content
 * it sits beside. The origin comes from the request, not a constant, so PR
 * preview environments work unchanged. There is no recursion risk: /index.html
 * has a headers-only route rule in staticwebapp.config.json, so it is served
 * as a file and never routed back here.
 *
 * A stale entry beats nothing, so a failed refetch falls back to whatever this
 * origin last returned - the shell only changes on deploy. Keyed by origin
 * rather than held in one variable precisely so a PR preview host can never be
 * served prod's shell.
 */
async function getShell(origin, context) {
  const fresh = cacheGet(shellCache, origin, SHELL_TTL_MS);
  if (fresh) return fresh;
  try {
    const r = await fetchWithTimeout(origin + '/index.html', SHELL_TIMEOUT_MS, {
      accept: 'text/html',
    });
    if (!r.ok) throw new Error('shell_status_' + r.status);
    const html = await r.text();
    if (!/<head[\s>]/i.test(html)) throw new Error('shell_has_no_head');
    cachePut(shellCache, origin, html);
    return html;
  } catch (err) {
    const stale = shellCache.get(origin);
    context.log.warn(
      'camp_og_shell_fetch_failed',
      origin,
      err.message,
      stale ? 'served_stale' : 'no_stale_copy',
    );
    return stale ? stale.value : null;
  }
}

/** The public camp payload, or null for "no card" (missing, unpublished, down). */
async function getCamp(slug, context) {
  const fresh = cacheGet(campCache, slug, CAMP_TTL_MS);
  if (fresh) return fresh;
  try {
    const r = await fetchWithTimeout(
      API_BASE + '/camps/public/' + encodeURIComponent(slug),
      CAMP_TIMEOUT_MS,
      { accept: 'application/json' },
    );
    // 404 is the normal answer for an unknown slug or a camp that is not PL/LV.
    // Not an error, and not worth a log line - people mistype shared links.
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('camp_status_' + r.status);
    const camp = await r.json();
    if (!camp || !camp.name) return null;
    cachePut(campCache, slug, camp);
    return camp;
  } catch (err) {
    context.log.warn('camp_og_camp_fetch_failed', slug, err.message);
    return null;
  }
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * '14 March 2026' from either a 'YYYY-MM-DD' label or an ISO instant.
 *
 * GET /camps/public/:slug selects scheduled_date RAW, so a pg DATE arrives here
 * JSON-serialised as '2026-03-14T00:00:00.000Z'. The anchored regex reads the
 * first ten characters of either shape and never constructs a Date, because a
 * camp date is a calendar label and new Date('2026-03-14') is UTC midnight -
 * the previous day in some renderings.
 */
function formatCampDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!m) return null;
  return Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1] + ' ' + m[1];
}

/** '09:00:00' -> '9:00 AM'. */
function formatTime(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
  if (!m) return null;
  let h = Number(m[1]);
  const suffix = h < 12 ? 'AM' : 'PM';
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return h + ':' + m[2] + ' ' + suffix;
}

/** For an HTML attribute value. Camp text is organiser-supplied. */
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function clamp(s, max) {
  const clean = String(s || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trim() + '…';
}

// Every single-value property this function replaces. Stripping first and
// inserting after <head> are two independent safeguards: crawlers take the
// FIRST occurrence of a single-value OG property, so inserting at the top
// already wins, and stripping means there is no second value to argue about.
//
// Each entry becomes /<meta[^>]*\sATTR="VALUE"[^>]*>/gi. Three details are
// load-bearing:
//   - [^>] matches newlines, so this covers Prettier's multi-line meta tags in
//     index.html without a second pattern.
//   - the closing quote is inside the pattern, so "og:image" cannot also eat
//     "og:image:width".
//   - the leading \s before the attribute name is what stops name="description"
//     from matching property="og:description".
// Requiring the <meta prefix is what keeps the JSON-LD block's own
// "description" key out of range - never match a loose `description`.
const STRIP = [
  ['name', 'description'],
  ['property', 'og:url'],
  ['property', 'og:title'],
  ['property', 'og:description'],
  ['property', 'og:image'],
  ['property', 'og:image:width'],
  ['property', 'og:image:height'],
  ['property', 'og:image:type'],
  ['property', 'og:image:alt'],
  ['name', 'twitter:title'],
  ['name', 'twitter:description'],
  ['name', 'twitter:image'],
  ['name', 'twitter:image:alt'],
];

function stripOverridden(html) {
  let out = html;
  for (const pair of STRIP) {
    const re = new RegExp('<meta[^>]*\\s' + pair[0] + '="' + pair[1] + '"[^>]*>', 'gi');
    out = out.replace(re, '');
  }
  out = out.replace(/<title>[\s\S]*?<\/title>/i, '');
  out = out.replace(/<link[^>]*\srel="canonical"[^>]*>/i, '');
  return out;
}

/**
 * Deliberately left alone: og:type, og:site_name, og:locale + alternates,
 * twitter:card, keywords, author and the JSON-LD Organization block. They are
 * true of every page, and a per-camp value would be no better.
 */
function buildHead(camp, slug, origin) {
  const name = clamp(camp.name, NAME_MAX);
  const bits = [
    formatCampDate(camp.scheduled_date),
    formatTime(camp.start_time),
    [camp.venue, camp.district_name].filter(Boolean).join(', '),
  ].filter(Boolean);
  // No medical claims and no emoji - this is the line a whole WhatsApp group
  // reads. "Register free" is true: there is no fee anywhere on the platform.
  const description = clamp(
    (bits.length ? bits.join(' · ') + '. ' : 'Blood donation camp. ') +
      'Register free on Raktify.',
    DESC_MAX,
  );
  const title = name + ' — Blood Donation Camp | Raktify';
  const url = origin + '/c/' + slug;
  // Absolute and cross-host on purpose: the card is rendered by the API, and an
  // absolute og:image is exactly what a crawler wants.
  const image = API_BASE + '/camps/public/' + encodeURIComponent(slug) + '/og.png';

  return [
    '',
    '    <!-- per-camp preview, injected by frontend/api/camp-og -->',
    '    <title>' + esc(title) + '</title>',
    '    <link rel="canonical" href="' + esc(url) + '" />',
    '    <meta name="description" content="' + esc(description) + '" />',
    '    <meta property="og:url" content="' + esc(url) + '" />',
    '    <meta property="og:title" content="' + esc(name) + '" />',
    '    <meta property="og:description" content="' + esc(description) + '" />',
    '    <meta property="og:image" content="' + esc(image) + '" />',
    '    <meta property="og:image:width" content="1200" />',
    '    <meta property="og:image:height" content="630" />',
    // The card is always a PNG - services/images/campOg.js encodes one and
    // the generic fallback on disk is one too. Declaring the type saves a
    // crawler a sniff and is one of the hints a stricter unfurler wants
    // before it will render the image at all.
    '    <meta property="og:image:type" content="image/png" />',
    '    <meta property="og:image:alt" content="' + esc(name) + '" />',
    '    <meta name="twitter:title" content="' + esc(name) + '" />',
    '    <meta name="twitter:description" content="' + esc(description) + '" />',
    '    <meta name="twitter:image" content="' + esc(image) + '" />',
    '    <meta name="twitter:image:alt" content="' + esc(name) + '" />',
    '',
  ].join('\n');
}

function inject(html, block) {
  // Immediately after the <head> open tag, so our values are the first ones a
  // crawler sees.
  return html.replace(/<head[^>]*>/i, function (tag) {
    return tag + block;
  });
}

// Not a blank page, and deliberately NOT the wordmark re-typed as styled text
// (locked design rule - the mark is always the vector, and no vector is
// available in this function). Plain prose only.
const SHELL_UNAVAILABLE = [
  '<!doctype html><html lang="en"><head><meta charset="utf-8" />',
  '<meta name="viewport" content="width=device-width, initial-scale=1" />',
  '<meta name="robots" content="noindex" />',
  '<title>Raktify</title></head>',
  '<body style="margin:0;padding:48px 24px;background:#fdf8f4;color:#1c1917;',
  'font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;text-align:center">',
  '<p style="font-size:18px;margin:0 0 12px">This page could not be loaded just now.</p>',
  '<p style="font-size:15px;color:#78716c;margin:0 0 24px">Please try again in a moment.</p>',
  '<p><a href="/" style="color:#b8231a">Go to the home page</a></p>',
  '</body></html>',
].join('');

module.exports = async function (context, req) {
  const headers = (req && req.headers) || {};

  // x-ms-original-url is the only place the pre-rewrite URL survives, and it
  // carries the origin as well as the path - which is why it is preferred over
  // the host header (inside the Functions host, `host` is not the public name).
  let origin = null;
  let slug = null;
  try {
    const u = new URL(headers['x-ms-original-url'] || '');
    origin = u.origin;
    // Matched on the RAW pathname: slugs are lowercase alnum + hyphen, so they
    // need no decoding, and decodeURIComponent on a whole path can throw.
    const m = /^\/c\/([^/]+)\/?$/.exec(u.pathname);
    if (m) slug = m[1];
  } catch (err) {
    // header absent or unparseable - fall through to the header-derived origin
  }
  if (!origin) {
    const host = headers['x-forwarded-host'] || headers.host;
    if (host) origin = 'https://' + host;
  }

  const send = function (body, maxAge, status) {
    context.res = {
      status: status || 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=' + maxAge,
        'x-content-type-options': 'nosniff',
      },
      body: body,
    };
  };

  if (!origin) {
    context.log.error('camp_og_no_origin - neither x-ms-original-url nor a host header');
    return send(SHELL_UNAVAILABLE, 0, 502);
  }

  const shell = await getShell(origin, context);
  if (!shell) return send(SHELL_UNAVAILABLE, 0, 502);

  if (!slug || !SLUG_RE.test(slug)) return send(shell, 60);

  const camp = await getCamp(slug, context);
  if (!camp) return send(shell, 60);

  try {
    return send(inject(stripOverridden(shell), buildHead(camp, slug, origin)), 300);
  } catch (err) {
    context.log.error('camp_og_inject_failed', slug, err.message);
    return send(shell, 60);
  }
};
