#!/usr/bin/env node

/**
 * Fail if `npm run typecheck` has stopped checking real source files.
 *
 * The root tsconfig.json is a solution file (`"files": []`) that only
 * references other projects, so `tsc` on its own checks nothing, and that is
 * exactly how the type check silently passed for a long time (#319). A
 * referenced project whose `include` globs match nothing is just as quiet.
 *
 * For every project referenced from tsconfig.json this runs
 * `tsc -p <project> --listFilesOnly` and requires at least one of the
 * project's own TypeScript files (not node_modules, not a `.d.ts`).
 */

import { execFileSync } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const tscBin = require.resolve('typescript/bin/tsc');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootConfig = resolve(root, 'tsconfig.json');

const { config, error } = ts.readConfigFile(rootConfig, ts.sys.readFile);
if (error) {
  console.error(`check-typecheck-coverage: cannot read ${rootConfig}: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`);
  process.exit(1);
}

const references = (config.references ?? []).map((ref) => resolve(root, ref.path));
if (references.length === 0) {
  console.error('check-typecheck-coverage: tsconfig.json references no projects, so `tsc -b` checks nothing.');
  process.exit(1);
}

function ownSourceFiles(project) {
  const output = execFileSync(process.execPath, [tscBin, '-p', project, '--listFilesOnly'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((file) => file && !file.split(/[\\/]/).includes('node_modules') && !file.endsWith('.d.ts'));
}

const failures = [];
for (const project of references) {
  const name = relative(root, project);
  let files;
  try {
    files = ownSourceFiles(project);
  } catch (err) {
    failures.push(`${name}: tsc --listFilesOnly failed: ${String(err.stderr || err.stdout || err.message).trim().split('\n')[0]}`);
    continue;
  }
  if (files.length === 0) {
    failures.push(`${name}: lists no source files of its own (check its "include"/"files").`);
  } else {
    console.log(`check-typecheck-coverage: ${name} checks ${files.length} file(s).`);
  }
}

if (failures.length > 0) {
  console.error('\ncheck-typecheck-coverage: the type check would be a no-op for:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
