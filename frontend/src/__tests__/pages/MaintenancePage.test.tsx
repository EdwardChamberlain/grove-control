/**
 * Tests for the MaintenancePage component.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '../utils';
import { MaintenancePage } from '../../pages/MaintenancePage';
import { http, HttpResponse } from 'msw';
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
      expect(screen.getByRole('combobox', { name: 'Filter by type' })).toBeInTheDocument();
      expect(screen.getByText('Completed as scheduled')).toBeInTheDocument();
      expect(screen.getByText('X1 Carbon', { selector: 'span' })).toBeInTheDocument();
      expect(screen.getByText('Scheduled', { selector: 'span' })).toBeInTheDocument();
      expect(screen.queryByLabelText('Edit')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Delete')).not.toBeInTheDocument();
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
            title: createRequest.title,
            notes: createRequest.notes,
            occurred_at: createRequest.occurred_at,
            hours_at_maintenance: createRequest.hours_at_maintenance,
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

      fireEvent.click(screen.getByRole('combobox', { name: 'Filter by type' }));
      fireEvent.click(await screen.findByRole('option', { name: 'Unscheduled' }));

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
      expect(await screen.findByText('Recorded by alice')).toBeInTheDocument();
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
  });
});
