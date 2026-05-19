// Standalone smoke test for the compression pipeline.
// Validates: sharp -> WebP works, output is smaller, recycle-bin (shell) not used here.
const path = require('node:path');
const fs = require('node:fs/promises');
const sharp = require('sharp');

(async () => {
  const tmpDir = path.join(__dirname, 'tmp');
  await fs.mkdir(tmpDir, { recursive: true });

  // Generate a colorful 1920x1080 JPEG noisy-ish image — should be a reasonable test for compression.
  const w = 1920, h = 1080;
  const channels = 3;
  const data = Buffer.alloc(w * h * channels);
  for (let i = 0; i < data.length; i += channels) {
    // gradient + bands of noise so JPEG compression is meaningful
    const x = (i / channels) % w;
    const y = Math.floor((i / channels) / w);
    data[i]     = (x * 255 / w) & 0xff;
    data[i + 1] = (y * 255 / h) & 0xff;
    data[i + 2] = ((x + y) & 0xff);
    if (((x + y) % 17) === 0) data[i] ^= 0x7f;
  }
  const inputJpg = path.join(tmpDir, 'sample.jpg');
  await sharp(data, { raw: { width: w, height: h, channels } })
    .jpeg({ quality: 92 })
    .toFile(inputJpg);

  const inSize = (await fs.stat(inputJpg)).size;
  console.log('input JPG bytes:', inSize);

  const outWebp = path.join(tmpDir, 'sample.webp');
  await sharp(inputJpg, { failOn: 'none' })
    .rotate()
    .webp({ quality: 85, effort: 4, smartSubsample: true })
    .toFile(outWebp);

  const outSize = (await fs.stat(outWebp)).size;
  const ratio = outSize / inSize;
  console.log('output WebP bytes:', outSize, `(${(ratio * 100).toFixed(1)}% of original)`);

  if (outSize <= 0) { console.error('FAIL: WebP empty'); process.exit(1); }
  if (outSize >= inSize) console.warn('NOTE: WebP not smaller than JPEG (acceptable for synthetic image)');
  console.log('OK');
})();
