import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exception = {
  package: 'picomatch',
  version: '4.0.7',
  url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
  expires: '2026-12-17T00:00:00Z',
};
const severities = ['info', 'low', 'moderate', 'high', 'critical'];

function collectAdvisories(name, vulnerabilities, visited, advisories) {
  if (visited.has(name)) return;
  visited.add(name);
  const vulnerability = vulnerabilities[name];
  if (!Array.isArray(vulnerability?.via) || vulnerability.via.length === 0) {
    throw new Error(`Missing advisory information for ${name}`);
  }

  for (const entry of vulnerability.via) {
    if (typeof entry === 'string') {
      collectAdvisories(entry, vulnerabilities, visited, advisories);
    } else if (entry && severities.includes(entry.severity) && typeof entry.url === 'string') {
      advisories.push({ ...entry, package: name });
    } else {
      throw new Error(`Invalid advisory information for ${name}`);
    }
  }
}

export function evaluateAudit(report, lockfile, now = new Date()) {
  if (report?.error || report?.auditReportVersion !== 2 ||
      !report.vulnerabilities || typeof report.vulnerabilities !== 'object' ||
      Array.isArray(report.vulnerabilities) || !lockfile?.packages) {
    throw new Error('npm audit did not return a supported vulnerability report');
  }
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid audit date');

  const allowed = [];
  const blocking = [];
  for (const [name, vulnerability] of Object.entries(report.vulnerabilities)) {
    if (!severities.includes(vulnerability?.severity)) {
      throw new Error(`Invalid vulnerability severity for ${name}`);
    }
    if (!['high', 'critical'].includes(vulnerability.severity)) continue;

    const visited = new Set();
    const advisories = [];
    collectAdvisories(name, report.vulnerabilities, visited, advisories);
    const highAdvisories = advisories.filter((entry) =>
      ['high', 'critical'].includes(entry.severity));
    const onlyKnownAdvisory = highAdvisories.length > 0 && highAdvisories.every((entry) =>
      entry.package === exception.package && entry.name === exception.package &&
      entry.url === exception.url && entry.severity === 'high');
    const onlyDevCopies = [...visited].every((dependency) => {
      const nodes = report.vulnerabilities[dependency].nodes;
      return Array.isArray(nodes) && nodes.length > 0 && nodes.every((node) => {
        const installed = lockfile.packages[node];
        return installed?.dev === true &&
          (dependency !== exception.package || installed.version === exception.version);
      });
    });

    if (vulnerability.severity === 'high' && onlyKnownAdvisory && onlyDevCopies &&
        now < new Date(exception.expires)) {
      allowed.push(name);
    } else {
      blocking.push(name);
    }
  }
  return { allowed, blocking };
}

function main() {
  const frontendDir = fileURLToPath(new URL('..', import.meta.url));
  const audit = spawnSync('npm', ['audit', '--json', '--audit-level=high'], {
    cwd: frontendDir,
    encoding: 'utf8',
  });
  if (audit.error || audit.signal || ![0, 1].includes(audit.status)) {
    throw new Error('Could not run npm audit', { cause: audit.error ?? audit.stderr });
  }
  const report = JSON.parse(audit.stdout);
  const lockfile = JSON.parse(readFileSync(path.join(frontendDir, 'package-lock.json'), 'utf8'));
  const { allowed, blocking } = evaluateAudit(report, lockfile);

  if (allowed.length > 0) {
    console.warn(`Temporary development exception for ${exception.url}`);
    console.warn(`Accepted until ${exception.expires} for ${exception.package}@${exception.version}.`);
    console.warn(`Affected development tools: ${allowed.join(', ')}`);
    console.warn('Crafted glob patterns can cause denial of service. Upgrade when an official fix is released.');
  }
  if (blocking.length > 0) {
    console.error(`Blocking high or critical vulnerabilities: ${blocking.join(', ')}`);
    console.error(audit.stdout);
    process.exitCode = 1;
  } else {
    console.log('Frontend audit passed with the temporary development advisory policy.');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
