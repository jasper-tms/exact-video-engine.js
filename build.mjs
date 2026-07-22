#!/usr/bin/env node
// Build exact-video-engine.js — the single classic script consumers load from
// jsDelivr — out of the ES modules in src/.
//
// The modules exist so the pieces can be read, edited, and unit-tested in
// isolation (the Matroska parser runs in plain Node, no browser required); the
// classic script exists because that is the consuming story: one file, no
// bundler, loadable from a plain <script> tag next to mp4box.js. This build is
// the entire bridge between the two, and it is deliberately dumb so that the
// shipped file stays exactly as readable as the source: concatenate the
// modules in a fixed order, drop the `import` lines, and drop the `export `
// keywords. Nothing else — no minification, no renaming, no wrapping — so a
// stack trace or a curious reader sees the same lines in either place.
//
// Usage:
//   node build.mjs           rewrite exact-video-engine.js from src/
//   node build.mjs --check   exit 1 if exact-video-engine.js is out of step
//
// The pre-commit hook runs --check for any commit touching src/ or the built
// file, and the release workflow runs it before tagging, the same way the
// version pins are guarded (see .githooks/sync_version.sh).

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repositoryRoot = dirname(fileURLToPath(import.meta.url));

// Concatenation order is dependency order (each module only uses what came
// before it), and header.js is the file-level design commentary.
const MODULE_ORDER = [
  'src/header.js',
  'src/decode-support.js',
  'src/range-readers.js',
  'src/index-cache.js',
  'src/matroska.js',
  'src/ogg.js',
  'src/avi.js',
  'src/container-index.js',
  'src/video-engine.js',
  'src/native-video-engine.js',
  'src/create-best-engine.js',
];

const OUTPUT_FILE = 'exact-video-engine.js';

const GENERATED_BANNER =
  '// GENERATED FILE. Do not edit directly: the source lives in src/, and\n'
  + '// `node build.mjs` writes this file from it. The build only removes the\n'
  + '// module import/export syntax, so every other line here IS the source.\n';

// Strip a module down to the classic-script lines it contributes: drop each
// whole-line import (they only name what concatenation order already
// provides), drop the `export ` keyword from declarations, and drop the blank
// line the imports left behind at the top. Anything module-flavored that
// survives is a mistake in the source — a multi-line import, an export list —
// and the build refuses rather than ship it.
function stripModuleSyntax(source, modulePath) {
  const kept = [];
  for (const line of source.split('\n')) {
    if (/^import\b/.test(line)) {
      // Only whole-line imports are dropped. A multi-line import leaves its
      // continuation lines behind (they do not start with `import`), which then
      // slip past the guard below and ship as a syntax error — so refuse one here
      // with a message that names the fix rather than let it reach the browser.
      if (!/\bfrom\b.*;?\s*$/.test(line)) {
        throw new Error(`${modulePath}: '${line.slice(0, 60)}' is a multi-line import; `
          + 'this build only strips single-line imports (keep the whole import on one line)');
      }
      continue;
    }
    kept.push(line.replace(/^export (?=(async )?(class|function|const|let|var)\b)/, ''));
  }
  while (kept.length && kept[0] === '') kept.shift();
  for (const line of kept) {
    if (/^(import|export)\b/.test(line)) {
      throw new Error(`${modulePath}: '${line.slice(0, 60)}' is module syntax this `
        + 'build does not understand (keep imports single-line, and export by '
        + 'prefixing a declaration)');
    }
  }
  return kept.join('\n');
}

async function buildOutput() {
  const pieces = [GENERATED_BANNER];
  for (const modulePath of MODULE_ORDER) {
    const source = await readFile(join(repositoryRoot, modulePath), 'utf8');
    pieces.push(stripModuleSyntax(source, modulePath));
  }
  return pieces.join('');
}

const built = await buildOutput();
const outputPath = join(repositoryRoot, OUTPUT_FILE);

if (process.argv.includes('--check')) {
  const existing = await readFile(outputPath, 'utf8').catch(() => null);
  if (existing !== built) {
    console.error(`${OUTPUT_FILE} is out of step with src/. `
      + 'Run `node build.mjs` and commit the result.');
    process.exit(1);
  }
} else {
  await writeFile(outputPath, built);
  console.log(`${OUTPUT_FILE} built from ${MODULE_ORDER.length} modules`);
}
