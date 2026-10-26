/**
 * GitHubBackupSettings local backup card: downloading a full backup,
 * restoring from an uploaded file, running a scheduled backup now, the
 * stored backup list (download / restore / delete) and schedule settings.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { GitHubBackupSettings } from '../../components/GitHubBackupSettings';

const status = {
  enabled: true, schedule: 'daily', time: '03:00', retention: 5, path: '', default_path: '/data/backups',
  is_running: false, last_backup_at: '2026-04-12T12:00:00Z', last_status: 'success', last_message: null,
  next_run: '2026-04-13T03:00:00+00:00', timezone: 'Europe/Berlin',
};
const backupFile = 'bambuddy-backup-20260412-120000.zip';

let calls: { method: string; path: string; body: unknown }[];

beforeEach(() => {
  calls = [];
  const record = (response: unknown = {}) =>
    async ({ request }: { request: Request }) => {
      const text = request.headers.get('content-type')?.includes('json') ? await request.text() : '';
      calls.push({ method: request.method, path: decodeURIComponent(new URL(request.url).pathname), body: text ? JSON.parse(text) : null });
      return HttpResponse.json(response);
    };
  server.use(
    http.get('/api/v1/local-backup/status', () => HttpResponse.json(status)),
    http.get('/api/v1/local-backup/backups', () => HttpResponse.json([{ filename: backupFile, size: 52428800, created_at: '2026-04-12T12:00:00+00:00' }])),
    http.get('/api/v1/github-backup/config', () => HttpResponse.json(null)),
    http.get('/api/v1/github-backup/status', () => HttpResponse.json({ configured: false, enabled: false, is_running: false, progress: null, last_backup_at: null, last_backup_status: null, next_scheduled_run: null })),
    http.get('/api/v1/github-backup/logs', () => HttpResponse.json([])),
    http.get('/api/v1/cloud/status', () => HttpResponse.json({ is_authenticated: false })),
    http.get('/api/v1/printers/', () => HttpResponse.json([])),
    http.put('/api/v1/settings/', record()),
    http.post('/api/v1/local-backup/run', record({ success: true, message: 'ok', filename: 'new.zip' })),
    http.post('/api/v1/local-backup/backups/:name/restore', record({ success: true, message: 'Restored' })),
    http.delete('/api/v1/local-backup/backups/:name', record({ success: true, message: 'Deleted' })),
    http.get('/api/v1/local-backup/backups/:name/download', () => new HttpResponse('zip', { headers: { 'content-disposition': `attachment; filename="${backupFile}"` } })),
    http.get('/api/v1/settings/backup', () => new HttpResponse('zip', { headers: { 'content-disposition': 'attachment; filename="full.zip"' } })),
    http.post('/api/v1/settings/restore', record({ success: true, message: 'Restored from upload' })),
  );
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});

const fileRow = () => screen.getByText(backupFile).closest('div.flex, tr, li') as HTMLElement;
const paths = () => calls.map((c) => `${c.method} ${c.path}`);

describe('local backups', () => {
  it('downloads a complete backup', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const user = userEvent.setup();
    render(<GitHubBackupSettings />);

    const downloads = await screen.findAllByRole('button', { name: /^Download$/ });
    await user.click(downloads[0]);

    expect(await screen.findByText('Backup downloaded successfully')).toBeInTheDocument();
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });

  it('reports a failed full backup', async () => {
    server.use(http.get('/api/v1/settings/backup', () => HttpResponse.json({ detail: 'Disk full' }, { status: 500 })));
    const user = userEvent.setup();
    render(<GitHubBackupSettings />);

    await user.click((await screen.findAllByRole('button', { name: /^Download$/ }))[0]);

    expect(await screen.findByText(/Failed to create backup:/)).toBeInTheDocument();
  });

  it('restores from an uploaded backup after confirming', async () => {
    const user = userEvent.setup();
    render(<GitHubBackupSettings />);
    await screen.findByText(backupFile);

    const input = document.querySelector('input[type="file"][accept=".zip"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['PK'], 'upload.zip', { type: 'application/zip' })] } });
    expect(await screen.findByText(/upload\.zip/)).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Restore Backup' }).pop()!);

    await waitFor(() => expect(paths()).toContain('POST /api/v1/settings/restore'));
    expect(await screen.findByText('Backup restored. Please restart Grove Control.')).toBeInTheDocument();
  });

  it('runs a scheduled backup now', async () => {
    const user = userEvent.setup();
    render(<GitHubBackupSettings />);

    await user.click(await screen.findByRole('button', { name: /Run Now/ }));

    await waitFor(() => expect(paths()).toContain('POST /api/v1/local-backup/run'));
    expect(await screen.findByText('Backup completed successfully')).toBeInTheDocument();
  });

  it('reports a scheduled backup that fails', async () => {
    server.use(http.post('/api/v1/local-backup/run', () => HttpResponse.json({ success: false, message: 'Path not writable' })));
    const user = userEvent.setup();
    render(<GitHubBackupSettings />);

    await user.click(await screen.findByRole('button', { name: /Run Now/ }));

    expect(await screen.findByText('Path not writable')).toBeInTheDocument();
  });

  it('downloads, restores and deletes a stored backup', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const user = userEvent.setup();
    render(<GitHubBackupSettings />);
    await screen.findByText(backupFile);

    await user.click(within(fileRow()).getByTitle('Download'));
    await waitFor(() => expect(click).toHaveBeenCalled());
    click.mockRestore();

    await user.click(within(fileRow()).getByTitle('Restore'));
    await user.click(screen.getAllByRole('button', { name: 'Restore Backup' }).pop()!);
    await waitFor(() => expect(paths()).toContain(`POST /api/v1/local-backup/backups/${backupFile}/restore`));
    expect(await screen.findByText('Restored')).toBeInTheDocument();

    await user.click(within(fileRow()).getByTitle('Delete'));
    await user.click(screen.getAllByRole('button', { name: 'Delete' }).pop()!);
    await waitFor(() => expect(paths()).toContain(`DELETE /api/v1/local-backup/backups/${backupFile}`));
  });

  it('reports a failed stored restore', async () => {
    server.use(http.post('/api/v1/local-backup/backups/:name/restore', () => HttpResponse.json({ success: false, message: 'Corrupt archive' })));
    const user = userEvent.setup();
    render(<GitHubBackupSettings />);
    await screen.findByText(backupFile);

    await user.click(within(fileRow()).getByTitle('Restore'));
    await user.click(screen.getAllByRole('button', { name: 'Restore Backup' }).pop()!);

    expect((await screen.findAllByText('Corrupt archive')).length).toBeGreaterThan(0);
  });

  it('saves schedule, time, retention and path', async () => {
    const user = userEvent.setup();
    render(<GitHubBackupSettings />);
    await screen.findByText('Frequency');

    const frequency = screen.getByText('Frequency').parentElement!.querySelector('[role="combobox"]') as HTMLElement;
    await user.click(frequency);
    await user.click(await screen.findByRole('option', { name: 'Weekly' }));
    await waitFor(() => expect(calls.some((c) => (c.body as Record<string, unknown>)?.local_backup_schedule === 'weekly')).toBe(true));

    const time = screen.getByDisplayValue('03:00');
    fireEvent.change(time, { target: { value: '04:30' } });
    fireEvent.blur(time);
    await waitFor(() => expect(calls.some((c) => (c.body as Record<string, unknown>)?.local_backup_time === '04:30')).toBe(true));

    const retention = screen.getByDisplayValue('5');
    fireEvent.change(retention, { target: { value: '9' } });
    fireEvent.blur(retention);
    await waitFor(() => expect(calls.some((c) => (c.body as Record<string, unknown>)?.local_backup_retention === 9)).toBe(true));

    const path = screen.getByText('Output Path').parentElement!.querySelector('input') as HTMLInputElement;
    await user.type(path, '/mnt/nas{Enter}');
    await waitFor(() => expect(calls.some((c) => (c.body as Record<string, unknown>)?.local_backup_path === '/mnt/nas')).toBe(true));
    expect((await screen.findAllByText('Settings saved')).length).toBeGreaterThan(0);
  });
});
