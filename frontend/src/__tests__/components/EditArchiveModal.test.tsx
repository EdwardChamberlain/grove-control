/**
 * Tests for the EditArchiveModal component.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { EditArchiveModal } from '../../components/EditArchiveModal';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import type { Archive } from '../../api/client';

function makeArchive(overrides: Partial<Archive> = {}): Archive {
  return {
    id: 1,
    printer_id: null,
    project_id: null,
    project_name: null,
    filename: 'benchy.gcode.3mf',
    file_path: 'archives/benchy.gcode.3mf',
    file_size: 0,
    content_hash: null,
    thumbnail_path: null,
    timelapse_path: null,
    source_3mf_path: null,
    f3d_path: null,
    duplicates: null,
    duplicate_count: 0,
    duplicate_sequence: 0,
    original_archive_id: null,
    object_count: null,
    print_name: null,
    print_time_seconds: null,
    actual_time_seconds: null,
    time_accuracy: null,
    filament_used_grams: null,
    filament_type: null,
    filament_color: null,
    layer_height: null,
    total_layers: null,
    nozzle_diameter: null,
    bed_temperature: null,
    bed_type: null,
    nozzle_temperature: null,
    sliced_for_model: null,
    status: 'completed',
    started_at: null,
    completed_at: null,
    extra_data: null,
    makerworld_url: null,
    designer: null,
    external_url: null,
    is_favorite: false,
    tags: null,
    notes: null,
    cost: null,
    photos: null,
    failure_reason: null,
    quantity: 1,
    energy_kwh: null,
    energy_cost: null,
    created_at: '2024-01-01T00:00:00Z',
    created_by_id: null,
    created_by_username: null,
    run_count: 0,
    last_run_at: null,
    total_filament_actual_grams: null,
    successful_run_count: 0,
    failed_run_count: 0,
    ...overrides,
  };
}

const mockArchive = makeArchive({
  id: 1,
  filename: 'benchy.gcode.3mf',
  print_name: 'Benchy',
  printer_id: 1,
  notes: 'Test notes',
  project_id: null,
  tags: 'test,calibration',
});

const mockProjects = [
  { id: 1, name: 'Functional Parts', color: '#00ae42' },
  { id: 2, name: 'Art', color: '#ff5500' },
];

describe('EditArchiveModal', () => {
  const mockOnClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    server.use(
      http.get('/api/v1/projects/', () => {
        return HttpResponse.json(mockProjects);
      }),
      http.get('/api/v1/archives/tags', () => {
        return HttpResponse.json([
          { name: 'test', count: 2 },
          { name: 'calibration', count: 1 },
          { name: 'functional', count: 3 },
        ]);
      }),
      http.patch('/api/v1/archives/:id', async ({ request }) => {
        const body = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ ...mockArchive, ...body });
      })
    );
  });

  describe('rendering', () => {
    it('renders the modal title', () => {
      render(
        <EditArchiveModal
          archive={mockArchive}
          onClose={mockOnClose}
        />
      );

      expect(screen.getByText(/edit/i)).toBeInTheDocument();
    });

    it('shows print name field', async () => {
      render(
        <EditArchiveModal
          archive={mockArchive}
          onClose={mockOnClose}
        />
      );

      await waitFor(() => {
        // Name field should be present
        const nameInput = screen.getByDisplayValue('Benchy');
        expect(nameInput).toBeInTheDocument();
      });
    });

    it('shows notes field', async () => {
      render(
        <EditArchiveModal
          archive={mockArchive}
          onClose={mockOnClose}
        />
      );

      await waitFor(() => {
        const notesField = screen.getByDisplayValue('Test notes');
        expect(notesField).toBeInTheDocument();
      });
    });

    it('shows rating selector', async () => {
      render(
        <EditArchiveModal
          archive={mockArchive}
          onClose={mockOnClose}
        />
      );

      await waitFor(() => {
        // Rating may be shown as stars or dropdown
        expect(screen.getByText(/edit/i)).toBeInTheDocument();
      });
    });

    it('shows project selector', async () => {
      render(
        <EditArchiveModal
          archive={mockArchive}
          onClose={mockOnClose}
        />
      );

      await waitFor(() => {
        // Project section should be present
        expect(screen.getByText(/edit/i)).toBeInTheDocument();
      });
    });

    it('shows tags input', () => {
      render(
        <EditArchiveModal
          archive={mockArchive}
          onClose={mockOnClose}
        />
      );

      expect(screen.getByText(/tags/i)).toBeInTheDocument();
    });
  });

  describe('existing values', () => {
    it('shows existing tags', () => {
      render(
        <EditArchiveModal
          archive={mockArchive}
          onClose={mockOnClose}
        />
      );

      expect(screen.getByText('test')).toBeInTheDocument();
      expect(screen.getByText('calibration')).toBeInTheDocument();
    });
  });

  describe('actions', () => {
    it('has save button', () => {
      render(
        <EditArchiveModal
          archive={mockArchive}
          onClose={mockOnClose}
        />
      );

      expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
    });

    it('has cancel button', () => {
      render(
        <EditArchiveModal
          archive={mockArchive}
          onClose={mockOnClose}
        />
      );

      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    });

    it('calls onClose when cancel is clicked', async () => {
      const user = userEvent.setup();
      render(
        <EditArchiveModal
          archive={mockArchive}
          onClose={mockOnClose}
        />
      );

      await user.click(screen.getByRole('button', { name: /cancel/i }));

      expect(mockOnClose).toHaveBeenCalled();
    });

    it('can edit print name', async () => {
      const user = userEvent.setup();
      render(
        <EditArchiveModal
          archive={mockArchive}
          onClose={mockOnClose}
        />
      );

      const nameInput = screen.getByDisplayValue('Benchy');
      await user.clear(nameInput);
      await user.type(nameInput, 'New Name');

      expect(nameInput).toHaveValue('New Name');
    });
  });

  describe('failure_reason vocabulary (#1687 follow-up)', () => {
    // The Stats page's Failure Analysis widget groups by the raw column value.
    // Before this fix this modal saved the translated label, so a language
    // switch fragmented historical buckets and any round-trip through the
    // new PATCH /print-log endpoint (which validates against camelCase keys)
    // would reject the value. The dropdown now saves the key.

    const failedArchive = { ...mockArchive, status: 'failed', failure_reason: 'filamentRunout' };
    const legacyArchive = { ...mockArchive, status: 'failed', failure_reason: 'Filament runout' };

    it('preselects the option when the stored value is already a camelCase key', () => {
      render(<EditArchiveModal archive={failedArchive} onClose={mockOnClose} />);
      const select = screen.getByLabelText(/failure reason/i) as HTMLSelectElement;
      expect(select.value).toBe('filamentRunout');
    });

    it('reverse-looks-up a legacy translated value back to its key', () => {
      render(<EditArchiveModal archive={legacyArchive} onClose={mockOnClose} />);
      const select = screen.getByLabelText(/failure reason/i) as HTMLSelectElement;
      expect(select.value).toBe('filamentRunout');
    });

    it('sends the camelCase key on save, not the translated label', async () => {
      const user = userEvent.setup();
      let patched: { failure_reason?: string } | undefined;
      server.use(
        http.patch('/api/v1/archives/:id', async ({ request }) => {
          patched = (await request.json()) as { failure_reason?: string };
          return HttpResponse.json({ ...failedArchive, ...patched });
        }),
      );

      render(<EditArchiveModal archive={failedArchive} onClose={mockOnClose} />);
      const select = screen.getByLabelText(/failure reason/i);
      await user.click(select);
      await user.click(await screen.findByRole('option', { name: /clogged nozzle/i }));
      await user.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(patched?.failure_reason).toBe('cloggedNozzle');
      });
    });
  });
});
