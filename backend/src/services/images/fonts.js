/**
 * Font plumbing for server-side image rendering (per-camp OG cards).
 *
 * WHY THIS FILE IS SEPARATE FROM THE RENDERER
 * ===========================================
 * sharp draws text through libvips -> pango -> fontconfig, and fontconfig
 * answers from the HOST's font set. Azure App Service Linux ships neither
 * Inter nor Noto Sans Devanagari, so a Marathi camp name renders as tofu boxes
 * there while looking perfect on a Windows dev box. Getting the fonts reachable
 * is therefore a deployment concern with its own failure mode, not an
 * implementation detail of one card layout - and it needs its own self-check,
 * because the failure is silent.
 *
 * FONTCONFIG_PATH IS SET FROM CODE, ON PURPOSE
 * ============================================
 * It could equally be an App Service appsetting. It is not, because then dev
 * and prod would differ by one `az` command somebody has to remember on a
 * deploy that otherwise needs none, and the symptom of forgetting is boxes in
 * a WhatsApp preview nobody looks at until an organiser complains. Setting it
 * here makes it impossible to forget and identical everywhere. It must happen
 * before the first text render in the process, which module load guarantees.
 *
 * THIS CANNOT BE VERIFIED ON A WINDOWS DEV BOX. AT ALL.
 * ====================================================
 * Not "Windows has the fonts so the problem hides" - it is worse than that.
 * Measured 2026-09-03 on sharp 0.34.5 / libvips 8.17.3: pango's Windows
 * backend resolves fonts through the OS, and FONTCONFIG_PATH / FONTCONFIG_FILE
 * are ignored outright. A config exposing ZERO fonts still rendered Devanagari
 * byte-identically to one exposing Noto. So a local pass proves nothing about
 * this file working, and a local failure would not prove it broken either. The
 * only real verification is selfTest() run against the DEPLOYED API - see
 * GET /camps/public/og/selftest in routes/camps.js, which exists for exactly
 * this reason.
 *
 * HOW selfTest() DETECTS THE FAILURE
 * ==================================
 * Ink volume alone cannot: tofu boxes have plenty of ink, so "did anything
 * draw" is satisfied by the broken case too. The discriminator is a
 * DIFFERENTIAL - render the same Devanagari string twice, once asking for the
 * real family and once asking for a family that cannot exist. If Noto is
 * genuinely reachable the two renders differ; if it is not, both resolve to the
 * same fallback and come out identical. Comparing two buffers is cheap and it
 * is decisive, which is the same reasoning as canvasIsBlank() on the logo
 * path: build the detector, do not hope.
 *
 * BOTH PROBE ARMS PASS fallback="false", AND THAT IS LOAD-BEARING
 * ==============================================================
 * Pango's PER-GLYPH fallback is what breaks a naive differential, in opposite
 * directions on the two platforms - so it is switched off for the probes only:
 *
 *   - On LINUX, fonts.conf is the whole font world (one <dir>, deliberately no
 *     <include>). With fallback on, a request for an impossible family falls
 *     through coverage-based fallback and lands on NOTO ITSELF, so the control
 *     arm equals the real arm, `devanagari_font_reachable` reads false forever,
 *     and every Marathi camp silently serves the generic card - in the one
 *     environment where the fonts actually do work. A false negative that
 *     switches a shipped feature off is the worst outcome available here.
 *   - On WINDOWS, different unresolved codepoints resolve to different faces,
 *     so "both broken" does not imply "identical" either.
 *
 * Measured 2026-09-03, with fallback off: two DIFFERENT impossible families
 * render byte-identically, i.e. the control arm is a stable reference. That is
 * the property the whole test rests on.
 *
 * TWO OTHER DISCRIMINATORS WERE MEASURED AND REJECTED. Do not reintroduce them:
 *   - Two real WEIGHTS of the shipped family. False positive: it reports DIFFER
 *     on Windows, where the shipped Noto provably drew nothing, because the
 *     substituted OS face has genuine weight files of its own.
 *   - Real Devanagari vs same-length Private Use Area codepoints. Its NEGATIVE
 *     branch - the one that must be reliable - does not hold: two different PUA
 *     runs came out 229x42 and 231x43, so tofu is not uniform.
 *
 * The residual gap is the mirror of the old one, and it is the safe side: with
 * fallback off, EVERY arm is identical on Windows, so it is the DIFFER branch
 * that cannot be exercised locally. A local `ok:false` is therefore expected
 * and correct, and only the deployed self-test can confirm the true positive.
 *
 * fallback="false" MUST NOT LEAK INTO THE PRODUCTION TEXT PATH. A real card
 * renders "Amravati रक्तदान 2026" as ONE run asking for Inter, and reaching
 * Noto for the Devanagari glyphs is precisely per-glyph fallback doing its job
 * via the fonts.conf <accept> alias. Hence renderText() defaults to fallback
 * ON and only the probes opt out.
 */
const fs = require('fs');
const path = require('path');

const logger = require('../../config/logger');

// backend/src/services/images -> backend/assets/fonts
const FONTS_DIR = path.join(__dirname, '..', '..', '..', 'assets', 'fonts');

// Point fontconfig at the DIRECTORY holding fonts.conf (not at the file).
// Respect an operator override if one is already set - if somebody has gone to
// the trouble of setting this in the environment, they mean it.
if (!process.env.FONTCONFIG_PATH) {
  process.env.FONTCONFIG_PATH = FONTS_DIR;
}

// The families as pango knows them, i.e. as declared inside the .ttf files.
// Latin and Devanagari are two files because Inter carries no Devanagari; the
// fonts.conf <accept> rule is what lets one font_desc="Inter ..." request reach
// both, so a mixed "Amravati रक्तदान 2026" name is still one text run.
const FAMILY_LATIN = 'Inter';
const FAMILY_DEVANAGARI = 'Noto Sans Devanagari';

// A family name that cannot exist, used only as selfTest()'s control arm.
const FAMILY_IMPOSSIBLE = 'RaktifyNoSuchFamily7913';

const EXPECTED_FILES = [
  'fonts.conf',
  'Inter-Regular.ttf',
  'Inter-SemiBold.ttf',
  'Inter-Bold.ttf',
  'Inter-ExtraBold.ttf',
  'NotoSansDevanagari-Regular.ttf',
  'NotoSansDevanagari-SemiBold.ttf',
  'NotoSansDevanagari-Bold.ttf',
];

/** Which of the files we expect to have shipped are actually on disk. */
function inventory() {
  const present = [];
  const missing = [];
  for (const name of EXPECTED_FILES) {
    if (fs.existsSync(path.join(FONTS_DIR, name))) present.push(name);
    else missing.push(name);
  }
  return { dir: FONTS_DIR, present, missing };
}

/**
 * Escape a value for pango markup. Camp names and organiser names are
 * ORGANISER-SUPPLIED TEXT going into a markup parser, so this is not cosmetic:
 * an unescaped `<` makes pango reject the whole string and the card silently
 * loses its heading. Pango accepts the XML five.
 */
function escapeMarkup(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render one run of text to a transparent RGBA PNG buffer.
 *
 * `dpi: 72` is deliberate and load-bearing: it makes one pango point equal one
 * pixel, so the size in a font_desc is a pixel size and the card's layout
 * maths is arithmetic rather than guesswork. sharp rejects `dpi` and `height`
 * together, so height is never passed - the box is bounded by `width` plus
 * word wrapping, and the caller reads back the height it got.
 *
 * `fallback` defaults to TRUE and every production caller leaves it that way -
 * per-glyph fallback is what lets one font_desc="Inter ..." run reach Noto for
 * the Devanagari glyphs in "Amravati रक्तदान 2026". Only the reachability
 * probes below turn it off, and the header explains at length why.
 */
async function renderText(sharp, { markup, width, align = 'left', spacing = 0, fallback = true }) {
  // sharp throws `text: no text to render` on an empty or whitespace-only
  // string. Every caller here feeds user data, so guard rather than throw.
  const probe = markup.replace(/<[^>]*>/g, '').trim();
  if (!probe) return null;

  // An OUTER span carries the attribute over everything nested inside it, so
  // opting out costs the caller no change to its own markup.
  const text = fallback ? markup : `<span fallback="false">${markup}</span>`;
  const opts = { text, width, rgba: true, align, wrap: 'word', dpi: 72 };
  if (spacing) opts.spacing = spacing;
  const { data, info } = await sharp({ text: opts }).png().toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height };
}

/**
 * Is the Devanagari font actually reachable in THIS process?
 *
 * Differential test, per the header: the real family and an impossible family
 * must not produce the same pixels. BOTH arms pass fallback:false, without
 * which the impossible family would reach Noto by coverage on Linux and this
 * would answer false in the one place the fonts genuinely work. Cached after
 * the first call - the answer cannot change without a redeploy, and every OG
 * render would otherwise pay for two extra text renders.
 */
let devanagariCache = null;

async function devanagariReachable(sharp) {
  if (devanagariCache !== null) return devanagariCache;
  const sample = 'रक्तदान शिबिर';
  try {
    const real = await renderText(sharp, {
      markup: `<span font_desc="${FAMILY_DEVANAGARI} Bold 44">${sample}</span>`,
      width: 900,
      fallback: false,
    });
    const control = await renderText(sharp, {
      markup: `<span font_desc="${FAMILY_IMPOSSIBLE} Bold 44">${sample}</span>`,
      width: 900,
      fallback: false,
    });
    devanagariCache = !!(real && control && !real.buffer.equals(control.buffer));
  } catch (err) {
    logger.warn({ err: err.message }, 'og_fonts_devanagari_probe_failed');
    devanagariCache = false;
  }
  if (!devanagariCache) {
    logger.warn(
      { fontsDir: FONTS_DIR, fontconfigPath: process.env.FONTCONFIG_PATH },
      'og_fonts_devanagari_unreachable - Marathi camp names would render as tofu; ' +
        'those cards fall back to the generic OG image',
    );
  }
  return devanagariCache;
}

/**
 * Does this string need the Devanagari font? Devanagari block U+0900-U+097F,
 * plus the extended block that carries some Marathi forms.
 */
function hasDevanagari(s) {
  // Numeric block bounds, not a regex character class: U+0900 is itself a
  // combining mark, so ANY class containing it trips eslint's
  // no-misleading-character-class - escaping it makes no difference, the rule
  // reads the codepoint. Iterating is also honest about the two blocks and
  // catches U+0964 DANDA, which is Script=Common and would slip past a
  // Script=Devanagari property escape.
  for (const ch of String(s || '')) {
    const c = ch.codePointAt(0);
    if (c >= 0x0900 && c <= 0x097f) return true; // Devanagari
    if (c >= 0xa8e0 && c <= 0xa8ff) return true; // Devanagari Extended
  }
  return false;
}

/**
 * Everything a caller needs to decide whether to trust a render, in a shape
 * safe to return over HTTP: counts, booleans and dimensions only. No absolute
 * paths, no environment dump.
 */
async function selfTest(sharp) {
  const inv = inventory();
  const latin = await renderText(sharp, {
    markup: `<span font_desc="${FAMILY_LATIN} Bold 44">Amravati Blood Camp 2026</span>`,
    width: 900,
  }).catch(() => null);
  // fallback:false on both differential arms only - see the header. The Latin
  // arm above is left production-shaped: it answers "did anything render", not
  // "which face", so pinning it would buy nothing.
  const devanagari = await renderText(sharp, {
    markup: `<span font_desc="${FAMILY_DEVANAGARI} Bold 44">अमरावती रक्तदान शिबिर</span>`,
    width: 900,
    fallback: false,
  }).catch(() => null);
  const control = await renderText(sharp, {
    markup: `<span font_desc="${FAMILY_IMPOSSIBLE} Bold 44">अमरावती रक्तदान शिबिर</span>`,
    width: 900,
    fallback: false,
  }).catch(() => null);

  const differs = !!(devanagari && control && !devanagari.buffer.equals(control.buffer));

  return {
    fonts_dir_basename: path.basename(inv.dir),
    fontconfig_path_set: !!process.env.FONTCONFIG_PATH,
    files_present: inv.present.length,
    files_expected: EXPECTED_FILES.length,
    files_missing: inv.missing,
    latin_rendered: !!latin,
    latin_size: latin ? `${latin.width}x${latin.height}` : null,
    devanagari_rendered: !!devanagari,
    devanagari_size: devanagari ? `${devanagari.width}x${devanagari.height}` : null,
    // The one field that actually matters. false => the shipped Noto is not
    // reachable and Marathi names are boxes, whatever the sizes above say.
    devanagari_font_reachable: differs,
    ok: inv.missing.length === 0 && !!latin && differs,
  };
}

module.exports = {
  FONTS_DIR,
  FAMILY_LATIN,
  FAMILY_DEVANAGARI,
  escapeMarkup,
  hasDevanagari,
  renderText,
  devanagariReachable,
  selfTest,
  inventory,
};
