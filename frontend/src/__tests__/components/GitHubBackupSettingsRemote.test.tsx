/**
 * GitHubBackupSettings remote (Git provider) backups: first-time setup
 * validation, testing the connection, running a backup and its outcomes,
 * and the history log.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { GitHubBackupSettings } from '../../components/GitHubBackupSettings';

const config = {
  id: 1, repository_url: 'https://github.com/me/backups', has_token: true, branch: 'main', provider: 'github',
  allow_insecure_http: false, schedule_enabled: true, schedule_type: 'daily', backup_kprofiles: true,
  backup_cloud_profiles: true, backup_settings: false, backup_spools: false, backup_archives: false, enabled: true,
  last_backup_at: '2026-04-12T12:00:00Z', last_backup_status: 'success', last_backup_message: 'ok',
  last_backup_commit_sha: 'abc1234def', next_scheduled_run: '2026-04-13T03:00:00Z', created_at: '', updated_at: '',
};

const logs = [
  { id: 1, config_id: 1, started_at: '2026-04-12T12:00:00Z', completed_at: '2026-04-12T12:00:05Z', status: 'success', trigger: 'manual', commit_sha: 'abc1234def', files_changed: 3, error_message: null },
  { id: 2, config_id: 1, started_at: '2026-04-11T12:00:00Z', completed_at: null, status: 'failed', trigger: 'scheduled', commit_sha: null, files_changed: 0, error_message: 'auth failed' },
  { id: 3, config_id: 1, started_at: '2026-04-10T12:00:00Z', completed_at: null, status: 'skipped', trigger: 'scheduled', commit_sha: null, files_changed: 0, error_message: null },
];

let calls: string[];

function useApi(configured: boolean) {
  calls = [];
  server.use(
    http.get('/api/v1/local-backup/status', () => HttpResponse.json({ enabled: false, schedule: 'daily', time: '03:00', retention: 5, path: '', default_path: '/data', is_running: false, last_backup_at: null, last_status: null, last_message: null, next_run: null, timezone: 'UTC' })),
    http.get('/api/v1/local-backup/backups', () => HttpResponse.json([])),
    http.get('/api/v1/github-backup/config', () => HttpResponse.json(configured ? config : null)),
    http.get('/api/v1/github-backup/status', () => HttpResponse.json({ configured, enabled: configured, is_running: false, progress: null, last_backup_at: null, last_backup_status: null, next_scheduled_run: null })),
    http.get('/api/v1/github-backup/logs', () => HttpResponse.json(configured ? logs : [])),
    http.get('/api/v1/cloud/status', () => HttpResponse.json({ is_authenticated: true })),
    http.get('/api/v1/printers/', () => HttpResponse.json([{ id: 1, name: 'X1' }])),
    http.get('/api/v1/printers/1/status', () => HttpResponse.json({ connected: false })),
    http.post('/api/v1/github-backup/test', ({ request }) => {
      calls.push(`test ${new URL(request.url).searchParams.get('repo_url')}`);
      return HttpResponse.json({ success: true, message: 'Repository reachable', is_private: true });
    }),
    http.post('/api/v1/github-backup/test-stored', () => {
      calls.push('test-stored');
      return HttpResponse.json({ success: false, message: 'Token expired', is_private: null });
    }),
    http.post('/api/v1/github-backup/run', () => {
      calls.push('run');
      return HttpResponse.json({ success: true, message: 'Pushed', files_changed: 4, commit_sha: 'fff' });
    }),
    http.delete('/api/v1/github-backup/logs', () => {
      calls.push('clear');
      return HttpResponse.json({ deleted: 3, message: 'ok' });
    }),
    http.post('/api/v1/github-backup/config', () => {
      calls.push('save');
      return HttpResponse.json(config);
    }),
  );
}

describe('first-time setup', () => {
  beforeEach(() => useApi(false));

  it('needs a repository and token before it can test or enable', async () => {
    const user = userEvent.setup();
    render(<GitHubBackupSettings />);

    const enable = await screen.findByRole('button', { name: /Enable Backup/ });
    const test = screen.getByRole('button', { name: /Test Connection/ });
    expect(enable).toBeDisabled();
    expect(test).toBeDisabled();

    await user.type(screen.getByPlaceholderText('https://github.com/username/repo-name'), 'https://github.com/me/backups');
    expect(enable).toBeDisabled();
    await user.type(screen.getByPlaceholderText('ghp_xxxxxxxxxxxx'), 'ghp_secret');
    expect(enable).toBeEnabled();

    await user.click(test);
    expect(await screen.findByText(/Repository reachable/)).toBeInTheDocument();
    expect(calls).toContain('test https://github.com/me/backups');

    await user.click(enable);
    await waitFor(() => expect(calls).toContain('save'));
    expect(await screen.findByText('GitHub backup enabled')).toBeInTheDocument();
  });

  it('shows an error when the connection test fails', async () => {
    server.use(http.post('/api/v1/github-backup/test', () => HttpResponse.json({ detail: 'Bad credentials' }, { status: 401 })));
    const user = userEvent.setup();
    render(<GitHubBackupSettings />);

    await user.type(await screen.findByPlaceholderText('https://github.com/username/repo-name'), 'https://github.com/me/backups');
    await user.type(screen.getByPlaceholderText('ghp_xxxxxxxxxxxx'), 'ghp_bad');
    await user.click(screen.getByRole('button', { name: /Test Connection/ }));

    expect(await screen.findByText(/Bad credentials/)).toBeInTheDocument();
  });
});

describe('configured backup', () => {
  beforeEach(() => useApi(true));

  it('shows the history with each status', async () => {
    render(<GitHubBackupSettings />);

    expect(await screen.findByText('History')).toBeInTheDocument();
    expect(await screen.findByText('Success')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Skipped')).toBeInTheDocument();
  });

  it('runs a backup and reports the files changed', async () => {
    const user = userEvent.setup();
    render(<GitHubBackupSettings />);

    await user.click(await screen.findByRole('button', { name: /Backup Now/ }));

    await waitFor(() => expect(calls).toContain('run'));
    expect(await screen.findByText('Backup complete - 4 files updated')).toBeInTheDocument();
  });

  it.each([
    [{ success: true, message: 'No changes', files_changed: 0, commit_sha: null }, 'Backup skipped - no changes'],
    [{ success: false, message: 'Repo is public', files_changed: 0, commit_sha: null }, 'Backup failed: Repo is public'],
  ])('reports a backup outcome (%#)', async (response, toast) => {
    server.use(http.post('/api/v1/github-backup/run', () => HttpResponse.json(response)));
    const user = userEvent.setup();
    render(<GitHubBackupSettings />);

    await user.click(await screen.findByRole('button', { name: /Backup Now/ }));

    expect(await screen.findByText(toast)).toBeInTheDocument();
  });

  it('reports a backup request that errors', async () => {
    server.use(http.post('/api/v1/github-backup/run', () => HttpResponse.json({ detail: 'Already running' }, { status: 409 })));
    const user = userEvent.setup();
    render(<GitHubBackupSettings />);

    await user.click(await screen.findByRole('button', { name: /Backup Now/ }));

    expect(await screen.findByText('Backup failed: Already running')).toBeInTheDocument();
  });

  it('tests the stored credentials', async () => {
    const user = userEvent.setup();
    render(<GitHubBackupSettings />);

    await user.click(await screen.findByRole('button', { name: /^Test$/ }));

    await waitFor(() => expect(calls).toContain('test-stored'));
    expect(await screen.findByText(/Token expired/)).toBeInTheDocument();
  });

  it('clears the history', async () => {
    const user = userEvent.setup();
    render(<GitHubBackupSettings />);

    await user.click(await screen.findByRole('button', { name: /^Clear$/ }));

    await waitFor(() => expect(calls).toContain('clear'));
    expect(await screen.findByText('Cleared 3 logs')).toBeInTheDocument();
  });
});
