// Copies the MediaPipe runtime out of node_modules and downloads the AI models, so the
// site can serve every file itself (no CDNs, no third-party requests at runtime).
// Models are pinned to exact versions and verified by SHA-256.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, createWriteStream } from 'node:fs';
import https from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mp = join(root, 'node_modules', '@mediapipe', 'tasks-vision');

const VENDOR_FILES = [
  ['vision_bundle.mjs', 'vendor/mediapipe/vision_bundle.mjs'],
  ['wasm/vision_wasm_internal.js', 'vendor/mediapipe/wasm/vision_wasm_internal.js'],
  ['wasm/vision_wasm_internal.wasm', 'vendor/mediapipe/wasm/vision_wasm_internal.wasm'],
];

const MODELS = [
  {
    file: 'models/face_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    sha256: '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
  },
  {
    file: 'models/selfie_multiclass_256x256.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite',
    sha256: 'c6748b1253a99067ef71f7e26ca71096cd449baefa8f101900ea23016507e0e0',
  },
];

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function download(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          return resolve(download(new URL(res.headers.location, url).href, dest, redirects - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`GET ${url} -> HTTP ${res.statusCode}`));
        }
        const out = createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => out.close(resolve));
        out.on('error', reject);
      })
      .on('error', reject);
  });
}

async function main() {
  if (!existsSync(mp)) {
    console.error('Missing @mediapipe/tasks-vision. Run "npm install" first.');
    process.exit(1);
  }
  for (const [from, to] of VENDOR_FILES) {
    const dest = join(root, to);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(mp, from), dest);
  }
  console.log('✓ MediaPipe runtime copied to vendor/');

  for (const m of MODELS) {
    const dest = join(root, m.file);
    if (existsSync(dest) && sha256(dest) === m.sha256) {
      console.log(`✓ ${m.file} (already present)`);
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = `${dest}.part`;
    process.stdout.write(`↓ ${m.file} … `);
    await download(m.url, tmp);
    const got = sha256(tmp);
    if (got !== m.sha256) {
      unlinkSync(tmp);
      throw new Error(`Checksum mismatch for ${m.file}\n  expected ${m.sha256}\n  got      ${got}`);
    }
    renameSync(tmp, dest);
    console.log('verified');
  }
}

main().catch((err) => {
  console.error(`\n✗ Setup failed: ${err.message}`);
  process.exit(1);
});
