/**
 * FolderPickerModal: choose the Files root or a folder; nothing happens until
 * confirm, and read-only external folders can't be picked.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { FolderPickerModal } from '../../components/FolderPickerModal';

const folder = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  parent_id: null,
  project_id: null,
  archive_id: null,
  project_name: null,
  archive_name: null,
  is_external: false,
  external_path: null,
  external_readonly: false,
  file_count: 0,
  latest_activity_at: null,
  children: [],
  is_system: false,
  ...extra,
});

function setup(props: { currentFolderId?: number | null } = {}) {
  server.use(
    http.get('/api/v1/library/folders', () =>
      HttpResponse.json([
        folder(1, 'Parent', { children: [folder(2, 'Child', { parent_id: 1 })] }),
        folder(3, 'Mounted', { is_external: true, external_readonly: true }),
        folder(4, 'Temporary', { is_system: true }),
      ]),
    ),
  );
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  render(<FolderPickerModal title="Pick one" confirmLabel="Go" onConfirm={onConfirm} onClose={onClose} {...props} />);
  return { onConfirm, onClose };
}

describe('FolderPickerModal', () => {
  it('confirms the root by default', async () => {
    const { onConfirm } = setup();
    await screen.findByText('Parent');

    fireEvent.click(screen.getByRole('button', { name: 'Go' }));

    expect(onConfirm).toHaveBeenCalledWith(null);
  });

  it('confirms a nested folder', async () => {
    const { onConfirm } = setup();

    fireEvent.click(await screen.findByText('Child'));
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));

    expect(onConfirm).toHaveBeenCalledWith(2);
  });

  it('does not allow picking a read-only external folder', async () => {
    const { onConfirm } = setup();
    const mounted = (await screen.findByText('Mounted')).closest('button')!;

    expect(mounted).toBeDisabled();
    fireEvent.click(mounted);
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));

    expect(onConfirm).toHaveBeenCalledWith(null);
  });

  it('hides system folders', async () => {
    setup();
    await screen.findByText('Parent');

    expect(screen.queryByText('Temporary')).toBeNull();
  });

  it('does not offer the folder the item is already in', async () => {
    const { onConfirm } = setup({ currentFolderId: 1 });
    const parent = (await screen.findByText('Parent')).closest('button')!;

    expect(parent).toBeDisabled();
    expect(parent).toHaveTextContent('(current)');
    fireEvent.click(parent);
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onConfirm).toHaveBeenCalledWith(null);
  });

  it('closes without confirming on cancel', async () => {
    const { onConfirm, onClose } = setup();
    await waitFor(() => expect(screen.getByText('Parent')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
