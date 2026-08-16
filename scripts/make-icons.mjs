// Builds the icon set from the master artwork. Run after replacing solrush.png:
//   node scripts/make-icons.mjs
//
// Two different shapes are needed and they are NOT the same picture.
//
//   "any"      — shown exactly as given. The rounded badge must fill the frame,
//                because the browser adds no rounding of its own; shipping the
//                artwork with its margin still on makes a small icon floating
//                in a dark square.
//   "maskable" — the platform crops it to whatever shape it likes (circle,
//                squircle, rounded square) and guarantees only the middle 80%
//                survives. So this one keeps the margin and lets the background
//                run to all four edges. Ship the "any" crop as maskable and
//                Android rounds an already-rounded badge, shaving its corners.
//
// The master happens to be laid out correctly for the second case already: the
// badge covers 78% of the canvas, just inside the 80% safe circle.

import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'solrush.png');
const OUT = join(ROOT, 'public', 'icons');

// Found by scanning out from the centre for the badge's bright rim, then
// squared off around its midpoint so nothing is stretched.
const BADGE = { left: 137, top: 128, width: 982, height: 982 };

const png = (q = 100) => ({ compressionLevel: 9, quality: q, effort: 10 });

async function main() {
  const meta = await sharp(SRC).metadata();
  console.log(`master: ${meta.width}x${meta.height}`);

  // ---- "any": the badge alone, filling the frame ----
  const badge = sharp(SRC).extract(BADGE);
  for (const size of [512, 192, 180]) {
    await badge.clone()
      .resize(size, size, { fit: 'cover', kernel: 'lanczos3' })
      .png(png())
      .toFile(join(OUT, size === 180 ? 'apple-touch-icon.png' : `icon-${size}.png`));
    console.log(`  icon ${size}`);
  }

  // ---- "maskable": the whole canvas, margin included ----
  await sharp(SRC)
    .resize(512, 512, { fit: 'cover', kernel: 'lanczos3' })
    .png(png())
    .toFile(join(OUT, 'icon-maskable.png'));
  console.log('  maskable 512');

  /* ---- favicon ----
     A 32px favicon of a detailed 3D render is mud. Downscaling in two steps —
     to 64 with a sharp kernel, then to 32 — keeps more of the pawn silhouette
     than going straight there, and a small sharpen puts back the edge that
     every resample costs. */
  const small = await sharp(SRC).extract(BADGE)
    .resize(64, 64, { fit: 'cover', kernel: 'lanczos3' })
    .sharpen({ sigma: 0.6 })
    .toBuffer();
  for (const size of [32, 16]) {
    await sharp(small)
      .resize(size, size, { kernel: 'lanczos3' })
      .sharpen({ sigma: 0.4 })
      .png(png())
      .toFile(join(OUT, `favicon-${size}.png`));
    console.log(`  favicon ${size}`);
  }

  /* ---- the social card ----
     og:image is read at 1.91:1 by most messengers. A square image there gets
     centre-cropped, which cuts the top and bottom off the board. Better to
     compose the card ourselves: the badge on the artwork's own background. */
  const cardH = 630, cardW = 1200;
  const mark = await sharp(SRC).extract(BADGE)
    .resize(430, 430, { kernel: 'lanczos3' }).toBuffer();
  await sharp({
    create: { width: cardW, height: cardH, channels: 3, background: '#171f2e' },
  })
    .composite([{ input: mark, top: (cardH - 430) >> 1, left: (cardW - 430) >> 1 }])
    .png(png())
    .toFile(join(OUT, 'og-card.png'));
  console.log('  og card 1200x630');
}

main().catch((e) => { console.error(e); process.exit(1); });
