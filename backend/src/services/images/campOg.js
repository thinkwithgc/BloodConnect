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

// Layout.
//
// Two columns: the text stack on the left and - only when there is an approved
// logo - a sand plate on the right for the logo to sit on. Without the plate a
// small transparent PNG floats on the cream ground looking like it landed there
// by accident, which is exactly how the first cut read.
const PAD_X = 64;
const LOGO_BOX = 200;
const PLATE = LOGO_BOX + 48; // a 24px inset all round
const PLATE_LEFT = WIDTH - PAD_X - PLATE;

// The band the whole text stack is CENTRED in. The first cut top-anchored the
// stack at y=150, so a one-line camp name left the lower-middle sixth of the
// card completely empty - the defect reported as "lot of blank space". Centred,
// a one-line name and a three-line name both look composed.
const CONTENT_TOP = 128;
const CONTENT_BOTTOM = 498;
const BAND_H = CONTENT_BOTTOM - CONTENT_TOP;

const PLATE_TOP = Math.round((CONTENT_TOP + CONTENT_BOTTOM - PLATE) / 2);
const LOGO_LEFT = PLATE_LEFT + (PLATE - LOGO_BOX) / 2;
const LOGO_TOP = PLATE_TOP + (PLATE - LOGO_BOX) / 2;

// The footer is a sand BAND, not a 2px rule with one line of text under it: a
// band reads as a designed edge, a hairline reads as the card running out.
const FOOTER_TOP = 522;
const FOOTER_H = HEIGHT - FOOTER_TOP;

// The date rides in a brand-filled pill. These are the paddings only - the box
// is sized from the MEASURED text run, which is why the chrome SVG can only be
// assembled after the runs have been rendered.
const PILL_PAD_X = 26;
const PILL_PAD_Y = 12;

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

  // A Devanagari name with no reachable Noto font renders as tofu boxes. A
  // generic card is degraded; a card full of empty rectangles is broken.
  const needsDevanagari = [name, camp.venue, camp.organiser_name, camp.district_name].some((s) =>
    fonts.hasDevanagari(s),
  );
  if (needsDevanagari && !(await fonts.devanagariReachable(sharp))) {
    logger.warn({ slug: camp.slug }, 'og_camp_card_declined_devanagari_unreachable');
    return null;
  }

  const wordmark = wordmarkGroup(PAD_X, WM_TOP, WM_HEIGHT);
  if (!wordmark) return null;

  const logo = camp.logo_data_uri ? await renderLogo(sharp, camp.logo_data_uri) : null;
  const textWidth = (logo ? PLATE_LEFT - 40 : WIDTH - PAD_X) - PAD_X;

  const dateLabel = formatCampDate(camp.scheduled_date);
  const start = formatTime(camp.start_time);
  const end = formatTime(camp.end_time);
  const hours = start ? (end ? `${start} - ${end}` : start) : null;

  // The pill carries the DATE only. The hours ride with the venue on the line
  // below so the pill stays short enough to read as a badge rather than as a
  // sentence somebody drew a box around.
  const place = [hours, camp.venue, camp.district_name].filter(Boolean).join('  ·  ');
  const host = camp.organiser_name ? `Hosted by ${camp.organiser_name}` : null;

  const [dateRun, nameRun, placeRun, hostRun, footLeft, footRight] = await Promise.all([
    dateLabel
      ? fitText(sharp, {
          text: dateLabel,
          family: fonts.FAMILY_LATIN,
          weight: 'Bold',
          sizes: [28, 25, 22],
          colour: CREAM, // on the brand pill, not on the cream ground
          width: textWidth - PILL_PAD_X * 2,
          maxHeight: 46,
        })
      : null,
    fitText(sharp, {
      text: name,
      family: fonts.FAMILY_LATIN,
      weight: 'ExtraBold',
      sizes: [64, 56, 48, 42, 36],
      colour: INK,
      width: textWidth,
      maxHeight: 172,
      spacing: -1024,
    }),
    place
      ? fitText(sharp, {
          text: place,
          family: fonts.FAMILY_LATIN,
          weight: 'SemiBold',
          sizes: [29, 26, 23],
          colour: INK_2,
          width: textWidth,
          maxHeight: 78,
        })
      : null,
    host
      ? fitText(sharp, {
          text: host,
          family: fonts.FAMILY_LATIN,
          weight: 'Regular',
          sizes: [25, 22],
          colour: INK_3,
          width: textWidth,
          maxHeight: 38,
        })
      : null,
    // Deliberately not a promise about eligibility or a medical claim - just
    // what this is and where to go. "Free registration" is true: no fee anywhere.
    fitText(sharp, {
      text: 'Blood donation camp  ·  Free registration',
      family: fonts.FAMILY_LATIN,
      weight: 'SemiBold',
      sizes: [22],
      colour: INK_2,
      width: 640,
      maxHeight: 34,
    }),
    fitText(sharp, {
      text: 'raktify.choudhari.ngo',
      family: fonts.FAMILY_LATIN,
      weight: 'Bold',
      sizes: [24],
      colour: BRAND,
      width: 420,
      maxHeight: 34,
    }),
  ]);

  if (!nameRun) return null;

  const pillH = dateRun ? dateRun.height + PILL_PAD_Y * 2 : 0;
  const pillW = dateRun ? dateRun.width + PILL_PAD_X * 2 : 0;

  // MEASURE the whole stack before placing any of it - centring is impossible
  // from a running cursor, which is what the first cut used.
  const items = [];
  if (dateRun) items.push({ pill: true, h: pillH, gap: 24 });
  items.push({ run: nameRun, h: nameRun.height, gap: 18 });
  if (placeRun) items.push({ run: placeRun, h: placeRun.height, gap: 12 });
  if (hostRun) items.push({ run: hostRun, h: hostRun.height, gap: 0 });

  const stackHeight = () =>
    items.reduce((acc, it, i) => acc + it.h + (i < items.length - 1 ? it.gap : 0), 0);
  // Sacrifice from the BOTTOM - host first, then venue - rather than let the
  // stack collide with the footer band. The camp name never goes.
  while (items.length > 1 && stackHeight() > BAND_H) items.pop();

  const runs = [];
  let pill = '';
  let y = CONTENT_TOP + Math.max(0, Math.round((BAND_H - stackHeight()) / 2));
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    if (it.pill) {
      pill =
        `<rect x="${PAD_X}" y="${y}" width="${pillW}" height="${pillH}" ` +
        `rx="${Math.round(pillH / 2)}" fill="${BRAND}"/>`;
      runs.push({ input: dateRun.buffer, left: PAD_X + PILL_PAD_X, top: y + PILL_PAD_Y });
    } else {
      runs.push({ input: it.run.buffer, left: PAD_X, top: y });
    }
    y += it.h + it.gap;
  }

  if (footLeft) {
    runs.push({
      input: footLeft.buffer,
      left: PAD_X,
      top: FOOTER_TOP + Math.round((FOOTER_H - footLeft.height) / 2),
    });
  }
  if (footRight) {
    // Right-aligned by measurement, not by a guessed x.
    runs.push({
      input: footRight.buffer,
      left: WIDTH - PAD_X - footRight.width,
      top: FOOTER_TOP + Math.round((FOOTER_H - footRight.height) / 2),
    });
  }
  if (logo) runs.push({ input: logo, left: LOGO_LEFT, top: LOGO_TOP });

  // The chrome carries no <text> at all, so it has no font dependency - every
  // glyph on this card comes from a measured pango run composited over it.
  const plate = logo
    ? `<rect x="${PLATE_LEFT}" y="${PLATE_TOP}" width="${PLATE}" height="${PLATE}" rx="28" fill="${SAND}"/>`
    : '';

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
    ${plate}
    ${pill}
    <rect x="0" y="${FOOTER_TOP}" width="${WIDTH}" height="${FOOTER_H}" fill="${SAND}"/>
    <rect x="0" y="${FOOTER_TOP}" width="${WIDTH}" height="3" fill="url(#band)"/>
  </svg>`;

  // FLATTEN - and do it through an explicit raw intermediate.
  //
  // WHY OPAQUE: a 32-bit og:image is a link-preview hazard. The crawler
  // composites the alpha against a ground we do not control, and some clients
  // decline an RGBA preview outright - which is the one property the camp card
  // and the site-root card shared while neither previewed. Nothing is lost:
  // the card's own ground is a full-bleed opaque cream rect.
  //
  // WHY RAW: sharp does not guarantee the order of flatten relative to
  // composite, so a chained .flatten() can be applied to the BASE before the
  // runs land on it - leaving the logo's own transparency in the output. One
  // deterministic encode from raw pixels cannot get that wrong.
  const { data, info } = await sharp(Buffer.from(chrome), { density: 72 })
    .composite(runs)
    .raw()
    .toBuffer({ resolveWithObject: true });

  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: info.channels },
  })
    .flatten({ background: CREAM })
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
