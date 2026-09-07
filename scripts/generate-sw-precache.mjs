// Runs after `vite build` (see package.json "postbuild"). Walks dist/ for
// every file Vite just emitted (hashed JS/CSS chunks, icons, etc.), and
// rewrites dist/sw.js's PRECACHE_URLS to list all of them, with a fresh
// CACHE_NAME derived from a hash of the file list so every deploy gets a
// clean cache instead of nurses' devices reusing a stale one.
//
// Why this matters offline: the service worker's fetch handler (see sw.js)
// already caches same-origin GET responses as they're requested, so a nurse
// who has opened the app before is fine offline either way. The gap this
// closes is the *first* install: someone taps "Add to Home Screen" on
// spotty ward wifi, the shell install fires before every chunk has been
// individually fetched, then they go offline — without a full precache list
// some of those chunks are missing and a route can fail to load.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const DIST_DIR = path.resolve(process.cwd(), 'dist');
const SW_PATH = path.join(DIST_DIR, 'sw.js');

async function walk(dir, base = dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, base, out);
    } else {
      // URL path as the browser will request it: forward slashes, leading /.
      const rel = '/' + path.relative(base, full).split(path.sep).join('/');
      out.push(rel);
    }
  }
  return out;
}

async function main() {
  if (!existsSync(SW_PATH)) {
    console.warn('[generate-sw-precache] dist/sw.js not found — skipping (did the build copy public/ as expected?)');
    return;
  }

  const files = await walk(DIST_DIR);
  // sw.js itself doesn't need to precache itself, and index.html is already
  // listed explicitly below alongside '/' (both must serve the SPA shell).
  const precache = files.filter((f) => f !== '/sw.js');
  if (!precache.includes('/index.html')) precache.push('/index.html');
  if (!precache.includes('/')) precache.unshift('/');

  const hash = createHash('sha1').update(precache.slice().sort().join('|')).digest('hex').slice(0, 10);
  const cacheName = `narhy-app-shell-${hash}`;

  let sw = readFileSync(SW_PATH, 'utf8');
  const before = sw;
  sw = sw.replace(
    /const CACHE_NAME = ['"][^'"]*['"];\s*\nconst PRECACHE_URLS = \[[^\]]*\];/,
    `const CACHE_NAME = ${JSON.stringify(cacheName)};\nconst PRECACHE_URLS = ${JSON.stringify(precache)};`
  );

  if (sw === before) {
    console.warn('[generate-sw-precache] Could not find the CACHE_NAME/PRECACHE_URLS block in sw.js to replace — check it still matches the expected shape.');
    process.exitCode = 1;
    return;
  }

  writeFileSync(SW_PATH, sw);
  console.log(`[generate-sw-precache] Precaching ${precache.length} files under cache "${cacheName}".`);
}

main().catch((err) => {
  console.error('[generate-sw-precache] failed:', err);
  process.exitCode = 1;
});
