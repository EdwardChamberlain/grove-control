import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateAudit } from './audit-dependencies.mjs';

const now = new Date('2026-11-17T18:00:00Z');
const advisory = {
  name: 'picomatch',
  url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
  severity: 'high',
};

function fixture() {
  const report = {
    auditReportVersion: 2,
    vulnerabilities: {
      picomatch: { severity: 'high', via: [{ ...advisory }], nodes: ['node_modules/picomatch'] },
      tinyglobby: { severity: 'high', via: ['picomatch'], nodes: ['node_modules/tinyglobby'] },
      vitest: { severity: 'high', via: ['coverage', 'tinyglobby'], nodes: ['node_modules/vitest'] },
      coverage: { severity: 'high', via: ['vitest'], nodes: ['node_modules/coverage'] },
    },
  };
  const lockfile = { packages: Object.fromEntries(
    Object.keys(report.vulnerabilities).map((name) => [
      `node_modules/${name}`, { dev: true, version: name === 'picomatch' ? '4.0.7' : '1.0.0' },
    ]),
  ) };
  return { report, lockfile };
}

test('allows only the known advisory through development dependency chains and cycles', () => {
  const { report, lockfile } = fixture();
  assert.deepEqual(evaluateAudit(report, lockfile, now), {
    allowed: ['picomatch', 'tinyglobby', 'vitest', 'coverage'], blocking: [],
  });
});

test('keeps moderate findings below the existing high severity threshold', () => {
  const { report, lockfile } = fixture();
  report.vulnerabilities.minimatch = {
    severity: 'moderate', nodes: ['node_modules/minimatch'],
    via: [{ name: 'minimatch', severity: 'moderate', url: 'https://example.com/moderate' }],
  };
  lockfile.packages['node_modules/minimatch'] = { dev: true, version: '10.2.4' };
  report.vulnerabilities.tinyglobby.via.push('minimatch');
  assert.equal(evaluateAudit(report, lockfile, now).blocking.length, 0);
});

test('blocks another high advisory on picomatch and all affected parents', () => {
  const { report, lockfile } = fixture();
  report.vulnerabilities.picomatch.via.push({ ...advisory, url: 'https://example.com/new-advisory' });
  assert.equal(evaluateAudit(report, lockfile, now).blocking.length, 4);
});

test('blocks a high advisory on a parent even alongside the allowed advisory', () => {
  const { report, lockfile } = fixture();
  report.vulnerabilities.vitest.via.push({
    name: 'vitest', severity: 'high', url: 'https://example.com/vitest-advisory',
  });
  assert.deepEqual(evaluateAudit(report, lockfile, now).blocking, ['vitest', 'coverage']);
});

test('blocks critical findings including a severity increase for the known advisory', () => {
  const { report, lockfile } = fixture();
  report.vulnerabilities.picomatch.via[0].severity = 'critical';
  report.vulnerabilities.picomatch.severity = 'critical';
  assert.equal(evaluateAudit(report, lockfile, now).blocking.length, 4);
});

test('blocks the exception at and after its expiry', () => {
  const { report, lockfile } = fixture();
  assert.equal(evaluateAudit(report, lockfile, new Date('2026-12-16T23:59:59Z')).blocking.length, 0);
  for (const date of ['2026-12-17T00:00:00Z', '2027-01-01T00:00:00Z']) {
    assert.equal(evaluateAudit(report, lockfile, new Date(date)).blocking.length, 4);
  }
});

test('blocks production copies and copies missing from the lockfile', () => {
  for (const change of ['production', 'missing']) {
    const { report, lockfile } = fixture();
    if (change === 'production') lockfile.packages['node_modules/picomatch'].dev = false;
    else delete lockfile.packages['node_modules/picomatch'];
    assert.equal(evaluateAudit(report, lockfile, now).blocking.length, 4);
  }
});

test('blocks a production parent and differently versioned picomatch copies', () => {
  const { report, lockfile } = fixture();
  lockfile.packages['node_modules/vitest'].dev = false;
  assert.deepEqual(evaluateAudit(report, lockfile, now).blocking, ['vitest', 'coverage']);
  lockfile.packages['node_modules/picomatch'].version = '4.0.8';
  assert.equal(evaluateAudit(report, lockfile, now).blocking.length, 4);
});

test('allows a clean report after upstream resolution, even after expiry', () => {
  assert.deepEqual(evaluateAudit({ auditReportVersion: 2, vulnerabilities: {} },
    { packages: {} }, new Date('2027-01-01')), { allowed: [], blocking: [] });
});

test('rejects registry errors, malformed reports and missing dependency references', () => {
  const { report, lockfile } = fixture();
  for (const invalid of [null, {}, { error: 'registry unavailable' },
    { auditReportVersion: 1, vulnerabilities: {} }, { auditReportVersion: 2, vulnerabilities: [] }]) {
    assert.throws(() => evaluateAudit(invalid, lockfile, now));
  }
  report.vulnerabilities.tinyglobby.via.push('missing');
  assert.throws(() => evaluateAudit(report, lockfile, now), /Missing advisory/);
});

test('blocks high findings with only circular dependency references', () => {
  const { report, lockfile } = fixture();
  report.vulnerabilities.picomatch.via = ['tinyglobby'];
  assert.equal(evaluateAudit(report, lockfile, now).blocking.length, 4);
});
