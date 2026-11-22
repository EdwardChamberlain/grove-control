/**
 * Tests for the QueuePage component.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { QueuePage } from '../../pages/QueuePage';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { setAuthToken } from '../../api/client';
import { formatDate } from '../../utils/date';

// jsdom has no layout, so a real drag cannot cross rows. Expose the page's
// onDragEnd handler so tests can drop one row onto another directly.
const dnd = vi.hoisted(() => ({ onDragEnd: null as null | ((e: unknown) => void) }));
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: (props: React.ComponentProps<typeof actual.DndContext>) => {
      dnd.onDragEnd = props.onDragEnd as typeof dnd.onDragEnd;
      return <actual.DndContext {...props} />;
    },
  };
});

// Mock queue data
const mockQueueItems = [
  {
    id: 1,
    printer_id: 1,
    archive_id: 1,
    position: 1,
    status: 'pending',
    scheduled_time: null,
    require_previous_success: false,
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
    require_previous_success: false,
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
    status: 'completed',
    scheduled_time: null,
    require_previous_success: false,
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
      const summaryRow = screen.getByTestId('queue-stat-history').parentElement;
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
      });
    });

    it('separates printing jobs from up next jobs with headings and counts', async () => {
      render(<QueuePage />);

      await waitFor(() => {
        expect(screen.getByText('Active Print')).toBeInTheDocument();
        expect(screen.getByText('Test Print 1')).toBeInTheDocument();
      });
      expect(screen.queryByText('Active jobs')).not.toBeInTheDocument();

      const printing = screen.getByTestId('queue-section-printing');
      const upNext = screen.getByTestId('queue-section-up-next');
      expect(within(printing).getByRole('heading', { level: 2, name: 'Printing' })).toBeInTheDocument();
      expect(printing).toHaveTextContent(/Printing\s*1/);
      expect(within(upNext).getByRole('heading', { level: 2, name: 'Up next' })).toBeInTheDocument();
      expect(upNext).toHaveTextContent(/Up next\s*1/);
      // Printing comes first, then the queue.
      expect(printing.compareDocumentPosition(upNext) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('hides the Printing heading when nothing is printing', async () => {
      server.use(
        http.get('/api/v1/queue/', () => HttpResponse.json(mockQueueItems.filter((item) => item.status === 'pending'))),
      );
      render(<QueuePage />);

      await waitFor(() => {
        expect(screen.getByText('Test Print 1')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('queue-section-printing')).not.toBeInTheDocument();
      expect(screen.getByTestId('queue-section-up-next')).toBeInTheDocument();
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
        expect(screen.getByText('Awaiting printer acknowledgement')).toBeInTheDocument();
        expect(screen.getAllByText('Dispatching').length).toBeGreaterThan(0);
        expect(screen.getByTestId('queue-stat-printing')).toHaveTextContent(/1\s*Printing/);
        expect(screen.getByTestId('queue-stat-queued')).toHaveTextContent(/2\s*Queued/);
        expect(screen.getAllByTitle('Stop Print')).toHaveLength(2);
      });

      await user.click(screen.getByRole('button', { name: /Timeline/ }));
      const timelineItem = await screen.findByTestId('queue-timeline-item-4');
      expect(timelineItem).toHaveAttribute('data-status', 'dispatching');
      expect(timelineItem).toHaveTextContent('Dispatching');
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
        expect(screen.getAllByText('Preheating').length).toBeGreaterThan(0);
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

    it('shows completed items in history', async () => {
      const user = userEvent.setup();
      render(<QueuePage />);

      // The History tab now owns the completed/cancelled/failed list.
      await user.click(await screen.findByRole('button', { name: /^History/ }));

      await waitFor(() => {
        expect(screen.getByText('Completed Print')).toBeInTheDocument();
      });
    });

    it('reveals history beyond the first page on demand', async () => {
      const user = userEvent.setup();
      const historyItems = Array.from({ length: 51 }, (_, index) => ({
        ...mockQueueItems[2],
        id: 100 + index,
        archive_name: `History Print ${index + 1}`,
      }));
      server.use(
        http.get('/api/v1/queue/', () => HttpResponse.json(historyItems)),
      );

      render(<QueuePage />);
      await user.click(await screen.findByRole('button', { name: /^History/ }));

      await waitFor(() => {
        expect(screen.getByText('History Print 1')).toBeInTheDocument();
        expect(screen.getByText('Showing 50 of 51')).toBeInTheDocument();
      });
      expect(screen.queryByText('History Print 51')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Show more' }));
      expect(await screen.findByText('History Print 51')).toBeInTheDocument();
      expect(screen.queryByText('Showing 50 of 51')).not.toBeInTheDocument();
    });

    it('shows status badges', async () => {
      render(<QueuePage />);

      await waitFor(() => {
        // Queue items should be visible with status indicators
        expect(screen.getByText('Test Print 1')).toBeInTheDocument();
      });
    });

    it('shows future jobs as scheduled, including their scheduled time', async () => {
      server.use(
        http.get('/api/v1/queue/', () => HttpResponse.json([
          { ...mockQueueItems[0], scheduled_time: '2099-01-01T09:30:00Z' },
        ])),
      );

      render(<QueuePage />);

      await waitFor(() => {
        expect(screen.getAllByText('Scheduled').length).toBeGreaterThan(0);
        expect(screen.getByText(/^Jan 1, 2099/)).toBeInTheDocument();
      });
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

    it('renders the empty state on the page background, not in a card', async () => {
      server.use(http.get('/api/v1/queue/', () => HttpResponse.json([])));

      render(<QueuePage />);

      const title = await screen.findByText('No prints scheduled');
      const container = title.parentElement as HTMLElement;
      expect(container.className).not.toMatch(/border|bg-|rounded/);
    });
  });

  describe('toolbar', () => {
    it('puts filters, layout and sort on one toolbar row', async () => {
      render(<QueuePage />);

      const printerFilter = await screen.findByRole('button', { name: 'All Printers' });
      const toolbar = printerFilter.closest('.flex-wrap') as HTMLElement;
      expect(toolbar).not.toBeNull();

      for (const control of [
        screen.getByRole('button', { name: 'All Status' }),
        screen.getByRole('button', { name: /By Printer/ }),
        screen.getByRole('button', { name: 'Sort by Position' }),
        screen.getByRole('button', { name: 'Select All' }),
      ]) {
        expect(toolbar).toContainElement(control);
      }
    });

    it('shows the layout toggle as a pressed segmented control', async () => {
      const user = userEvent.setup();
      render(<QueuePage />);

      const list = await screen.findByRole('button', { name: /^List$/ });
      const byPrinter = screen.getByRole('button', { name: /By Printer/ });
      expect(list).toHaveAttribute('aria-pressed', 'true');
      expect(byPrinter).toHaveAttribute('aria-pressed', 'false');

      await user.click(byPrinter);
      expect(byPrinter).toHaveAttribute('aria-pressed', 'true');
      expect(list).toHaveAttribute('aria-pressed', 'false');

      await user.click(list);
      expect(list).toHaveAttribute('aria-pressed', 'true');
      expect(byPrinter).toHaveAttribute('aria-pressed', 'false');
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

      expect(screen.getByRole('button', { name: 'Pending' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Printing' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Completed' })).toBeInTheDocument();
    });
  });

  describe('queue actions', () => {
    it('has no separate edit button: the job name is the edit link for pending items', async () => {
      render(<QueuePage />);

      const name = await screen.findByRole('button', { name: 'Test Print 1' });
      expect(name).toHaveAttribute('title', 'Edit');
      // Printing jobs cannot be edited, so their name is plain text.
      expect(screen.queryByRole('button', { name: 'Active Print' })).not.toBeInTheDocument();
    });

    it('opens the edit dialog when the job name is clicked', async () => {
      const user = userEvent.setup();
      render(<QueuePage />);

      await user.click(await screen.findByRole('button', { name: 'Test Print 1' }));

      expect(await screen.findByText('Edit Queue Item')).toBeInTheDocument();
    });

    it('opens the edit dialog when empty card space is clicked', async () => {
      const user = userEvent.setup();
      render(<QueuePage />);

      const name = await screen.findByRole('button', { name: 'Test Print 1' });
      const card = name.closest('.group') as HTMLElement;
      await user.click(within(card).getByText('Test Printer'));

      expect(await screen.findByText('Edit Queue Item')).toBeInTheDocument();
    });

    it('does not open the edit dialog when the cancel button is clicked', async () => {
      const user = userEvent.setup();
      render(<QueuePage />);

      const card = (await screen.findByRole('button', { name: 'Test Print 1' })).closest('.group') as HTMLElement;
      await user.click(within(card).getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByText('Edit Queue Item')).not.toBeInTheDocument();
      expect(await screen.findByText('Cancel Scheduled Print')).toBeInTheDocument();
    });

    it('shows a single cancel button per pending card and no edit or play button', async () => {
      render(<QueuePage />);

      const card = (await screen.findByRole('button', { name: 'Test Print 1' })).closest('.group') as HTMLElement;
      expect(within(card).getAllByRole('button', { name: 'Cancel' })).toHaveLength(1);
      expect(within(card).queryByTitle('Start Print')).not.toBeInTheDocument();
      expect(within(card).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    });

    it('labels the status gutter of a pending card as the drag handle', async () => {
      render(<QueuePage />);

      const card = (await screen.findByRole('button', { name: 'Test Print 1' })).closest('.group') as HTMLElement;
      // The accessible name keeps the job's status as well as the drag hint.
      expect(within(card).getByLabelText('Pending, Drag to reorder (ASAP only)')).toBeInTheDocument();
    });

    it('does not give printing jobs a drag handle or checkbox', async () => {
      render(<QueuePage />);

      const card = (await screen.findByText('Active Print')).closest('.group') as HTMLElement;
      expect(within(card).queryByLabelText('Drag to reorder (ASAP only)')).not.toBeInTheDocument();
      expect(within(card).queryByRole('checkbox')).not.toBeInTheDocument();
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

    it('shows re-queue button for history items', async () => {
      const user = userEvent.setup();
      render(<QueuePage />);

      await user.click(await screen.findByRole('button', { name: /^History/ }));

      await waitFor(() => {
        expect(screen.getByText('Completed Print')).toBeInTheDocument();
      });

      const requeueButtons = screen.getAllByTitle('Re-queue');
      expect(requeueButtons.length).toBeGreaterThan(0);
    });
  });

  describe('clear history', () => {
    it('shows clear history button when history exists', async () => {
      const user = userEvent.setup();
      render(<QueuePage />);

      // Clear History only renders inside the History tab now.
      await user.click(await screen.findByRole('button', { name: /^History/ }));

      await waitFor(() => {
        expect(screen.getByText('Clear History')).toBeInTheDocument();
      });
    });

    it('opens confirm modal when clicking clear history', async () => {
      const user = userEvent.setup();
      render(<QueuePage />);

      await user.click(await screen.findByRole('button', { name: /^History/ }));

      await waitFor(() => {
        expect(screen.getByText('Clear History')).toBeInTheDocument();
      });

      const clearButton = screen.getByRole('button', { name: /clear history/i });
      await user.click(clearButton);

      await waitFor(() => {
        expect(screen.getByText(/Are you sure you want to remove all/i)).toBeInTheDocument();
      });
    });
  });

  describe('staged items', () => {
    it('shows staged badge for manual_start items', async () => {
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
        expect(screen.getByText('Staged')).toBeInTheDocument();
      });
    });

    it('puts the Start button in the footer strip beside the Staged note', async () => {
      server.use(
        http.get('/api/v1/queue/', () => HttpResponse.json([
          { ...mockQueueItems[0], manual_start: true, waiting_reason: 'Waiting on PLA (Ash Gray)' },
        ])),
      );

      render(<QueuePage />);

      const reason = await screen.findByText('Waiting on PLA (Ash Gray)');
      const footer = reason.closest('div.border-t') as HTMLElement;
      expect(within(footer).getByText('Staged')).toBeInTheDocument();
      expect(within(footer).getByTitle('Start Print')).toBeInTheDocument();
    });

    it('starts a staged job from the footer button without opening the editor', async () => {
      const user = userEvent.setup();
      let started = false;
      server.use(
        http.get('/api/v1/queue/', () => HttpResponse.json([{ ...mockQueueItems[0], manual_start: true }])),
        http.post('/api/v1/queue/:id/start', () => {
          started = true;
          return HttpResponse.json({ success: true });
        }),
      );

      render(<QueuePage />);

      await user.click(await screen.findByTitle('Start Print'));

      await waitFor(() => expect(started).toBe(true));
      expect(screen.queryByText('Edit Queue Item')).not.toBeInTheDocument();
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
    it('shows power off icon when auto_off_after is true', async () => {
      render(<QueuePage />);

      expect(await screen.findByRole('img', { name: 'Auto power off' })).toBeInTheDocument();
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

      expect(await screen.findByRole('img', { name: 'G-code' })).toBeInTheDocument();
    });

    it('does not show G-code badge when gcode_injection is false', async () => {
      render(<QueuePage />);

      await waitFor(() => {
        expect(screen.getByText('Test Print 1')).toBeInTheDocument();
      });

      expect(screen.queryByRole('img', { name: 'G-code' })).not.toBeInTheDocument();
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

  describe('card states and details', () => {
    it('shows a paused print as Paused', async () => {
      server.use(
        http.get('/api/v1/printers/1/status', () => HttpResponse.json({
          id: 1, name: 'Test Printer', connected: true, state: 'PAUSE', progress: 40,
          layer_num: 10, total_layers: 100, remaining_time: 30,
        })),
      );
      render(<QueuePage />);

      await waitFor(() => {
        expect(screen.getAllByText('Paused').length).toBeGreaterThan(0);
      });
    });

    it('shows why a paused print stopped in the card footer', async () => {
      server.use(
        http.get('/api/v1/printers/1/status', () => HttpResponse.json({
          id: 1, name: 'Test Printer', connected: true, state: 'PAUSE', progress: 40,
          layer_num: 10, total_layers: 100, remaining_time: 30,
          stg_cur: 6, stg_cur_name: 'Paused (filament ran out)',
        })),
      );
      render(<QueuePage />);

      await waitFor(() => {
        expect(screen.getByText('Filament ran out')).toBeInTheDocument();
      });
    });

    it('omits the pause reason when the printer stage is not a pause reason', async () => {
      server.use(
        http.get('/api/v1/printers/1/status', () => HttpResponse.json({
          id: 1, name: 'Test Printer', connected: true, state: 'PAUSE', progress: 40,
          layer_num: 10, total_layers: 100, remaining_time: 30,
          stg_cur: -1, stg_cur_name: null,
        })),
      );
      render(<QueuePage />);

      await waitFor(() => {
        expect(screen.getAllByText('Paused').length).toBeGreaterThan(0);
      });
      expect(screen.queryByText('Filament ran out')).not.toBeInTheDocument();
    });

    it('names the plate of a multi-plate job', async () => {
      server.use(
        http.get('/api/v1/queue/', () => HttpResponse.json([
          { ...mockQueueItems[0], plate_id: 2, archive_name: 'Multi-plate Print' },
        ])),
        http.get('/api/v1/archives/:id/plates', () => HttpResponse.json({
          archive_id: 1, filename: 'multi.3mf', is_multi_plate: true,
          plates: [{ index: 2, name: 'Plate Two' }],
        })),
      );
      render(<QueuePage />);

      expect(await screen.findByText(/Multi-plate Print • Plate Two/)).toBeInTheDocument();
    });

    it('lists every candidate model for a cross-model job', async () => {
      server.use(
        http.get('/api/v1/queue/', () => HttpResponse.json([
          {
            ...mockQueueItems[0],
            printer_id: null,
            printer_name: null,
            target_model: 'X1C',
            variants: [{ target_model: 'X1C' }, { target_model: 'P1S' }],
          },
        ])),
      );
      render(<QueuePage />);

      expect(await screen.findByText('Any X1C / P1S')).toBeInTheDocument();
    });

    it('shows the exact start time for a job scheduled within the next day', async () => {
      const soon = new Date(Date.now() + 5 * 3600_000).toISOString();
      server.use(
        http.get('/api/v1/queue/', () => HttpResponse.json([
          { ...mockQueueItems[0], scheduled_time: soon },
        ])),
      );
      render(<QueuePage />);

      expect(await screen.findByText(formatDate(soon))).toBeInTheDocument();
      expect(screen.queryByText(/^in \d+h/)).not.toBeInTheDocument();
    });

    it('shows the status as visible text on small screens', async () => {
      render(<QueuePage />);

      const card = (await screen.findByRole('button', { name: 'Test Print 1' })).closest('.group') as HTMLElement;
      const labels = within(card).getAllByText('Pending');
      expect(labels.some((el) => el.className.includes('sm:hidden'))).toBe(true);
    });

    it('does not open the editor when the status gutter or the archive link is clicked', async () => {
      const user = userEvent.setup();
      render(<QueuePage />);

      const card = (await screen.findByRole('button', { name: 'Test Print 1' })).closest('.group') as HTMLElement;
      await user.click(within(card).getByLabelText(/Drag to reorder/));
      await user.click(within(card).getByTitle('View archive'));

      expect(screen.queryByText('Edit Queue Item')).not.toBeInTheDocument();
    });
  });

  describe('card details (branch coverage)', () => {
    const only = (item: Record<string, unknown>) =>
      server.use(http.get('/api/v1/queue/', () => HttpResponse.json([{ ...mockQueueItems[0], ...item }])));

    it('describes a model-targeted job with its location and filament types', async () => {
      only({ printer_id: null, printer_name: null, target_model: 'X1C', target_location: 'Shelf A', required_filament_types: ['PLA', 'PETG'] });
      render(<QueuePage />);

      expect(await screen.findByText('Any X1C @ Shelf A (PLA, PETG)')).toBeInTheDocument();
    });

    it('describes a cross-model job with its location', async () => {
      only({ printer_id: null, printer_name: null, target_location: 'Shelf B', variants: [{ target_model: 'X1C' }, { target_model: 'P1S' }] });
      render(<QueuePage />);

      expect(await screen.findByText('Any X1C / P1S @ Shelf B')).toBeInTheDocument();
    });

    it('falls back to the printer id when the printer has no name', async () => {
      only({ printer_name: null });
      render(<QueuePage />);

      expect(await screen.findByText('Printer #1')).toBeInTheDocument();
    });

    it('marks a pending job whose start time has passed as overdue', async () => {
      only({ scheduled_time: new Date(Date.now() - 10 * 60_000).toISOString() });
      render(<QueuePage />);

      expect(await screen.findByText('Overdue')).toBeInTheDocument();
    });

    it('shows a relative time for a job that was due a moment ago', async () => {
      only({ scheduled_time: new Date(Date.now() - 20_000).toISOString() });
      render(<QueuePage />);

      await screen.findByRole('button', { name: 'Test Print 1' });
      expect(screen.queryByText('Overdue')).not.toBeInTheDocument();
      expect(screen.queryByText('ASAP')).not.toBeInTheDocument();
    });

    it('says ASAP for a pending job with no scheduled time', async () => {
      render(<QueuePage />);

      expect(await screen.findByText('ASAP')).toBeInTheDocument();
    });

    it('waits for heater confirmation when the heat soak has not started', async () => {
      only({ status: 'preheating', chamber_heat_soak: true, heat_soak_minutes: 10, preheat_started_at: null });
      render(<QueuePage />);

      expect(await screen.findByText('Waiting for heater confirmation')).toBeInTheDocument();
    });

    it('shows 0% for a running print that has not progressed', async () => {
      server.use(
        http.get('/api/v1/printers/1/status', () => HttpResponse.json({
          id: 1, name: 'Test Printer', connected: true, state: 'RUNNING', progress: 0,
          layer_num: 0, total_layers: 0, remaining_time: 0,
        })),
      );
      render(<QueuePage />);

      expect(await screen.findByText('0%')).toBeInTheDocument();
    });

    it('uses the library file thumbnail, plate thumbnail and link for library jobs', async () => {
      server.use(
        http.get('/api/v1/library/files/:id/plates', () => HttpResponse.json({ plates: [], is_multi_plate: false })),
        http.get('/api/v1/queue/', () => HttpResponse.json([
          { ...mockQueueItems[0], id: 11, archive_id: null, archive_thumbnail: null, library_file_id: 7, library_file_thumbnail: 'x', plate_id: null, archive_name: 'Library Job' },
          { ...mockQueueItems[0], id: 12, archive_id: null, archive_thumbnail: null, library_file_id: 8, library_file_thumbnail: 'x', plate_id: 2, archive_name: 'Library Plate Job' },
        ])),
      );
      const { container } = render(<QueuePage />);

      await screen.findByText('Library Job');
      const sources = Array.from(container.querySelectorAll('img')).map((img) => img.getAttribute('src') ?? '');
      expect(sources.some((src) => src.includes('/library/files/7/thumbnail'))).toBe(true);
      expect(sources.some((src) => src.includes('/library/files/8/') && src.includes('plate'))).toBe(true);
      const links = screen.getAllByTitle('View in File Manager');
      expect(links[0]).toHaveAttribute('href', expect.stringContaining('/library?highlight=7'));
    });

    it('shows no file link and a placeholder thumbnail for a job with neither archive nor library file', async () => {
      only({ archive_id: null, archive_thumbnail: null, library_file_id: null, library_file_thumbnail: null, archive_name: 'Detached Job' });
      render(<QueuePage />);

      await screen.findByText('Detached Job');
      expect(screen.queryByTitle('View archive')).not.toBeInTheDocument();
      expect(screen.queryByTitle('View in File Manager')).not.toBeInTheDocument();
    });

    it('shows who added the job', async () => {
      only({ created_by_username: 'Ed' });
      render(<QueuePage />);

      expect(await screen.findByText('Ed')).toBeInTheDocument();
    });

    it('shows an error message on the card', async () => {
      only({ error_message: 'Printer went offline' });
      render(<QueuePage />);

      expect(await screen.findByText('Printer went offline')).toBeInTheDocument();
    });

    it('disables skipping a heat soak without update permission', async () => {
      setAuthToken('read-only-token');
      server.use(
        http.get('*/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: true, requires_setup: false })),
        http.get('*/api/v1/auth/me', () =>
          HttpResponse.json({ id: 9, username: 'viewer', is_admin: false, permissions: ['queue:read'] }),
        ),
      );
      only({ status: 'preheating', chamber_heat_soak: true, heat_soak_minutes: 10, preheat_started_at: new Date().toISOString() });
      render(<QueuePage />);

      const skip = await screen.findByRole('button', { name: 'Skip heat soak' });
      expect(skip).toBeDisabled();
      expect(skip).toHaveAttribute('title', 'You do not have permission to stop prints');
    });

    it('dims a card while it is being dragged with the keyboard', async () => {
      const user = userEvent.setup();
      render(<QueuePage />);

      const card = (await screen.findByRole('button', { name: 'Test Print 1' })).closest('.group') as HTMLElement;
      const handle = within(card).getByLabelText(/Drag to reorder/);
      handle.focus();
      await user.keyboard(' ');

      await waitFor(() => expect(card.className).toContain('opacity-50'));
      await user.keyboard('{Escape}');
    });
  });

  describe('optimistic reorder', () => {
    const twoPending = [
      mockQueueItems[0],
      { ...mockQueueItems[0], id: 5, position: 2, archive_name: 'Second Pending' },
    ];
    const order = () =>
      screen
        .getAllByLabelText(/Drag to reorder/)
        .map((h) => (h.closest('.group') as HTMLElement).textContent ?? '')
        .map((text) => (text.includes('Second Pending') ? 'second' : 'first'));

    it('keeps the dropped order while the reorder request is in flight and the server still returns the old order', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let body: unknown = null;
      server.use(
        http.get('/api/v1/queue/', () => HttpResponse.json(twoPending)),
        http.post('/api/v1/queue/reorder', async ({ request }) => {
          body = await request.json();
          await gate;
          return HttpResponse.json({ message: 'ok' });
        }),
      );
      render(<QueuePage />);

      await screen.findByText('Second Pending');
      expect(order()).toEqual(['first', 'second']);

      act(() => dnd.onDragEnd!({ active: { id: 1 }, over: { id: 5 } }));

      await waitFor(() => expect(body).not.toBeNull());
      // Request still pending and the stale GET has not been refetched: the
      // list must already show the new order rather than snapping back.
      expect(order()).toEqual(['second', 'first']);
      release();
    });

    it('rolls back to the previous order and shows an error when the reorder request fails', async () => {
      let attempted = false;
      server.use(
        http.get('/api/v1/queue/', () => HttpResponse.json(twoPending)),
        http.post('/api/v1/queue/reorder', () => {
          attempted = true;
          return HttpResponse.json({ detail: 'boom' }, { status: 500 });
        }),
      );
      render(<QueuePage />);

      await screen.findByText('Second Pending');
      act(() => dnd.onDragEnd!({ active: { id: 1 }, over: { id: 5 } }));

      expect(await screen.findByText('Failed to reorder queue')).toBeInTheDocument();
      expect(attempted).toBe(true);
      expect(order()).toEqual(['first', 'second']);
    });
  });

  describe('selection checkbox on the thumbnail', () => {
    it('renders an accessible checkbox for pending jobs that reveals on hover', async () => {
      render(<QueuePage />);

      const checkbox = await screen.findByRole('checkbox', { name: 'Select Test Print 1' });
      expect(checkbox).not.toBeChecked();
      const label = checkbox.closest('label') as HTMLElement;
      // Keyed on hover capability, so touch screens of any width keep it visible.
      expect(label.className).toContain('can-hover:opacity-0');
      expect(label.className).toContain('group-hover:opacity-100');
      expect(label.className).not.toContain('sm:opacity-0');
    });

    it('selects a job from the checkbox and keeps every checkbox visible while something is selected', async () => {
      const user = userEvent.setup();
      server.use(
        http.get('/api/v1/queue/', () => HttpResponse.json([
          mockQueueItems[0],
          { ...mockQueueItems[0], id: 5, position: 4, archive_name: 'Second Pending' },
        ])),
      );
      render(<QueuePage />);

      await user.click(await screen.findByRole('checkbox', { name: 'Select Test Print 1' }));

      expect(screen.getByRole('checkbox', { name: 'Select Test Print 1' })).toBeChecked();
      expect(screen.getByText('1 selected')).toBeInTheDocument();
      const other = screen.getByRole('checkbox', { name: 'Select Second Pending' });
      expect((other.closest('label') as HTMLElement).className).not.toContain('can-hover:opacity-0');
      expect(screen.queryByText('Edit Queue Item')).not.toBeInTheDocument();
    });
  });

  describe('permissions', () => {
    it('does not make the card or name editable without update permission', async () => {
      setAuthToken('read-only-token');
      server.use(
        http.get('*/api/v1/auth/status', () =>
          HttpResponse.json({ auth_enabled: true, requires_setup: false }),
        ),
        http.get('*/api/v1/auth/me', () =>
          HttpResponse.json({ id: 9, username: 'viewer', is_admin: false, permissions: ['queue:read'] }),
        ),
      );
      const user = userEvent.setup();
      render(<QueuePage />);

      const name = await screen.findByText('Test Print 1');
      expect(name.closest('button')).toBeNull();
      await user.click(name);
      expect(screen.queryByText('Edit Queue Item')).not.toBeInTheDocument();

      // Without queue:reorder there is no drag handle, and without
      // queue:delete the cancel button is disabled.
      const card = name.closest('.group') as HTMLElement;
      expect(within(card).queryByLabelText(/Drag to reorder/)).not.toBeInTheDocument();
      expect(within(card).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    });

    it('disables the toolbar bulk actions without update and delete permission', async () => {
      setAuthToken('read-only-token');
      server.use(
        http.get('*/api/v1/auth/status', () =>
          HttpResponse.json({ auth_enabled: true, requires_setup: false }),
        ),
        http.get('*/api/v1/auth/me', () =>
          HttpResponse.json({ id: 9, username: 'viewer', is_admin: false, permissions: ['queue:read'] }),
        ),
      );
      const user = userEvent.setup();
      render(<QueuePage />);

      await user.click(await screen.findByRole('button', { name: 'Select All' }));

      const edit = screen.getByRole('button', { name: 'Edit Selected' });
      const cancel = screen.getByRole('button', { name: 'Cancel Selected' });
      expect(edit).toBeDisabled();
      expect(edit).toHaveAttribute('title', expect.stringMatching(/permission/i));
      expect(cancel).toBeDisabled();
      expect(cancel).toHaveAttribute('title', expect.stringMatching(/permission/i));
    });
  });
});
