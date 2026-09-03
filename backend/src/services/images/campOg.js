/**
 * Per-camp Open Graph card renderer (1200x630 PNG).
 *
 * WHY THIS EXISTS
 * ===============
 * frontend/index.html carries ONE static OG block hardcoded to the site root,
 * and WhatsApp's crawler does not execute JavaScript - so every camp link ever
 * shared previewed the same generic Raktify card. An organiser sharing "our
 * camp on the 14th" got a preview that said nothing about their camp. This
 * renders the card that link deserves.
 *
 * WHY THE BACKEND RENDERS IT AND NOT THE SWA FUNCTION
 * ==================================================
 * sharp, the committed fonts and the database all already live here. The SWA
 * managed function's only job is to inject the meta tags into index.html; it
 * points og:image at this route. Putting the renderer in the function would
 * mean a second sharp install on the SPA's deploy path, which is the one path
 * that must not become fragile.
 *
 * THE WORDMARK IS READ FROM THE CANONICAL VECTOR AT RUNTIME
 * ========================================================
 * frontend/public/wordmark-tm.svg, inlined verbatim into the card SVG. Not
 * re-typed as text (the locked design rule - a text approximation drifts with
 * whatever font the renderer has, which is the reason the vector exists), and
 * not copied into backend/assets either: a copy is a thing that silently
 * diverges from the mark. This works because the API deploy artifact is the
 * WHOLE repo (main_raktify-api.yml uploads `path: .`), so the frontend tree is
 * present on App Service. If that ever changes, this returns null and the
 * route serves the generic og-image.png - degraded, never wrong-branded.
 *
 * EVERY TEXT RUN GOES THROUGH PANGO, NOT SVG <text>
 * =================================================
 * A camp name can be Marathi, and it needs real shaping (conjuncts, matras)
 * plus word wrapping - neither of which SVG <text> gives you. services/images/
 * fonts.js owns the font reachability and its own differential self-check;
 * this file asks it whether Devanagari is safe and returns null if it is not,
 * because a card full of tofu boxes is worse than the generic card. Same
 * reasoning as the logo path's canvasIsBlank(): detect, do not hope.
 *
 * ⚠ A WINDOWS DEV BOX WILL REFUSE MARATHI CARDS, BY DESIGN. That is not a bug
 * to fix - pango ignores fontconfig on Windows, so the shipped Noto provably
 * is not what rendered anything, and this code declines to pretend otherwise.
 * Latin cards render locally and look correct.
 */
const fs = require('fs');
const path = require('path');

const logger = require('../../config/logger');
const fonts = require('./fonts');

const WIDTH = 1200;
const HEIGHT = 630;

// Design-system tokens. Pulled from frontend/tailwind.config.js +
// frontend/public/og-image.svg - never invent a value here (locked system).
const CREAM = '#fdf8f4';
const SAND = '#f5ece4';
const BRAND = '#b8231a';
const BRAND_LIGHT = '#ef4a32';
const INK = '#1c1917';
const INK_2 = '#44403c';
const INK_3 = '#78716c';

// Layout. The right column exists only when there is an approved logo.
const PAD_X = 64;
const LOGO_BOX = 200;
const LOGO_LEFT = WIDTH - PAD_X - LOGO_BOX;
const LOGO_TOP = 168;
const TEXT_TOP = 150;
const TEXT_BOTTOM = 512; // above the footer rule
const RULE_Y = 540;

const WORDMARK_PATH = path.join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'frontend',
  'public',
  'wordmark-tm.svg',
);

// The site-wide card, served verbatim whenever renderCampOgCard() declines.
// Same tree as the wordmark, same reasoning: the API deploy artifact is the
// whole repo, so the one file the SPA already ships is the one served here - a
// backend copy would be a second thing to keep in step with the brand.
const GENERIC_CARD_PATH = path.join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'frontend',
  'public',
  'og-image.png',
);

let genericCard; // undefined = not tried yet, null = unavailable

/**
 * The generic OG image as a Buffer, read once. null if it is not there.
 *
 * Lives here rather than in the route because this file already owns the
 * "reach into frontend/public" knowledge, and it keeps fs/path out of the
 * router entirely.
 */
function readGenericCard() {
  if (genericCard !== undefined) return genericCard;
  try {
    genericCard = fs.readFileSync(GENERIC_CARD_PATH);
  } catch (err) {
    logger.error(
      { err: err.message, path: GENERIC_CARD_PATH },
      'og_generic_card_unavailable - camp links with no renderable card will 404',
    );
    genericCard = null;
  }
  return genericCard;
}

// The wordmark's own viewBox, from wordmark-tm.svg. Aspect 1185:378 = 3.135:1,
// so the mark is sized by HEIGHT and the width derives - the locked rule.
const WM_VB = { x: 57, y: 107, w: 1185, h: 378 };
const WM_HEIGHT = 46;
const WM_TOP = 52;

let wordmarkInner; // undefined = not tried yet, null = unavailable

/**
 * The wordmark's paths, verbatim, ready to drop inside a <g>. Read once and
 * cached; a missing file is logged loudly and makes the whole card decline.
 */
function loadWordmarkInner() {
  if (wordmarkInner !== undefined) return wordmarkInner;
  try {
    const svg = fs.readFileSync(WORDMARK_PATH, 'utf8');
    const open = svg.indexOf('>', svg.indexOf('<svg'));
    const close = svg.lastIndexOf('</svg>');
    if (open === -1 || close === -1 || close <= open) throw new Error('unparseable_wordmark');
    wordmarkInner = svg.slice(open + 1, close).trim();
  } catch (err) {
    logger.error(
      { err: err.message, path: WORDMARK_PATH },
      'og_wordmark_unavailable - per-camp OG cards will fall back to the generic image',
    );
    wordmarkInner = null;
  }
  return wordmarkInner;
}

/** Place the wordmark: map its viewBox origin to (x, y) at `height` px tall. */
function wordmarkGroup(x, y, height) {
  const inner = loadWordmarkInner();
  if (!inner) return null;
  const s = height / WM_VB.h;
  const tx = x - WM_VB.x * s;
  const ty = y - WM_VB.y * s;
  return `<g transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${s.toFixed(6)})">${inner}</g>`;
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
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * "Saturday, 14 March 2026" from a 'YYYY-MM-DD' calendar label.
 *
 * English month names on purpose, even for a Marathi camp name: the Marathi
 * month arrays live in the frontend i18n packs (deliberately hardcoded there
 * because Intl's Marathi data is not reliably present), and duplicating them
 * server-side would give two places for the same month to disagree. Latin
 * digits in every language is already the house rule.
 *
 * Parsed by hand rather than through `new Date()` - a camp date is a calendar
 * label, not an instant, and `new Date('2026-03-14')` is UTC midnight, which
 * is the previous day in some renderings.
 */
function formatCampDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
  if (!m) return null;
  const [, y, mo, d] = m;
  const day = new Date(Date.UTC(+y, +mo - 1, +d)).getUTCDay();
  return `${WEEKDAYS[day]}, ${+d} ${MONTHS[+mo - 1]} ${y}`;
}

/** '09:00:00' -> '9:00 AM'. Returns null for anything unparseable. */
function formatTime(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
  if (!m) return null;
  let h = +m[1];
  const suffix = h < 12 ? 'AM' : 'PM';
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return `${h}:${m[2]} ${suffix}`;
}

/**
 * Render a text run, shrinking the font until it fits `maxHeight`, then
 * truncating as a last resort. Returns null if it cannot be rendered at all.
 *
 * Shrink-then-truncate rather than truncate-only because a long camp name is
 * normal ("Shri Shivaji Mahavidyalaya NSS Unit Blood Donation Camp") and
 * clipping it loses the identifying words at the end.
 */
async function fitText(sharp, { text, family, weight, sizes, colour, width, maxHeight, spacing }) {
  const clean = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return null;

  for (const size of sizes) {
    const markup = `<span font_desc="${family} ${weight} ${size}" foreground="${colour}">${fonts.escapeMarkup(clean)}</span>`;
    const out = await fonts.renderText(sharp, { markup, width, spacing });
    if (!out) return null;
    if (out.height <= maxHeight) return out;
  }

  // Smallest size still overflows: truncate on a word boundary and accept it.
  const size = sizes[sizes.length - 1];
  let body = clean;
  for (let guard = 0; guard < 40 && body.length > 12; guard += 1) {
    body = body.slice(0, body.lastIndexOf(' ', body.length - 2) + 1 || body.length - 8).trim();
    const markup = `<span font_desc="${family} ${weight} ${size}" foreground="${colour}">${fonts.escapeMarkup(body)}…</span>`;
    const out = await fonts.renderText(sharp, { markup, width, spacing });
    if (out && out.height <= maxHeight) return out;
  }
  return null;
}

/** The approved organiser logo, contained in a LOGO_BOX square, alpha kept. */
async function renderLogo(sharp, dataUri) {
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUri || ''));
  if (!m) return null;
  try {
    return await sharp(Buffer.from(m[2], 'base64'), { limitInputPixels: 50e6 })
      .resize(LOGO_BOX, LOGO_BOX, {
        fit: 'contain',
        // Transparent, never white: the card ground is cream #fdf8f4, so a
        // white plate behind a transparent logo would read as a grey box.
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
  } catch (err) {
    // A stored logo that will not decode must not lose the whole card - the
    // camp name is the point, the logo is the garnish.
    logger.warn({ err: err.message }, 'og_camp_logo_undecodable');
    return null;
  }
}

/**
 * Render the card. Returns a PNG Buffer, or null when the caller should serve
 * the generic og-image.png instead.
 *
 * `camp` is the GET /camps/public/:slug shape - which already applies the SQL
 * approval gate, so a logo/tagline present here is one an NGO admin approved.
 */
async function renderCampOgCard(sharp, camp) {
  const name = String(camp?.name || '').trim();
  if (!name) return null;

  // Any Devanagari anywhere on the card needs the shipped Noto to be genuinely
  // reachable. If it is not, decline the whole card rather than ship boxes.
  const needsDevanagari = [name, camp.venue, camp.organiser_name, camp.organiser_tagline].some(
    (v) => fonts.hasDevanagari(v),
  );
  if (needsDevanagari && !(await fonts.devanagariReachable(sharp))) {
    logger.warn({ slug: camp.slug }, 'og_camp_card_declined_devanagari_unreachable');
    return null;
  }

  const wordmark = wordmarkGroup(PAD_X, WM_TOP, WM_HEIGHT);
  if (!wordmark) return null;

  const logo = camp.logo_data_uri ? await renderLogo(sharp, camp.logo_data_uri) : null;
  const textWidth = (logo ? LOGO_LEFT - 40 : WIDTH - PAD_X) - PAD_X;

  // --- the runs, top to bottom -------------------------------------------
  const dateLabel = formatCampDate(camp.scheduled_date);
  const start = formatTime(camp.start_time);
  const end = formatTime(camp.end_time);
  const when = [dateLabel, start ? (end ? `${start} – ${end}` : start) : null]
    .filter(Boolean)
    .join('  ·  ');

  const place = [camp.venue, camp.district_name].filter(Boolean).join(', ');
  const host = camp.organiser_name ? `Hosted by ${camp.organiser_name}` : null;

  const [whenRun, nameRun, placeRun, hostRun] = await Promise.all([
    when
      ? fitText(sharp, {
          text: when,
          family: fonts.FAMILY_LATIN,
          weight: 'Bold',
          sizes: [31, 28, 25],
          colour: BRAND,
          width: textWidth,
          maxHeight: 84,
        })
      : null,
    fitText(sharp, {
      text: name,
      family: fonts.FAMILY_LATIN,
      weight: 'ExtraBold',
      sizes: [66, 58, 50, 44, 38],
      colour: INK,
      width: textWidth,
      maxHeight: 176,
    }),
    place
      ? fitText(sharp, {
          text: place,
          family: fonts.FAMILY_LATIN,
          weight: 'SemiBold',
          sizes: [31, 28, 25],
          colour: INK_2,
          width: textWidth,
          maxHeight: 84,
        })
      : null,
    host
      ? fitText(sharp, {
          text: host,
          family: fonts.FAMILY_LATIN,
          weight: 'Regular',
          sizes: [26, 23],
          colour: INK_3,
          width: textWidth,
          maxHeight: 40,
        })
      : null,
  ]);

  if (!nameRun) return null;

  // Stack with the cursor, dropping the least important run if we run out of
  // vertical room. Order of sacrifice: host, then place.
  const GAPS = { afterWhen: 16, afterName: 20, afterPlace: 14 };
  const runs = [];
  let y = TEXT_TOP;
  if (whenRun) {
    runs.push({ input: whenRun.buffer, left: PAD_X, top: y });
    y += whenRun.height + GAPS.afterWhen;
  }
  runs.push({ input: nameRun.buffer, left: PAD_X, top: y });
  y += nameRun.height + GAPS.afterName;
  if (placeRun && y + placeRun.height <= TEXT_BOTTOM) {
    runs.push({ input: placeRun.buffer, left: PAD_X, top: y });
    y += placeRun.height + GAPS.afterPlace;
  }
  if (hostRun && y + hostRun.height <= TEXT_BOTTOM) {
    runs.push({ input: hostRun.buffer, left: PAD_X, top: y });
  }

  // --- the footer -------------------------------------------------------
  // Deliberately not a promise about eligibility or a medical claim - just
  // where to go. "Register free" is true: there is no fee anywhere.
  const footer = await fitText(sharp, {
    text: 'Register free · raktify.choudhari.ngo',
    family: fonts.FAMILY_LATIN,
    weight: 'SemiBold',
    sizes: [25],
    colour: BRAND,
    width: 700,
    maxHeight: 40,
  });
  if (footer) runs.push({ input: footer.buffer, left: PAD_X, top: RULE_Y + 22 });

  if (logo) runs.push({ input: logo, left: LOGO_LEFT, top: LOGO_TOP });

  // --- chrome, as one SVG (no <text>, so no font dependency at all) -----
  const chrome = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="band" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${BRAND}"/>
      <stop offset="100%" stop-color="${BRAND_LIGHT}"/>
    </linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${CREAM}"/>
  <rect x="0" y="0" width="${WIDTH}" height="10" fill="url(#band)"/>
  ${wordmark}
  <rect x="${PAD_X}" y="${RULE_Y}" width="${WIDTH - PAD_X * 2}" height="2" fill="${SAND}"/>
</svg>`;

  return sharp(Buffer.from(chrome), { density: 72 })
    .composite(runs)
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

module.exports = {
  renderCampOgCard,
  readGenericCard,
  WIDTH,
  HEIGHT,
  formatCampDate,
  formatTime,
};
