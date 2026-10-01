/**
 * Tests for the QueuePage component.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { QueuePage } from '../../pages/QueuePage';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { setAuthToken } from '../../api/client';

// Mock queue data
const mockQueueItems = [
  {
    id: 1,
    printer_id: 1,
    archive_id: 1,
    position: 1,
    status: 'queued',
    scheduled_time: null,
    auto_off_after: false,
    manual_start: false,
    ams_mapping: null,
    plate_id: null,
    bed_levelling: 'on',
    flow_cali: 'off',
    vibration_cali: true,
    layer_inspect: false,
    timelapse: false,
    use_ams: true,
    started_at: null,
    completed_at: null,
    error_message: null,
    created_at: '2024-01-01T00:00:00Z',
    archive_name: 'Test Print 1',
    archive_thumbnail: '/thumb1.png',
    printer_name: 'Test Printer',
    print_time_seconds: 3600,
  },
  {
    id: 2,
    printer_id: 1,
    archive_id: 2,
    position: 2,
    status: 'printing',
    scheduled_time: null,
    auto_off_after: true,
    manual_start: false,
    ams_mapping: null,
    plate_id: null,
    bed_levelling: 'on',
    flow_cali: 'off',
    vibration_cali: true,
    layer_inspect: false,
    timelapse: false,
    use_ams: true,
    started_at: '2024-01-01T10:00:00Z',
    completed_at: null,
    error_message: null,
    created_at: '2024-01-01T00:00:00Z',
    archive_name: 'Active Print',
    archive_thumbnail: '/thumb2.png',
    printer_name: 'Test Printer',
    print_time_seconds: 7200,
  },
  {
    id: 3,
    printer_id: 1,
    archive_id: 3,
    position: 3,
    status: 'finished',
    scheduled_time: null,
    auto_off_after: false,
    manual_start: false,
    ams_mapping: null,
    plate_id: null,
    bed_levelling: 'on',
    flow_cali: 'off',
    vibration_cali: true,
    layer_inspect: false,
    timelapse: false,
    use_ams: true,
    started_at: '2024-01-01T08:00:00Z',
    completed_at: '2024-01-01T09:00:00Z',
    error_message: null,
    created_at: '2024-01-01T00:00:00Z',
    archive_name: 'Completed Print',
    archive_thumbnail: '/thumb3.png',
    printer_name: 'Test Printer',
    print_time_seconds: 1800,
  },
];

const mockPrinters = [
  {
    id: 1,
    name: 'Test Printer',
    ip_address: '192.168.1.100',
    serial_number: 'TESTSERIAL0001',
    access_code: '12345678',
    model: 'X1C',
    enabled: true,
    created_at: '2024-01-01T00:00:00Z',
  },
];

describe('QueuePage', () => {
  beforeEach(() => {
    // Mock localStorage.getItem to return expected defaults for queue page
    vi.mocked(localStorage.getItem).mockImplementation((key: string) => {
      if (key === 'queue.historyCollapsed') return 'false'; // expanded
      if (key === 'queue.viewMode') return 'list';
      return null;
    });

    // Setup MSW handlers for this test
    server.use(
      http.get('/api/v1/queue/', () => {
        return HttpResponse.json(mockQueueItems);
      }),
      http.get('/api/v1/printers/', () => {
        return HttpResponse.json(mockPrinters);
      }),
      http.delete('/api/v1/queue/:id', () => {
        return HttpResponse.json({ success: true });
      }),
      http.post('/api/v1/queue/:id/cancel', () => {
        return HttpResponse.json({ success: true });
      }),
      http.post('/api/v1/queue/:id/start', () => {
        return HttpResponse.json({ success: true });
      }),
      http.post('/api/v1/queue/:id/stop', () => {
        return HttpResponse.json({ success: true });
      }),
      http.post('/api/v1/queue/:id/skip-heat-soak', () => {
        return HttpResponse.json({ message: 'Heat soak skipped' });
      }),
      http.post('/api/v1/queue/reorder', () => {
        return HttpResponse.json({ success: true });
      })
    );
  });

  afterEach(() => {
    setAuthToken(null);
  });

  describe('rendering', () => {
    it('renders the page title', async () => {
      render(<QueuePage />);

      await waitFor(() => {
        expect(screen.getByText('Print Queue')).toBeInTheDocument();
      });
    });

    it('renders the page description', async () => {
      render(<QueuePage />);

      await waitFor(() => {
        expect(screen.getByText('Schedule and manage your print jobs')).toBeInTheDocument();
      });
    });

    it('shows summary cards', async () => {
      render(<QueuePage />);

      await waitFor(() => {
        // Check for the page title (Print Queue is the h1)
        expect(screen.getByText('Print Queue')).toBeInTheDocument();
      });
    });

    it('keeps Add Job in the queue summary row and opens direct upload', async () => {
      const user = userEvent.setup();
      render(<QueuePage />);

      const addJobButton = await screen.findByRole('button', { name: 'Add Job' });
      const summaryRow = screen.getByTestId('queue-stat-awaiting').parentElement;
      expect(summaryRow).toContainElement(addJobButton);

      await user.click(addJobButton);
      expect(await screen.findByText('Drop one file here')).toBeInTheDocument();
      expect(document.querySelector('input[type="file"]')).not.toHaveAttribute('multiple');
    });

    it('shows filter dropdowns', async () => {
      render(<QueuePage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'All Printers' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'All Status' })).toBeInTheDocument();
      });
    });
  });

  describe('queue items display', () => {
    it('shows pending queue items', async () => {
      render(<QueuePage />);

      await waitFor(() => {
        expect(screen.getByText('Test Print 1')).toBeInTheDocument();
      });
    });

    it('shows active printing items', async () => {
      render(<QueuePage />);

      await waitFor(() => {
        expect(screen.getByText('Active Print')).toBeInTheDocument();
        expect(screen.getByText('Active jobs')).toBeInTheDocument();
      });
    });

    it('shows dispatching items as active without calling them printing', async () => {
      const user = userEvent.setup();
      server.use(
        http.get('/api/v1/queue/', () => HttpResponse.json([
          ...mockQueueItems,
          {
            ...mockQueueItems[1],
            id: 4,
            status: 'dispatching',
            dispatched_at: '2024-01-01T10:00:00Z',
            archive_name: 'Awaiting printer acknowledgement',
          },
        ])),
      );
      render(<QueuePage />);

      await waitFor(() => {
        expect(screen.getByText('Active jobs')).toBeInTheDocument();
        expect(screen.getByText('Awaiting printer acknowledgement')).toBeInTheDocument();
        expect(screen.getByText('Dispatching')).toBeInTheDocument();
        expect(screen.getByTestId('queue-stat-printing')).toHaveTextContent(/1\s*Printing/);
        expect(screen.getByTestId('queue-stat-queued')).toHaveTextContent(/2\s*Queued/);
        expect(screen.getAllByTitle('Stop Print')).toHaveLength(2);
      });

      await user.click(screen.getByRole('button', { name: /Timeline/ }));
      const timelineItem = await screen.findByTestId('queue-timeline-item-4');
      expect(timelineItem).toHaveAttribute('data-status', 'dispatching');
      expect(timelineItem).toHaveTextContent('Dispatching');
    });

    it('keeps a normal upload active without offering dispatch resolution', async () => {
      server.use(http.get('/api/v1/queue/', () => HttpResponse.json([{
        ...mockQueueItems[1], id: 4, status: 'dispatching', dispatch_needs_resolution: false,
        dispatched_at: null, started_at: null,
      }])));
      render(<QueuePage />);
      await screen.findByText('Dispatching');
      expect(screen.getByText('Active jobs')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: "It's printing" })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: "It didn't start" })).not.toBeInTheDocument();
      expect(screen.getByTitle('Stop Print')).toBeInTheDocument();
    });

    it.each(['printing', 'failed'] as const)('resolves an unconfirmed dispatch as %s', async (outcome) => {
      const user = userEvent.setup();
      let submitted: unknown;
      server.use(
        http.get('/api/v1/queue/', () => HttpResponse.json([{
          ...mockQueueItems[1], id: 4, status: 'dispatching', dispatch_needs_resolution: true,
        }])),
        http.post('/api/v1/queue/4/resolve-dispatch', async ({ request }) => {
          submitted = await request.json();
          return HttpResponse.json({ message: 'Dispatch resolved' });
        }),
      );
      render(<QueuePage />);
      const label = outcome === 'printing' ? "It's printing" : "It didn't start";
      await user.click(await screen.findByRole('button', { name: label }));
      await waitFor(() => expect(submitted).toEqual({ outcome }));
    });

    it('counts preheating items as printing and excludes them from queued work', async () => {
      server.use(
        http.get('/api/v1/queue/', () => HttpResponse.json([
          ...mockQueueItems,
          {
            ...mockQueueItems[0],
            id: 4,
            status: 'preheating',
            archive_name: 'Warming chamber',
            chamber_heat_soak: true,
            heat_soak_minutes: 10,
            preheat_started_at: new Date(Date.now() - 65_000).toISOString(),
          },
        ])),
      );
      render(<QueuePage />);

      await waitFor(() => {
        expect(screen.getByText('Warming chamber')).toBeInTheDocument();
        expect(screen.getByText('Preheating')).toBeInTheDocument();
        expect(screen.getByTestId('queue-stat-printing')).toHaveTextContent(/2\s*Printing/);
        expect(screen.getByTestId('queue-stat-queued')).toHaveTextContent(/1\s*Queued/);
        expect(screen.getAllByTitle('Stop Print')).toHaveLength(2);
        expect(screen.getByText(/Remaining: 8:\d{2}/)).toBeInTheDocument();
        expect(screen.getByTitle('Skip heat soak')).toBeInTheDocument();
      });
    });

    it('skips an active heat soak from the queue row', async () => {
      const user = userEvent.setup();
      server.use(
        http.get('/api/v1/queue/', () => HttpResponse.json([
          {
            ...mockQueueItems[0],
            id: 4,
            status: 'preheating',
            archive_name: 'Skip this soak',
            chamber_heat_soak: true,
            heat_soak_minutes: 10,
            preheat_started_at: new Date().toISOString(),
          },
        ])),
      );

      render(<QueuePage />);

      const skipButton = await screen.findByTitle('Skip heat soak');
      await user.click(skipButton);

      await waitFor(() => {
        expect(screen.getByText('Heat soak skipped')).toBeInTheDocument();
      });
    });

    it('shows finished jobs with Clear Plate in the live queue', async () => {
      render(<QueuePage />);
      expect(await screen.findByText('Completed Print')).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Awaiting plate clear' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Clear plate' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^History/ })).not.toBeInTheDocument();
    });

    it('keeps every awaiting job visible and clearable', async () => {
      const items = Array.from({ length: 51 }, (_, index) => ({
        ...mockQueueItems[2], id: 100 + index, printer_id: 100 + index,
        archive_name: `Awaiting Print ${index + 1}`,
      }));
      server.use(http.get('/api/v1/queue/', () => HttpResponse.json(items)));
      render(<QueuePage />);
      expect(await screen.findByText('Awaiting Print 51')).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: 'Clear plate' })).toHaveLength(51);
    });

    it('shows status badges', async () => {
      render(<QueuePage />);

      await waitFor(() => {
        // Queue items should be visible with status indicators
        expect(screen.getByText('Test Print 1')).toBeInTheDocument();
      });
    });

    it('keeps future jobs in the queued state with a Scheduled badge', async () => {
      server.use(http.get('/api/v1/queue/', () => HttpResponse.json([
        { ...mockQueueItems[0], scheduled_time: '2099-01-01T09:30:00Z' },
      ])));
      render(<QueuePage />);
      expect(await screen.findByText('Test Print 1')).toBeInTheDocument();
      expect(screen.getAllByText('Queued').length).toBeGreaterThan(0);
      expect(screen.getByTestId(`queue-badge-scheduled-${mockQueueItems[0].id}`))
        .toHaveTextContent('Scheduled · Jan 1, 2099');
      // The badge carries the start time; the row does not repeat it.
      expect(screen.getAllByText(/Jan 1, 2099/)).toHaveLength(1);
    });

    it('does not badge a queued job whose scheduled time has passed', async () => {
      server.use(http.get('/api/v1/queue/', () => HttpResponse.json([
        { ...mockQueueItems[0], scheduled_time: '2000-01-01T09:30:00Z' },
      ])));
      render(<QueuePage />);
      expect(await screen.findByText('Test Print 1')).toBeInTheDocument();
      expect(screen.queryByTestId(`queue-badge-scheduled-${mockQueueItems[0].id}`)).not.toBeInTheDocument();
    });

    it('shows the waiting reason as a badge on a queued job', async () => {
      server.use(http.get('/api/v1/queue/', () => HttpResponse.json([
        { ...mockQueueItems[0], waiting_reason: 'No matching material. Waiting on PETG' },
      ])));
      render(<QueuePage />);
      const badge = await screen.findByTestId(`queue-badge-waiting-${mockQueueItems[0].id}`);
      expect(badge).toHaveTextContent('Waiting · No matching material. Waiting on PETG');
      expect(badge).toHaveAttribute('title', 'No matching material. Waiting on PETG');
      expect(screen.getAllByText('Queued').length).toBeGreaterThan(0);
    });

    it('does not show queue badges once a job has left the queue', async () => {
      server.use(http.get('/api/v1/queue/', () => HttpResponse.json([
        {
          ...mockQueueItems[0],
          status: 'printing',
          manual_start: true,
          scheduled_time: '2099-01-01T09:30:00Z',
          waiting_reason: 'Stale reason',
        },
      ])));
      render(<QueuePage />);
      expect(await screen.findByText('Test Print 1')).toBeInTheDocument();
      const id = mockQueueItems[0].id;
      expect(screen.queryByTestId(`queue-badge-scheduled-${id}`)).not.toBeInTheDocument();
      expect(screen.queryByTestId(`queue-badge-manual-start-${id}`)).not.toBeInTheDocument();
      expect(screen.queryByTestId(`queue-badge-waiting-${id}`)).not.toBeInTheDocument();
    });

    it('shows printer names', async () => {
      render(<QueuePage />);

      await waitFor(() => {
        const printerElements = screen.getAllByText('Test Printer');
        expect(printerElements.length).toBeGreaterThan(0);
      });
    });

    it('renders queue items with plate_id correctly', async () => {
      // Override with queue items that have plate_id set
      server.use(
        http.get('/api/v1/queue/', () => {
          return HttpResponse.json([
            {
              ...mockQueueItems[0],
              plate_id: 2,
              archive_name: 'Multi-plate Print',
            },
          ]);
        })
      );

      render(<QueuePage />);

      await waitFor(() => {
        expect(screen.getByText('Multi-plate Print')).toBeInTheDocument();
      });
    });
  });

  describe('empty state', () => {
    it('shows empty state when no queue items', async () => {
      server.use(
        http.get('/api/v1/queue/', () => {
          return HttpResponse.json([]);
        })
      );

      render(<QueuePage />);

      await waitFor(() => {
        expect(screen.getByText('No prints scheduled')).toBeInTheDocument();
      });
    });
  });

  describe('filtering', () => {
    it('has printer filter options', async () => {
      const user = userEvent.setup();
      render(<QueuePage />);

      await waitFor(() => {
        expect(screen.getByText('All Printers')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: 'All Printers' }));

      expect(screen.getByRole('button', { name: 'Unassigned' })).toBeInTheDocument();
    });

    it('has status filter options', async () => {
      const user = userEvent.setup();
      render(<QueuePage />);

      await waitFor(() => {
        expect(screen.getByText('All Status')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: 'All Status' }));

      expect(screen.getByRole('button', { name: 'Queued' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Printing' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Finished' })).toBeInTheDocument();
    });
  });

  describe('queue actions', () => {
    it('shows edit button for pending items', async () => {
      render(<QueuePage />);

      await waitFor(() => {
        expect(screen.getByText('Test Print 1')).toBeInTheDocument();
      });

      // Find the edit button (Pencil icon)
      const editButtons = screen.getAllByTitle('Edit');
      expect(editButtons.length).toBeGreaterThan(0);
    });

    it('shows cancel button for pending items', async () => {
      render(<QueuePage />);

      await waitFor(() => {
        expect(screen.getByText('Test Print 1')).toBeInTheDocument();
      });

      const cancelButtons = screen.getAllByTitle('Cancel');
      expect(cancelButtons.length).toBeGreaterThan(0);
    });

    it('shows stop button for printing items', async () => {
      render(<QueuePage />);

      await waitFor(() => {
        expect(screen.getByText('Active Print')).toBeInTheDocument();
      });

      const stopButtons = screen.getAllByTitle('Stop Print');
      expect(stopButtons.length).toBeGreaterThan(0);
    });

    it('retries a failed job and leaves its hold visible', async () => {
      const user = userEvent.setup();
      let retried = false;
      server.use(
        http.get('/api/v1/queue/', () => HttpResponse.json([{ ...mockQueueItems[2], status: 'failed' }])),
        http.post('/api/v1/queue/3/retry', () => {
          retried = true;
          return HttpResponse.json({ ...mockQueueItems[2], id: 4, status: 'queued' });
        }),
      );
      render(<QueuePage />);
      await user.click(await screen.findByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(retried).toBe(true));
      expect(screen.getByText('Completed Print')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Clear plate' })).toBeInTheDocument();
    });
  });

  describe('plate clearing', () => {
    it('removes a cleared job from the live queue', async () => {
      const user = userEvent.setup();
      let cleared = false;
      server.use(
        http.get('/api/v1/queue/', () => HttpResponse.json(cleared ? [] : [mockQueueItems[2]])),
        http.post('/api/v1/queue/3/clear-plate', () => {
          cleared = true;
          return HttpResponse.json({ message: 'Plate cleared' });
        }),
      );
      render(<QueuePage />);
      await user.click(await screen.findByRole('button', { name: 'Clear plate' }));
      await waitFor(() => expect(screen.queryByText('Completed Print')).not.toBeInTheDocument());
      expect(cleared).toBe(true);
    });

    it('opens the live queue when the saved tab was History', async () => {
      vi.mocked(localStorage.getItem).mockImplementation(key => key === 'queue.activeTab' ? 'history' : null);
      render(<QueuePage />);
      expect(await screen.findByText('Test Print 1')).toBeInTheDocument();
      expect(screen.queryByText('Clear History')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^History/ })).not.toBeInTheDocument();
    });
  });

  describe('staged items', () => {
    it('shows the Manual start badge for manual_start items', async () => {
      server.use(
        http.get('/api/v1/queue/', () => {
          return HttpResponse.json([
            {
              ...mockQueueItems[0],
              manual_start: true,
            },
          ]);
        })
      );

      render(<QueuePage />);

      await waitFor(() => {
        expect(screen.getByTestId(`queue-badge-manual-start-${mockQueueItems[0].id}`)).toHaveTextContent('Manual start');
      });
    });

    it('shows start button for staged items', async () => {
      server.use(
        http.get('/api/v1/queue/', () => {
          return HttpResponse.json([
            {
              ...mockQueueItems[0],
              manual_start: true,
            },
          ]);
        })
      );

      render(<QueuePage />);

      await waitFor(() => {
        expect(screen.getByTitle('Start Print')).toBeInTheDocument();
      });
    });

    it('allows an owner with queue update permission to start without printer control permission', async () => {
      setAuthToken('queue-owner-token');
      server.use(
        http.get('*/api/v1/auth/status', () =>
          HttpResponse.json({ auth_enabled: true, requires_setup: false }),
        ),
        http.get('*/api/v1/auth/me', () =>
          HttpResponse.json({
            id: 7,
            username: 'queue-owner',
            is_admin: false,
            permissions: ['queue:update_own'],
          }),
        ),
        http.get('/api/v1/queue/', () =>
          HttpResponse.json([
            {
              ...mockQueueItems[0],
              manual_start: true,
              created_by_id: 7,
            },
          ]),
        ),
      );

      render(<QueuePage />);

      const startButton = await screen.findByTitle('Start Print');
      expect(startButton).toBeEnabled();
    });

    it('does not allow printer control permission to bypass queue ownership', async () => {
      setAuthToken('printer-controller-token');
      server.use(
        http.get('*/api/v1/auth/status', () =>
          HttpResponse.json({ auth_enabled: true, requires_setup: false }),
        ),
        http.get('*/api/v1/auth/me', () =>
          HttpResponse.json({
            id: 7,
            username: 'printer-controller',
            is_admin: false,
            permissions: ['printers:control'],
          }),
        ),
        http.get('/api/v1/queue/', () =>
          HttpResponse.json([
            {
              ...mockQueueItems[0],
              manual_start: true,
              created_by_id: 7,
            },
          ]),
        ),
      );

      render(<QueuePage />);

      const startButton = await screen.findByTitle('You do not have permission to start prints');
      expect(startButton).toBeDisabled();
    });
  });

  describe('queue reorder permissions', () => {
    it('does not render batch child move controls without queue reorder permission', async () => {
      setAuthToken('queue-owner-token');
      vi.mocked(localStorage.getItem).mockImplementation((key: string) => {
        if (key === 'queue.batchCollapsed') return JSON.stringify({ 77: false });
        if (key === 'queue.viewMode') return 'list';
        return null;
      });
      server.use(
        http.get('*/api/v1/auth/status', () =>
          HttpResponse.json({ auth_enabled: true, requires_setup: false }),
        ),
        http.get('*/api/v1/auth/me', () =>
          HttpResponse.json({
            id: 7,
            username: 'queue-owner',
            is_admin: false,
            permissions: ['queue:update_own'],
          }),
        ),
        http.get('/api/v1/queue/', () =>
          HttpResponse.json([
            { ...mockQueueItems[0], id: 77, archive_name: 'Batch child one', batch_id: 77, batch_name: 'Owned batch', created_by_id: 7 },
            { ...mockQueueItems[0], id: 78, archive_name: 'Batch child two', batch_id: 77, batch_name: 'Owned batch', created_by_id: 7 },
          ]),
        ),
      );

      render(<QueuePage />);

      expect(await screen.findByText('Batch child one')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Move up' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Move down' })).not.toBeInTheDocument();
    });
  });

  describe('auto power off badge', () => {
    it('shows power off badge when auto_off_after is true', async () => {
      render(<QueuePage />);

      await waitFor(() => {
        expect(screen.getByText('Auto power off')).toBeInTheDocument();
      });
    });
  });

  describe('gcode injection badge', () => {
    it('shows G-code badge when gcode_injection is true', async () => {
      const itemsWithGcode = mockQueueItems.map((item, i) =>
        i === 0 ? { ...item, gcode_injection: true } : item
      );
      server.use(
        http.get('/api/v1/queue/', () => HttpResponse.json(itemsWithGcode)),
      );

      render(<QueuePage />);

      await waitFor(() => {
        expect(screen.getByText('G-code')).toBeInTheDocument();
      });
    });

    it('does not show G-code badge when gcode_injection is false', async () => {
      render(<QueuePage />);

      await waitFor(() => {
        expect(screen.getByText('Test Print 1')).toBeInTheDocument();
      });

      expect(screen.queryByText('G-code')).not.toBeInTheDocument();
    });
  });

  describe('filament-short ▶ flow (#1496)', () => {
    /**
     * The dispatch pre-flight flags a queue item as filament_short. The user
     * clicks ▶, the backend re-checks live and either dispatches (no deficit
     * anymore — clear flag) or returns 409 with the per-slot deficit so the
     * frontend can render the "Print Anyway" confirm modal.
     */
    const shortItem = {
      ...mockQueueItems[0],
      manual_start: true,
      filament_short: true,
    };

    it('renders the filament-short badge on a flagged pending row', async () => {
      server.use(
        http.get('/api/v1/queue/', () => HttpResponse.json([shortItem])),
      );

      render(<QueuePage />);

      await waitFor(() => {
        expect(screen.getByText(/Insufficient filament for the assigned spool/i)).toBeInTheDocument();
      });
    });

    it('opens the Print Anyway modal when ▶ returns 409 and retries with skip_filament_check', async () => {
      let secondCallSkippedCheck: boolean | null = null;
      let attempts = 0;
      server.use(
        http.get('/api/v1/queue/', () => HttpResponse.json([shortItem])),
        http.post('/api/v1/queue/:id/start', ({ request }) => {
          attempts += 1;
          const url = new URL(request.url);
          const skip = url.searchParams.get('skip_filament_check') === 'true';
          if (attempts === 1) {
            return HttpResponse.json(
              {
                detail: {
                  code: 'insufficient_filament',
                  deficit: [
                    {
                      slot_id: 1,
                      ams_id: 0,
                      tray_id: 0,
                      filament_type: 'PLA',
                      required_grams: 270,
                      remaining_grams: 200,
                    },
                  ],
                },
              },
              { status: 409 },
            );
          }
          secondCallSkippedCheck = skip;
          return HttpResponse.json({ ...shortItem, manual_start: false, filament_short: false });
        }),
      );

      render(<QueuePage />);

      const playButton = await waitFor(() => {
        const button = document.querySelector<HTMLButtonElement>('button[title="Start Print"], button[title="You do not have permission to start prints"]');
        expect(button).not.toBeNull();
        return button!;
      });
      await userEvent.click(playButton);

      // Wait for the start endpoint to be hit (the 409 path returns to onError).
      await waitFor(() => expect(attempts).toBe(1));
      // Modal shows the deficit detail
      await screen.findByRole('button', { name: /Print Anyway/i });
      expect(
        screen.getByText(/Slot 1: needs 270 g, 200 g remaining/i),
      ).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: /Print Anyway/i }));

      await waitFor(() => expect(secondCallSkippedCheck).toBe(true));
      expect(attempts).toBe(2);
    });
  });
});
