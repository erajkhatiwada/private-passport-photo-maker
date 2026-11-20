// Assembles the deployable static site in dist/ (used by the GitHub Pages workflow).
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const ENTRIES = ['index.html', 'favicon.svg', 'css', 'js', 'vendor', 'models'];

for (const e of ['vendor', 'models']) {
  if (!existsSync(join(root, e))) {
    console.error(`Missing ${e}/ — run "npm install" (or "npm run setup") first.`);
    process.exit(1);
  }
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);
for (const e of ENTRIES) cpSync(join(root, e), join(dist, e), { recursive: true });
console.log('✓ Built site in dist/');
