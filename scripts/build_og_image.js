#!/usr/bin/env node
/**
 * Render Raktify brand images from SVG sources to PNG.
 *
 * Three outputs:
 *   • og-image.png (1200×630) — used by WhatsApp / Facebook / LinkedIn for
 *     link previews. Source: frontend/public/og-image.svg
 *   • app-icon.png (1024×1024) — used by Meta App Dashboard, Android Play
 *     Store, iOS App Store, PWA installer, favicon-large. Rounded-square
 *     with the "R" letter inside the droplet. Source:
 *     frontend/public/app-icon.svg
 *   • social-avatar.png (640×640) — used for social-platform profile
 *     pictures (WhatsApp Business, Facebook Page, Instagram, LinkedIn,
 *     Telegram, X). Full-bleed square, larger droplet, no "R" — designed
 *     for the circular crop these platforms apply. Source:
 *     frontend/public/social-avatar.svg
 *
 * Usage:
 *   node scripts/build_og_image.js
 *
 * Outputs committed to frontend/public/; Vite copies them to frontend/dist/
 * during the production build.
 */
const fs = require('fs');
const path = require('path');

// The cream ground of the locked design system.
const CREAM = '#fdf8f4';

async function render(sharp, svgPath, pngPath, width, height, label, { opaque = false } = {}) {
  const svg = fs.readFileSync(svgPath);
  let pipeline = sharp(svg, { density: 320 }).resize(width, height, {
    fit: 'cover',
    position: 'centre',
  });
  // A LINK-PREVIEW image must be OPAQUE. librsvg hands back 32-bit RGBA even
  // when every pixel is fully opaque, and some crawlers decline an RGBA
  // og:image outright — that was the one property og-image.png shared with the
  // per-camp card while neither of them previewed. og-image.svg already paints
  // a full-bleed rect in CREAM, so this drops the alpha channel and changes no
  // pixel. The two icons deliberately KEEP their alpha: app-icon.png needs it
  // for the rounded corners, and social-avatar.png is cropped to a circle by
  // the platform itself.
  if (opaque) pipeline = pipeline.flatten({ background: CREAM });
  await pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toFile(pngPath);
  const { size } = fs.statSync(pngPath);
  // eslint-disable-next-line no-console
  console.log(`✓ wrote ${label.padEnd(12)} ${pngPath} (${(size / 1024).toFixed(1)} KiB)`);
}

(async () => {
  // npm workspaces hoist common deps to the root node_modules. Try the root
  // first, then the workspace folder as a fallback.
  let sharp;
  try {
    sharp = require(path.join(__dirname, '..', 'node_modules', 'sharp'));
  } catch {
    sharp = require(path.join(__dirname, '..', 'frontend', 'node_modules', 'sharp'));
  }

  const pub = path.join(__dirname, '..', 'frontend', 'public');

  // OG preview image — 1200×630, the standard for FB / WhatsApp link cards.
  await render(
    sharp,
    path.join(pub, 'og-image.svg'),
    path.join(pub, 'og-image.png'),
    1200, 630,
    'og-image',
    { opaque: true },
  );

  // App icon — 1024×1024, the standard for Meta App Dashboard, Play Store,
  // App Store, PWA installer.
  await render(
    sharp,
    path.join(pub, 'app-icon.svg'),
    path.join(pub, 'app-icon.png'),
    1024, 1024,
    'app-icon',
  );

  // Social avatar — 640×640, WhatsApp Business profile + every other social
  // platform that crops uploads to a circle. Full-bleed square, larger
  // droplet, no "R" letter (the platform shows "Raktify" beside the avatar).
  await render(
    sharp,
    path.join(pub, 'social-avatar.svg'),
    path.join(pub, 'social-avatar.png'),
    640, 640,
    'social-avatar',
  );
})().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Brand image build failed:', err.message);
  process.exit(1);
});
