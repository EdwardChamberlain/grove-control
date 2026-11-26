/**
 * Tests for the MaintenancePage component.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '../utils';
import { MaintenancePage } from '../../pages/MaintenancePage';
import { setAuthToken } from '../../api/client';
import { delay, http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const mockPrinters = [
  {
    id: 1,
    name: 'X1 Carbon',
    model: 'X1C',
    serial_number: '00M09A350100001',
  },
];

const mockMaintenanceTypes = [
  {
    id: 1,
    name: 'Clean Nozzle',
    description: 'Clean the printer nozzle',
    default_interval_hours: 50,
    applies_to_models: ['X1C', 'P1S'],
  },
  {
    id: 2,
    name: 'Lubricate Rods',
    description: 'Lubricate linear rods',
    default_interval_hours: 200,
    applies_to_models: ['X1C', 'P1S'],
  },
];

const mockMaintenanceTasks = [
  {
    id: 1,
    printer_id: 1,
    maintenance_type_id: 1,
    maintenance_type_name: 'Clean Nozzle',
    interval_hours: 50,
    last_completed_at: '2024-01-01T00:00:00Z',
    next_due_at: '2024-01-03T00:00:00Z',
    hours_until_due: 10,
    is_due: false,
    notes: null,
  },
  {
    id: 2,
    printer_id: 1,
    maintenance_type_id: 2,
    maintenance_type_name: 'Lubricate Rods',
    interval_hours: 200,
    last_completed_at: '2023-12-01T00:00:00Z',
    next_due_at: '2023-12-15T00:00:00Z',
    hours_until_due: -100,
    is_due: true,
    notes: 'Use PTFE lubricant',
  },
];

const mockScheduledLogEntry = {
  id: 1,
  printer_id: 1,
  printer_name: 'X1 Carbon',
  entry_type: 'scheduled' as const,
  title: 'Clean Nozzle',
  notes: 'Completed as scheduled',
  occurred_at: '2024-01-02T10:00:00Z',
  hours_at_maintenance: 100,
  created_by_id: null,
  created_by_username: null,
  updated_by_id: null,
  updated_by_username: null,
  created_at: '2024-01-02T10:00:00Z',
  updated_at: '2024-01-02T10:00:00Z',
};

const mockManualLogEntry = {
  id: 2,
  printer_id: 1,
  printer_name: 'X1 Carbon',
  entry_type: 'manual' as const,
  title: 'Replaced extruder',
  notes: 'Swapped the worn part',
  occurred_at: '2024-01-03T10:00:00Z',
  hours_at_maintenance: 120,
  created_by_id: 7,
  created_by_username: 'alice',
  updated_by_id: 7,
  updated_by_username: 'alice',
  created_at: '2024-01-03T10:00:00Z',
  updated_at: '2024-01-03T10:00:00Z',
};

describe('MaintenancePage', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/v1/printers/', () => {
        return HttpResponse.json(mockPrinters);
      }),
      http.get('/api/v1/maintenance/types', () => {
        return HttpResponse.json(mockMaintenanceTypes);
      }),
      http.get('/api/v1/maintenance/', () => {
        return HttpResponse.json(mockMaintenanceTasks);
      }),
      http.get('/api/v1/maintenance/overview', () => {
        // Overview is an array of printer summaries
        return HttpResponse.json([
          {
            printer_id: 1,
            printer_name: 'X1 Carbon',
            due_count: 1,
            warning_count: 0,
            total_print_hours: 100,
            maintenance_items: [
              {
                id: 1,
                maintenance_type_id: 1,
                maintenance_type_name: 'Clean Nozzle',
                interval_hours: 50,
                hours_since_last: 45,
                hours_until_due: 5,
                is_due: false,
                is_warning: false,
              },
              {
                id: 2,
                maintenance_type_id: 2,
                maintenance_type_name: 'Lubricate Rods',
                interval_hours: 200,
                hours_since_last: 250,
                hours_until_due: -50,
                is_due: true,
                is_warning: false,
              },
            ],
          },
        ]);
      }),
      http.get('/api/v1/maintenance/logs', () => {
        return HttpResponse.json({
          items: [mockScheduledLogEntry],
          next_cursor: null,
        });
      }),
      http.post('/api/v1/maintenance/', async ({ request }) => {
        const body = await request.json() as { name: string };
        return HttpResponse.json({ id: 3, ...body });
      }),
      http.post('/api/v1/maintenance/:id/complete', () => {
        return HttpResponse.json({ success: true });
      })
    );
  });

  describe('rendering', () => {
    it('renders the page title', async () => {
      render(<MaintenancePage />);

      await waitFor(() => {
        expect(screen.getByText('Maintenance')).toBeInTheDocument();
      });
    });

    it('renders maintenance page content', async () => {
      render(<MaintenancePage />);

      await waitFor(() => {
        // Page should render with printer tabs or tasks
        expect(screen.getByText('Maintenance')).toBeInTheDocument();
      });
    });
  });

  describe('printer tabs', () => {
    it('shows printer tabs when printers exist', async () => {
      render(<MaintenancePage />);

      await waitFor(() => {
        // Should show printer name in tabs
        expect(screen.getByText('X1 Carbon')).toBeInTheDocument();
      });
    });
  });

  describe('maintenance log', () => {
    it('shows scheduled history as a read-only fleet log entry', async () => {
      render(<MaintenancePage />);

      fireEvent.click(await screen.findByText('Log'));

      expect(await screen.findByText('Clean Nozzle')).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: 'Filter by printer' })).toBeInTheDocument();
      expect(screen.getByRole('group', { name: 'Filter by type' })).toBeInTheDocument();
      expect(screen.getByText('Completed as scheduled')).toBeInTheDocument();
      expect(screen.getByText('X1 Carbon', { selector: 'div' })).toBeInTheDocument();
      expect(screen.getByText('Scheduled', { selector: 'span' })).toBeInTheDocument();
      expect(screen.queryByLabelText('Edit')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Delete')).not.toBeInTheDocument();
    });

    it('lists entries newest first under a heading for each month', async () => {
      server.use(
        http.get('/api/v1/maintenance/logs', () =>
          HttpResponse.json({
            items: [
              { ...mockManualLogEntry, id: 5, title: 'Fan replaced', occurred_at: '2024-02-10T10:00:00Z', notes: null, hours_at_maintenance: null },
              mockManualLogEntry,
              mockScheduledLogEntry,
            ],
            next_cursor: null,
          })),
      );

      render(<MaintenancePage />);
      fireEvent.click(await screen.findByText('Log'));

      const february = await screen.findByRole('region', { name: /February/ });
      const january = screen.getByRole('region', { name: /January/ });
      expect(february).toHaveTextContent('Fan replaced');
      expect(february).toHaveTextContent('1 entry');
      expect(january).toHaveTextContent('Replaced extruder');
      expect(january).toHaveTextContent('Clean Nozzle');
      expect(january).toHaveTextContent('2 entries');
      expect(screen.getByText('Recorded at')).toBeInTheDocument();
      expect(screen.getByText('120.0h')).toBeInTheDocument();
    });

    it('uses the shared React dropdown for the log printer field', async () => {
      render(<MaintenancePage />);

      fireEvent.click(await screen.findByText('Log'));
      fireEvent.click(await screen.findByRole('button', { name: 'Add log entry' }));

      expect(screen.getByRole('combobox', { name: 'Printer' })).toBeInTheDocument();
    });

    it('uses the owned calendar date picker for the occurrence time', async () => {
      render(<MaintenancePage />);

      fireEvent.click(await screen.findByText('Log'));
      fireEvent.click(await screen.findByRole('button', { name: 'Add log entry' }));

      expect(screen.getByLabelText('Occurred at', { selector: 'input[type="text"]' })).toHaveAttribute('type', 'text');
      fireEvent.click(screen.getByTitle('Open calendar'));

      const datePicker = screen.getByRole('dialog', { name: 'Choose date' });
      expect(datePicker).toBeInTheDocument();
      expect(datePicker.querySelector('[role="grid"]')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(screen.queryByRole('dialog', { name: 'Choose date' })).not.toBeInTheDocument();
    });

    it('uses the saved date format in the occurrence picker', async () => {
      server.use(
        http.get('/api/v1/settings/ui-preferences', () =>
          HttpResponse.json({ date_format: 'eu' })),
      );

      render(<MaintenancePage />);

      fireEvent.click(await screen.findByText('Log'));
      fireEvent.click(await screen.findByRole('button', { name: 'Add log entry' }));

      expect(await screen.findByPlaceholderText('DD/MM/YYYY')).toBeInTheDocument();
    });

    it('creates a manual entry and filters the log by entry type', async () => {
      let entries = [mockScheduledLogEntry, mockManualLogEntry];
      let createRequest: Record<string, unknown> | undefined;

      server.use(
        http.get('/api/v1/maintenance/logs', ({ request }) => {
          const entryType = new URL(request.url).searchParams.get('entry_type');
          const filteredEntries = entryType
            ? entries.filter((entry) => entry.entry_type === entryType)
            : entries;
          return HttpResponse.json({ items: filteredEntries, next_cursor: null });
        }),
        http.post('/api/v1/maintenance/logs', async ({ request }) => {
          createRequest = await request.json() as Record<string, unknown>;
          const created = {
            ...mockManualLogEntry,
            id: 3,
            // The mock server echoes the posted JSON body back as the new entry.
            title: createRequest.title as string,
            notes: createRequest.notes as string,
            occurred_at: createRequest.occurred_at as string,
            hours_at_maintenance: createRequest.hours_at_maintenance as number,
          };
          entries = [created, ...entries];
          return HttpResponse.json(created, { status: 201 });
        }),
      );

      render(<MaintenancePage />);
      fireEvent.click(await screen.findByText('Log'));
      fireEvent.click(await screen.findByRole('button', { name: 'Add log entry' }));
      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Bearing replaced' } });
      fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Replaced during inspection' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save log entry' }));

      await waitFor(() => expect(createRequest).toMatchObject({
        printer_id: 1,
        title: 'Bearing replaced',
        notes: 'Replaced during inspection',
      }));
      expect(screen.queryByRole('button', { name: 'Save log entry' })).not.toBeInTheDocument();

      expect(screen.getByRole('button', { name: 'All entries' })).toHaveAttribute('aria-pressed', 'true');
      fireEvent.click(screen.getByRole('button', { name: 'Unscheduled' }));
      expect(screen.getByRole('button', { name: 'Unscheduled' })).toHaveAttribute('aria-pressed', 'true');

      await waitFor(() => {
        expect(screen.getByText('Bearing replaced')).toBeInTheDocument();
        expect(screen.queryByText('Clean Nozzle')).not.toBeInTheDocument();
      });
    });

    it('edits and permanently deletes manual entries while showing attribution', async () => {
      let entries = [mockScheduledLogEntry, mockManualLogEntry];
      let updateRequest: Record<string, unknown> | undefined;
      let deletedId: string | undefined;

      server.use(
        http.get('/api/v1/maintenance/logs', () =>
          HttpResponse.json({ items: entries, next_cursor: null })),
        http.patch('/api/v1/maintenance/logs/:id', async ({ params, request }) => {
          updateRequest = await request.json() as Record<string, unknown>;
          const updated = {
            ...mockManualLogEntry,
            ...updateRequest,
            id: Number(params.id),
            updated_by_username: 'bob',
            updated_at: '2024-01-04T10:00:00Z',
          };
          entries = entries.map((entry) => entry.id === updated.id ? updated : entry);
          return HttpResponse.json(updated);
        }),
        http.delete('/api/v1/maintenance/logs/:id', ({ params }) => {
          deletedId = String(params.id);
          entries = entries.filter((entry) => entry.id !== Number(params.id));
          return HttpResponse.json({ status: 'deleted' });
        }),
      );

      render(<MaintenancePage />);
      fireEvent.click(await screen.findByText('Log'));
      const recordedBy = await screen.findByText('alice');
      expect(recordedBy).toHaveAttribute('title', 'Recorded by alice');
      expect(screen.getByLabelText('Edit')).toBeInTheDocument();
      expect(screen.getByLabelText('Delete')).toBeInTheDocument();

      fireEvent.click(screen.getByLabelText('Edit'));
      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Extruder replaced' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save log entry' }));
      await waitFor(() => expect(updateRequest).toMatchObject({ title: 'Extruder replaced' }));
      expect(await screen.findByText('Extruder replaced')).toBeInTheDocument();

      fireEvent.click(screen.getByLabelText('Delete'));
      expect(await screen.findByText('Delete maintenance log entry?')).toBeInTheDocument();
      const deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
      fireEvent.click(deleteButtons[deleteButtons.length - 1]);
      await waitFor(() => expect(deletedId).toBe('2'));
    });

    it('shows a spinner on Save log entry while the entry is being saved', async () => {
      server.use(
        http.post('/api/v1/maintenance/logs', async () => {
          await delay('infinite');
          return HttpResponse.json(mockManualLogEntry, { status: 201 });
        }),
      );

      render(<MaintenancePage />);
      fireEvent.click(await screen.findByText('Log'));
      fireEvent.click(await screen.findByRole('button', { name: 'Add log entry' }));
      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Bearing replaced' } });
      const save = screen.getByRole('button', { name: 'Save log entry' });
      fireEvent.click(save);

      await waitFor(() => expect(save.querySelector('.spinner')).not.toBeNull());
      expect(save).toBeDisabled();
    });

    it('shows a spinner on Load more while the next page is fetched', async () => {
      server.use(
        http.get('/api/v1/maintenance/logs', async ({ request }) => {
          if (new URL(request.url).searchParams.get('cursor')) {
            await delay('infinite');
          }
          return HttpResponse.json({ items: [mockScheduledLogEntry], next_cursor: 'page-2' });
        }),
      );

      render(<MaintenancePage />);
      fireEvent.click(await screen.findByText('Log'));
      const loadMore = await screen.findByRole('button', { name: 'Load more' });
      fireEvent.click(loadMore);

      await waitFor(() => expect(loadMore.querySelector('.spinner')).not.toBeNull());
      expect(loadMore).toBeDisabled();
    });
  });

  describe('maintenance mode control', () => {
    const overviewFor = (isActive: boolean) =>
      http.get('/api/v1/maintenance/overview', () =>
        HttpResponse.json([
          {
            printer_id: 1,
            printer_name: 'X1 Carbon',
            printer_model: 'X1C',
            is_active: isActive,
            due_count: 0,
            warning_count: 0,
            total_print_hours: 100,
            total_print_jobs: 3,
            total_filament_changes: 1,
            maintenance_items: [],
          },
        ]),
      );

    const openPrinter = async () => {
      render(<MaintenancePage />);
      fireEvent.click(await screen.findByRole('button', { name: /X1 Carbon/ }));
    };

    it('puts an idle printer into maintenance mode, left of Log a repair', async () => {
      let body: unknown = null;
      server.use(
        overviewFor(true),
        http.get('/api/v1/printers/1/status', () => HttpResponse.json({ connected: true, state: 'IDLE' })),
        http.patch('/api/v1/printers/1', async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({ id: 1 });
        }),
      );
      await openPrinter();

      const enter = await screen.findByRole('button', { name: 'Enter maintenance mode' });
      const repair = screen.getByRole('button', { name: 'Log a repair' });
      expect(enter.compareDocumentPosition(repair) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      fireEvent.click(enter);
      await waitFor(() => expect(body).toEqual({ is_active: false }));
    });

    it('offers to exit when the printer is already in maintenance mode', async () => {
      let body: unknown = null;
      server.use(
        overviewFor(false),
        http.patch('/api/v1/printers/1', async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({ id: 1 });
        }),
      );
      await openPrinter();

      expect(screen.queryByRole('button', { name: 'Enter maintenance mode' })).not.toBeInTheDocument();
      fireEvent.click(await screen.findByRole('button', { name: 'Exit maintenance mode' }));
      await waitFor(() => expect(body).toEqual({ is_active: true }));
    });

    it('still toggles when the status is unavailable and no printing state is known', async () => {
      let body: unknown = null;
      server.use(
        overviewFor(true),
        http.get('/api/v1/printers/1/status', () => HttpResponse.json({ detail: 'boom' }, { status: 500 })),
        http.patch('/api/v1/printers/1', async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({ id: 1 });
        }),
      );
      await openPrinter();

      // No cached status to fall back on and nothing known to say it is printing, so the toggle goes ahead.
      fireEvent.click(await screen.findByRole('button', { name: 'Enter maintenance mode' }));
      await waitFor(() => expect(body).toEqual({ is_active: false }));
    });

    it('sends the change once when the button is clicked twice quickly', async () => {
      let patches = 0;
      server.use(
        overviewFor(true),
        http.get('/api/v1/printers/1/status', async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return HttpResponse.json({ connected: true, state: 'IDLE' });
        }),
        http.patch('/api/v1/printers/1', () => {
          patches += 1;
          return HttpResponse.json({ id: 1 });
        }),
      );
      await openPrinter();

      const button = await screen.findByRole('button', { name: 'Enter maintenance mode' });
      fireEvent.click(button);
      fireEvent.click(button);

      await waitFor(() => expect(patches).toBe(1));
      // Give a stray second request time to arrive before asserting there was none.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(patches).toBe(1);
    });

    it('disables the button while the print check is in flight', async () => {
      let patched = false;
      server.use(
        overviewFor(true),
        http.get('/api/v1/printers/1/status', async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return HttpResponse.json({ connected: true, state: 'IDLE' });
        }),
        http.patch('/api/v1/printers/1', () => {
          patched = true;
          return HttpResponse.json({ id: 1 });
        }),
      );
      await openPrinter();

      fireEvent.click(await screen.findByRole('button', { name: 'Enter maintenance mode' }));
      expect(screen.getByRole('button', { name: 'Enter maintenance mode' })).toBeDisabled();
      // Let the request finish so it can't leak into the next test's handlers.
      await waitFor(() => expect(patched).toBe(true));
    });

    it('hides the button without the printer-edit permission', async () => {
      setAuthToken('viewer-token');
      server.use(
        overviewFor(true),
        http.get('*/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: true, requires_setup: false })),
        http.get('*/api/v1/auth/me', () =>
          HttpResponse.json({ id: 2, username: 'viewer', is_admin: false, permissions: ['maintenance:read', 'maintenance:create'] }),
        ),
      );
      await openPrinter();

      expect(await screen.findByRole('button', { name: 'Log a repair' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /maintenance mode/i })).not.toBeInTheDocument();
      setAuthToken(null);
    });

    it('asks for confirmation before interrupting a running print', async () => {
      let body: unknown = null;
      server.use(
        overviewFor(true),
        http.get('/api/v1/printers/1/status', () => HttpResponse.json({ connected: true, state: 'RUNNING' })),
        http.patch('/api/v1/printers/1', async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({ id: 1 });
        }),
      );
      await openPrinter();

      fireEvent.click(await screen.findByRole('button', { name: 'Enter maintenance mode' }));
      expect(await screen.findByText('Enter maintenance mode mid-print?')).toBeInTheDocument();
      expect(body).toBeNull();

      const confirmButtons = screen.getAllByRole('button', { name: 'Enter maintenance mode' });
      fireEvent.click(confirmButtons[confirmButtons.length - 1]);
      await waitFor(() => expect(body).toEqual({ is_active: false }));
    });
  });
});
