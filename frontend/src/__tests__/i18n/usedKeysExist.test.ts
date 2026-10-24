/**
 * Every literal translation key used without a fallback must exist in the
 * English locale.
 *
 * The parity check (scripts/check-i18n-parity.mjs) only compares locales with
 * each other, so a key that is missing from *every* locale passes it while the
 * UI renders the raw key (e.g. "profiles.diff.title"). This test scans
 * `t('some.key')` calls in src/ and fails on any key en.ts doesn't define.
 *
 * Calls that pass English fallback text — `t('key', 'Text')` or
 * `t('key', { defaultValue: 'Text' })` — still render readable text, so they
 * are not flagged here. Dynamic keys (template literals, variables) are not
 * checked.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import en from '../../i18n/locales/en';

const SRC_DIR = path.resolve(__dirname, '../..');

function collectKeys(obj: Record<string, unknown>, prefix: string, into: Set<string>) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    into.add(key);
    if (v && typeof v === 'object') collectKeys(v as Record<string, unknown>, key, into);
  }
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'i18n') out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// Keys known to be missing from every locale (they render as raw keys).
// Keep this empty: add translations to every locale instead. The test fails
// if a listed key is fixed but still listed here.
const KNOWN_MISSING = new Set<string>([]);

/** True when the t() call continues with fallback text or a defaultValue. */
function hasFallback(rest: string): boolean {
  if (/^\s*,\s*['"`]/.test(rest)) return true;
  const options = rest.match(/^\s*,\s*\{([^}]*)\}/);
  return !!options && /\bdefaultValue\b/.test(options[1]);
}

describe('translation keys used in source', () => {
  it('all exist in the English locale', () => {
    const known = new Set<string>();
    collectKeys(en as Record<string, unknown>, '', known);

    const missing = new Map<string, Set<string>>();
    const stillMissing = new Set<string>();
    for (const file of sourceFiles(SRC_DIR)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(/\bt\(\s*['"]([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)['"]/g)) {
        const key = match[1];
        if (hasFallback(text.slice(match.index! + match[0].length))) continue;
        if (known.has(key) || known.has(`${key}_one`) || known.has(`${key}_other`)) continue;
        if (KNOWN_MISSING.has(key)) {
          stillMissing.add(key);
          continue;
        }
        if (!missing.has(key)) missing.set(key, new Set());
        missing.get(key)!.add(path.relative(SRC_DIR, file));
      }
    }

    const report = [...missing].map(([key, files]) => `${key}  (${[...files].join(', ')})`).sort();
    expect(report, `Keys used in source but missing from en.ts:\n${report.join('\n')}`).toEqual([]);

    const fixed = [...KNOWN_MISSING].filter((key) => !stillMissing.has(key)).sort();
    expect(fixed, `Remove these from KNOWN_MISSING (now defined or no longer used):\n${fixed.join('\n')}`).toEqual([]);
  });
});
