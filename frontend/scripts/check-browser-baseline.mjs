#!/usr/bin/env node

/**
 * Keep parse-time JavaScript incompatibilities out of the shipped entry
 * bundle. Safari 16.0 through 16.3 cannot parse regex lookbehind, and a
 * failure during module compilation leaves the whole SPA blank (#86).
 *
 * This intentionally checks syntax that can prevent startup, not runtime API
 * availability. The latter affects an individual feature and belongs in
 * browser coverage; a parse error has no graceful fallback.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const assetsDir = resolve(fileURLToPath(new URL('../..', import.meta.url)), 'static/assets');
const forbidden = [
  {
    pattern: /\(\?<([=!])/g,
    feature: 'regular-expression lookbehind assertion',
    hint: 'Avoid importing the dependency that contains the assertion; Vite/esbuild do not rewrite regular expressions.',
  },
  {
    pattern: /\bstatic\s*\{/g,
    feature: 'class static initialisation block',
    hint: 'Lower the build target or replace the dependency that emits this syntax.',
  },
];

let bundles;
try {
  bundles = readdirSync(assetsDir).filter((name) => name.endsWith('.js'));
} catch {
  console.error(`check-browser-baseline: no build output at ${assetsDir}; run \`vite build\` first.`);
  process.exit(1);
}

if (bundles.length === 0) {
  console.error(`check-browser-baseline: no JavaScript bundles found in ${assetsDir}.`);
  process.exit(1);
}

const failures = [];
for (const name of bundles) {
  const source = readFileSync(join(assetsDir, name), 'utf8');
  for (const rule of forbidden) {
    const matches = source.match(rule.pattern);
    if (!matches) continue;
    const index = source.search(rule.pattern);
    failures.push(
      `  ${name}: ${matches.length} occurrence(s) of ${rule.feature}\n` +
      `    ...${source.slice(Math.max(0, index - 60), index + 80)}...\n` +
      `    ${rule.hint}`,
    );
  }
}

if (failures.length > 0) {
  console.error(
    'check-browser-baseline: emitted JavaScript is not parse-compatible with Safari 16.0 / iOS 16.0.\n\n' +
    failures.join('\n\n'),
  );
  process.exit(1);
}

console.log(`✓ ${bundles.length} JavaScript bundle(s) pass the Safari 16.0 parse baseline.`);
