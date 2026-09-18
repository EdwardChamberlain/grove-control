import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const frontendRoot = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(frontendRoot, '..');

const forbiddenPaths = [
  'src/pages/spoolbuddy',
  'src/components/spoolbuddy',
  'src/components/SpoolBuddySettings.tsx',
  'src/hooks/useSpoolBuddyState.ts',
  'public/grove_control_spoolbuddy_logo_dark.png',
  'public/img/grove_control_spoolbuddy_logo_dark.png',
  'public/img/grove_control_spoolbuddy_logo_dark_small.png',
  '../spoolbuddy',
  '../backend/app/api/routes/spoolbuddy.py',
  '../backend/app/models/spoolbuddy_device.py',
  '../backend/app/schemas/spoolbuddy.py',
  '../backend/app/services/spoolbuddy_ssh.py',
];

function containsFiles(absolutePath) {
  if (!fs.existsSync(absolutePath)) return false;
  const stat = fs.statSync(absolutePath);
  if (stat.isFile()) return true;
  return fs.readdirSync(absolutePath).some((entry) => containsFiles(path.join(absolutePath, entry)));
}

const failures = [];
for (const relativePath of forbiddenPaths) {
  const absolutePath = path.resolve(frontendRoot, relativePath);
  if (containsFiles(absolutePath)) {
    failures.push('removed path still exists: ' + relativePath);
  }
}

const sourceChecks = [
  ['src/App.tsx', /spoolbuddy/i, 'frontend route/import'],
  ['src/pages/SettingsPage.tsx', /spoolbuddy/i, 'settings navigation'],
  ['src/api/client.ts', /spoolbuddy/i, 'frontend API client'],
  ['public/sw-register.js', /spoolbuddy/i, 'service-worker registration'],
  ['../backend/app/main.py', /spoolbuddy/i, 'backend route/lifecycle'],
  ['../backend/app/api/routes/support.py', /spoolbuddy/i, 'support bundle'],
  ['../requirements.txt', /asyncssh/i, 'removed SSH dependency'],
  ['../Dockerfile', /openssh-client|spoolbuddy_ssh|\.git\/HEAD/i, 'removed packaging dependency'],
];

for (const [relativePath, pattern, description] of sourceChecks) {
  const absolutePath = path.resolve(frontendRoot, relativePath);
  // The Docker frontend-builder contains only frontend/, so backend and root
  // packaging files are unavailable there. The full repository check still
  // validates those files in CI and developer checkouts.
  if (!fs.existsSync(absolutePath)) continue;
  if (pattern.test(fs.readFileSync(absolutePath, 'utf8'))) {
    failures.push('removed ' + description + ' remains in ' + relativePath);
  }
}

const staticRoot = path.resolve(repoRoot, 'static');
if (fs.existsSync(staticRoot)) {
  const pending = [staticRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolutePath);
      } else if (/spoolbuddy/i.test(entry.name)) {
        failures.push('removed asset packaged in static output: ' + path.relative(repoRoot, absolutePath));
      } else if (
        /\.(css|html|js)$/.test(entry.name) &&
        /(?:\/spoolbuddy|data-spoolbuddy)/i.test(fs.readFileSync(absolutePath, 'utf8'))
      ) {
        failures.push('removed route or asset reference packaged in static output: ' + path.relative(repoRoot, absolutePath));
      }
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log('SpoolBuddy removal regression check passed');
