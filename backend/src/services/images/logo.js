'use strict';

/**
 * Server-side normalisation of an organiser's camp logo.
 *
 * WHY THIS EXISTS AT ALL. The resize used to happen in the browser, on a
 * <canvas>. It shipped twice and failed twice, and the confirmed cause is that
 * FIREFOX BLOCKS CANVAS READBACK: with privacy.resistFingerprinting, strict ETP
 * or a CanvasBlocker-style extension, drawImage() silently succeeds while
 * getImageData()/toBlob() hand back a BLANK surface. Both reported symptoms
 * follow from that one fact, in order - a blank canvas encoded to JPEG is
 * OPAQUE BLACK (JPEG has no alpha channel), which was the black rectangle; then
 * the canvasIsBlank() backstop caught it and turned it into "that image could
 * not be read". The founder confirmed it by discriminating test: Edge works,
 * Firefox does not, on the same file and the same machine.
 *
 * So the browser is not a dependency any more. The canvas is still tried first
 * as a bandwidth optimisation, but it can no longer fail an upload - see
 * CampOrganizerDashboard.jsx. This module is what makes that safe: the stored
 * byte budget is now guaranteed BY CONSTRUCTION here instead of by refusing the
 * organiser at the door.
 */

const sharp = require('sharp');

// Longest edge of the stored logo. 400 px feeds the public page's 96 px frame
// at 2x DPR and the per-camp OG card's logo slot with room to spare; going
// wider only spends base64 bytes on pixels nothing renders.
const MAX_EDGE = 400;

// JPEG quality ladder, walked downwards until the encode fits the budget.
// 85 is visually lossless for a flat logo; below 55 a logo starts to look
// cheap, so that is where we stop and report failure instead.
const JPEG_QUALITY_STEPS = [85, 75, 65, 55];

class ImageUnreadableError extends Error {
  constructor(message, stage) {
    super(message);
    this.name = 'ImageUnreadableError';
    this.code = 'image_unreadable';
    this.stage = stage;
  }
}

/**
 * Decode, EXIF-rotate, downscale and re-encode an uploaded logo so the stored
 * data URI is guaranteed to fit maxBytes.
 *
 * @param {Buffer} buf              raw uploaded bytes (magic-byte checked already)
 * @param {number} maxBytes         the STORED budget, not the accepted one
 * @returns {Promise<{dataUri:string, contentType:string, bytes:number, width:number, height:number}>}
 * @throws {ImageUnreadableError}   any decode failure, or a logo that will not fit
 */
async function normaliseLogo(buf, maxBytes) {
  // limitInputPixels refuses an absurd declared canvas BEFORE libvips allocates
  // for it. App Service B1 has 1.75 GB for the whole platform, so this is a
  // real defence and not paranoia. 50 MP still admits any phone camera.
  // sequentialRead keeps a large JPEG off the heap in one piece.
  const img = sharp(buf, { limitInputPixels: 50e6, sequentialRead: true });

  let meta;
  try {
    meta = await img.metadata();
  } catch (e) {
    throw new ImageUnreadableError(`metadata failed: ${e.message}`, 'metadata');
  }
  if (!meta.width || !meta.height) {
    throw new ImageUnreadableError('no pixel dimensions', 'dims');
  }

  // .rotate() with no argument applies the EXIF orientation tag and strips it.
  // This is what the client's imageOrientation:'from-image' was for - a phone
  // photo held sideways is upright here, and it now happens somewhere that
  // cannot be switched off by a privacy setting.
  const base = img.rotate().resize(MAX_EDGE, MAX_EDGE, {
    fit: 'inside',
    withoutEnlargement: true,
  });

  // PNG FIRST WHEN THERE IS ALPHA, and this is deliberate, carried over from
  // the client encodeBest() it replaces: flattening a transparent logo onto
  // white would print a white box on the cream (#fdf8f4) public camp page.
  // A flat two-colour logo usually palettises well under budget, so try it.
  if (meta.hasAlpha) {
    let out;
    try {
      out = await base.clone().png({ compressionLevel: 9, palette: true }).toBuffer({
        resolveWithObject: true,
      });
    } catch (e) {
      throw new ImageUnreadableError(`png encode failed: ${e.message}`, 'encode_png');
    }
    if (out.data.length <= maxBytes) {
      return {
        dataUri: `data:image/png;base64,${out.data.toString('base64')}`,
        contentType: 'image/png',
        bytes: out.data.length,
        width: out.info.width,
        height: out.info.height,
      };
    }
    // Too big for the budget - fall through to JPEG. A white box is the lesser
    // evil against a logo that cannot be stored at all.
  }

  for (const quality of JPEG_QUALITY_STEPS) {
    let out;
    try {
      out = await base
        .clone()
        .flatten({ background: '#ffffff' })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
    } catch (e) {
      throw new ImageUnreadableError(`jpeg encode failed: ${e.message}`, 'encode_jpeg');
    }
    if (out.data.length <= maxBytes) {
      return {
        dataUri: `data:image/jpeg;base64,${out.data.toString('base64')}`,
        contentType: 'image/jpeg',
        bytes: out.data.length,
        width: out.info.width,
        height: out.info.height,
      };
    }
  }

  // A 400 px JPEG at quality 55 that still exceeds 50 KB is photographic noise,
  // not a logo. Report it rather than degrading further.
  throw new ImageUnreadableError(
    `cannot fit ${maxBytes} bytes at ${MAX_EDGE}px, quality ${JPEG_QUALITY_STEPS.at(-1)}`,
    'budget',
  );
}

module.exports = { normaliseLogo, ImageUnreadableError, MAX_EDGE };
