/**
 * Tests for the Library Trash page (#1008).
 *
 * Covers: empty-trash view, populated table with file/folder/size columns,
 * restore round-trip (invalidates list), purge-now with confirmation dialog,
 * empty-trash bulk action, and the admin-only retention setting control.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { LibraryTrashPage } from '../../pages/LibraryTrashPage';

function trashItem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    filename: 'old_benchy.3mf',
    file_size: 204800,
    thumbnail_path: null,
    folder_id: null,
    folder_name: 'Calibration',
    created_by_id: 1,
    created_by_username: 'alice',
    deleted_at: '2026-04-10T12:00:00Z',
    auto_purge_at: '2026-05-10T12:00:00Z',
    ...overrides,
  };
}

afterEach(() => server.resetHandlers());

describe('LibraryTrashPage', () => {
  it('shows the empty state when there are no trashed files', async () => {
    server.use(
      http.get('*/library/trash', () =>
        HttpResponse.json({ items: [], total: 0, retention_days: 30 }),
      ),
      http.get('*/library/trash/settings', () =>
        HttpResponse.json({ retention_days: 30 }),
      ),
    );

    render(<LibraryTrashPage />);

    expect(await screen.findByText(/trash is empty/i)).toBeInTheDocument();
  });

  it('renders trashed files and the retention control for admins', async () => {
    server.use(
      http.get('*/library/trash', () =>
        HttpResponse.json({
          items: [trashItem(), trashItem({ id: 2, filename: 'old_calibration.3mf', file_size: 102400 })],
          total: 2,
          retention_days: 30,
        }),
      ),
      http.get('*/library/trash/settings', () =>
        HttpResponse.json({ retention_days: 30 }),
      ),
    );

    render(<LibraryTrashPage />);

    expect(await screen.findByText('old_benchy.3mf')).toBeInTheDocument();
    expect(screen.getByText('old_calibration.3mf')).toBeInTheDocument();
    // Retention input is visible when auth is off (isAdmin=true in tests)
    expect(screen.getByLabelText(/auto-delete after/i)).toBeInTheDocument();
  });

  it('restores a file when Restore is clicked', async () => {
    let restoreCalledFor: number | null = null;
    server.use(
      http.get('*/library/trash', () =>
        HttpResponse.json({ items: [trashItem()], total: 1, retention_days: 30 }),
      ),
      http.get('*/library/trash/settings', () =>
        HttpResponse.json({ retention_days: 30 }),
      ),
      http.post('*/library/trash/:id/restore', ({ params }) => {
        restoreCalledFor = Number(params.id);
        return HttpResponse.json({ status: 'success', id: Number(params.id) });
      }),
    );

    render(<LibraryTrashPage />);

    await screen.findByText('old_benchy.3mf');
    await userEvent.click(screen.getByRole('button', { name: /restore/i }));

    await waitFor(() => expect(restoreCalledFor).toBe(1));
  });

  it('prompts before permanently deleting a single file', async () => {
    let deleteCalledFor: number | null = null;
    server.use(
      http.get('*/library/trash', () =>
        HttpResponse.json({ items: [trashItem()], total: 1, retention_days: 30 }),
      ),
      http.get('*/library/trash/settings', () =>
        HttpResponse.json({ retention_days: 30 }),
      ),
      http.delete('*/library/trash/:id', ({ params }) => {
        deleteCalledFor = Number(params.id);
        return HttpResponse.json({ status: 'success' });
      }),
    );

    render(<LibraryTrashPage />);

    await screen.findByText('old_benchy.3mf');
    await userEvent.click(screen.getByRole('button', { name: /delete now/i }));

    // ConfirmModal opens. The modal's title is unique; the body repeats the filename.
    expect(await screen.findByRole('heading', { name: /delete permanently/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /delete permanently/i }));
    await waitFor(() => expect(deleteCalledFor).toBe(1));
  });

  it('empties the trash via the Empty Trash action', async () => {
    let emptyCalled = false;
    server.use(
      http.get('*/library/trash', () =>
        HttpResponse.json({
          items: [trashItem(), trashItem({ id: 2, filename: 'two.3mf' })],
          total: 2,
          retention_days: 30,
        }),
      ),
      http.get('*/library/trash/settings', () =>
        HttpResponse.json({ retention_days: 30 }),
      ),
      http.delete('*/library/trash', () => {
        emptyCalled = true;
        return HttpResponse.json({ deleted: 2 });
      }),
    );

    render(<LibraryTrashPage />);

    await screen.findByText('old_benchy.3mf');
    await userEvent.click(screen.getByRole('button', { name: /empty trash/i }));
    await userEvent.click(screen.getByRole('button', { name: /delete permanently/i }));

    await waitFor(() => expect(emptyCalled).toBe(true));
  });
  describe('multi-select', () => {
    function useTwoItems(extra: Parameters<typeof server.use> = []) {
      server.use(
        http.get('*/library/trash', () =>
          HttpResponse.json({
            items: [trashItem(), trashItem({ id: 2, filename: 'two.3mf' })],
            total: 2,
            retention_days: 30,
          }),
        ),
        http.get('*/library/trash/settings', () =>
          HttpResponse.json({ retention_days: 30 }),
        ),
        ...extra,
      );
    }

    it('shows no checkboxes or action bar until select mode is turned on', async () => {
      useTwoItems();
      render(<LibraryTrashPage />);

      await screen.findByText('old_benchy.3mf');
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
      expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument();

      await userEvent.click(screen.getByTestId('select-mode-toggle'));

      expect(screen.getAllByRole('checkbox')).toHaveLength(2);
      expect(screen.getByText('0 selected')).toBeInTheDocument();
    });

    it('selects every file and restores them from the bar', async () => {
      const restored: number[] = [];
      useTwoItems([
        http.post('*/library/trash/:id/restore', ({ params }) => {
          restored.push(Number(params.id));
          return HttpResponse.json({ status: 'success', id: Number(params.id) });
        }),
      ]);
      render(<LibraryTrashPage />);

      await screen.findByText('old_benchy.3mf');
      await userEvent.click(screen.getByTestId('select-mode-toggle'));
      await userEvent.click(screen.getByRole('button', { name: 'Select all' }));
      expect(screen.getByText('2 selected')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Restore selected' }));

      await waitFor(() => expect(restored.sort()).toEqual([1, 2]));
      await waitFor(() => expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument());
    });

    it('selects a file from its checkbox and permanently deletes the selection', async () => {
      const purged: number[] = [];
      useTwoItems([
        http.delete('*/library/trash/:id', ({ params }) => {
          purged.push(Number(params.id));
          return HttpResponse.json({ status: 'success' });
        }),
      ]);
      render(<LibraryTrashPage />);

      await screen.findByText('old_benchy.3mf');
      await userEvent.click(screen.getByTestId('select-mode-toggle'));
      await userEvent.click(screen.getByRole('checkbox', { name: 'Select two.3mf' }));
      expect(screen.getByText('1 selected')).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'Delete selected' }));
      await userEvent.click(await screen.findByRole('button', { name: /delete permanently/i }));

      await waitFor(() => expect(purged).toEqual([2]));
      await waitFor(() => expect(screen.queryByTestId('selection-bar')).not.toBeInTheDocument());
    });

    it('keeps a row action button from also toggling that row', async () => {
      const restored: number[] = [];
      useTwoItems([
        http.post('*/library/trash/:id/restore', ({ params }) => {
          restored.push(Number(params.id));
          return HttpResponse.json({ status: 'success', id: Number(params.id) });
        }),
      ]);
      render(<LibraryTrashPage />);

      await screen.findByText('old_benchy.3mf');
      await userEvent.click(screen.getByTestId('select-mode-toggle'));
      await userEvent.click(screen.getAllByRole('button', { name: 'Restore' })[1]);

      await waitFor(() => expect(restored).toEqual([2]));
      expect(screen.getByText('0 selected')).toBeInTheDocument();
    });

    it('selects a row by clicking it and confirms before deleting the selection', async () => {
      useTwoItems();
      render(<LibraryTrashPage />);

      await screen.findByText('old_benchy.3mf');
      await userEvent.click(screen.getByTestId('select-mode-toggle'));
      await userEvent.click(screen.getByText('two.3mf'));
      expect(screen.getByText('1 selected')).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'Delete selected' }));
      expect(await screen.findByText(/selected files will be deleted/i)).toBeInTheDocument();
    });
  });
});
