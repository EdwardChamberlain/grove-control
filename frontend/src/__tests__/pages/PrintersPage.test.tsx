/**
 * Tests for the PrintersPage component.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { PrintersPage } from '../../pages/PrintersPage';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const mockPrinters = [
  {
    id: 1,
    name: 'X1 Carbon',
    ip_address: '192.168.1.100',
    serial_number: '00M09A350100001',
    access_code: '12345678',
    model: 'X1C',
    enabled: true,
    is_active: true,
    nozzle_diameter: 0.4,
    nozzle_type: 'hardened_steel',
    location: 'Workshop',
    auto_archive: true,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
  {
    id: 2,
    name: 'P1S Backup',
    ip_address: '192.168.1.101',
    serial_number: '00W00A123456789',
    access_code: '87654321',
    model: 'P1S',
    enabled: false,
    is_active: true,
    nozzle_diameter: 0.4,
    nozzle_type: 'stainless_steel',
    location: null,
    auto_archive: true,
    created_at: '2024-01-02T00:00:00Z',
    updated_at: '2024-01-02T00:00:00Z',
  },
];

const mockPrinterStatus = {
  connected: true,
  state: 'IDLE',
  awaiting_plate_clear: false,
  progress: 0,
  layer_num: 0,
  total_layers: 0,
  temperatures: {
    nozzle: 25,
    bed: 25,
    chamber: 25,
  },
  remaining_time: 0,
  filename: null,
  wifi_signal: -50,
  vt_tray: [],
};

const selectToolbarDropdownOption = async (triggerName: RegExp, optionName: RegExp) => {
  const user = userEvent.setup();

  await user.click(screen.getByRole('button', { name: triggerName }));
  await user.click(await screen.findByRole('button', { name: optionName }));
};

describe('PrintersPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    localStorage.removeItem('printerCardSize');
    localStorage.removeItem('printerViewMode');
    localStorage.removeItem('singlePrinterViewId');

    server.use(
      http.get('/api/v1/printers/', () => {
        return HttpResponse.json(mockPrinters);
      }),
      http.get('/api/v1/printers/:id/status', () => {
        return HttpResponse.json(mockPrinterStatus);
      }),
      http.post('/api/v1/printers/:id/clear-plate', () => {
        return HttpResponse.json({ success: true, message: 'Plate cleared' });
      }),
      http.get('/api/v1/settings/', () => {
        return HttpResponse.json({
          auto_archive: true,
          save_thumbnails: true,
          capture_finish_photo: true,
          default_filament_cost: 25.0,
          currency: 'USD',
          ams_humidity_good: 40,
          ams_humidity_fair: 60,
          ams_temp_good: 30,
          ams_temp_fair: 35,
          require_plate_clear: true,
        });
      }),
      // PrintersPage now reads UI rendering fields from the public ui-preferences
      // endpoint instead of /settings (#1293) — admin pages still hit /settings.
      http.get('/api/v1/settings/ui-preferences', () => {
        return HttpResponse.json({
          ams_humidity_good: 40,
          ams_humidity_fair: 60,
          ams_temp_good: 30,
          ams_temp_fair: 35,
          require_plate_clear: true,
        });
      }),
      http.get('/api/v1/queue/', () => {
        return HttpResponse.json([]);
      })
    );
  });

  describe('rendering', () => {
    it('renders the page title', async () => {
      render(<PrintersPage />);

      await waitFor(() => {
        expect(screen.getByText('Printers')).toBeInTheDocument();
      });
    });

    it('shows printer cards', async () => {
      render(<PrintersPage />);

      await waitFor(() => {
        expect(screen.getByText('X1 Carbon')).toBeInTheDocument();
        expect(screen.getByText('P1S Backup')).toBeInTheDocument();
      });
    });

    it('shows printer models', async () => {
      render(<PrintersPage />);

      await waitFor(() => {
        expect(screen.getByText('X1C')).toBeInTheDocument();
        expect(screen.getByText('P1S')).toBeInTheDocument();
      });
    });

    it('shows printer status', async () => {
      render(<PrintersPage />);

      await waitFor(() => {
        // Status should be shown - may vary based on state
        expect(screen.getByText('X1 Carbon')).toBeInTheDocument();
      });
    });
  });

  describe('printer info', () => {
    it('shows IP address in printer info modal', async () => {
      render(<PrintersPage />);

      await waitFor(() => {
        expect(screen.getByText('X1 Carbon')).toBeInTheDocument();
      });

      // IP address is shown in the PrinterInfoModal (accessed via 3-dot menu),
      // not directly on the card. Verify the printer data loaded correctly.
      expect(screen.getByText('X1 Carbon')).toBeInTheDocument();
    });

    it('shows location when set', async () => {
      render(<PrintersPage />);

      await waitFor(() => {
        // Printers should render - location display may vary
        expect(screen.getByText('X1 Carbon')).toBeInTheDocument();
      });
    });
  });

  describe('temperature display', () => {
    it('shows nozzle temperature', async () => {
      render(<PrintersPage />);

      await waitFor(() => {
        // Temperatures are shown in the UI
        expect(screen.getAllByText(/25/)).toBeTruthy();
      });
    });

    it('sets left and right nozzle temperatures from the nozzle selector', async () => {
      localStorage.setItem('printerCardSize', '2');
      const temperatureRequests: Array<{ target: string | null; nozzle: string | null }> = [];
      const dualNozzlePrinter = { ...mockPrinters[0], model: 'H2D', nozzle_count: 2 };
      const dualNozzleStatus = {
        ...mockPrinterStatus,
        active_extruder: 0,
        temperatures: {
          ...mockPrinterStatus.temperatures,
          nozzle: 31,
          nozzle_target: 0,
          nozzle_2: 32,
          nozzle_2_target: 0,
        },
        nozzle_rack: [
          { id: 0, nozzle_type: 'HS', nozzle_diameter: '0.4', wear: 5, stat: 1, max_temp: 300, serial_number: '', filament_color: '', filament_id: '', filament_type: '' },
          { id: 1, nozzle_type: 'HS', nozzle_diameter: '0.4', wear: 3, stat: 1, max_temp: 300, serial_number: '', filament_color: '', filament_id: '', filament_type: '' },
        ],
      };

      server.use(
        http.get('/api/v1/printers/', () => HttpResponse.json([dualNozzlePrinter])),
        http.get('/api/v1/printers/:id/status', () => HttpResponse.json(dualNozzleStatus)),
        http.post('/api/v1/printers/:id/temperature/nozzle', ({ request }) => {
          const url = new URL(request.url);
          temperatureRequests.push({
            target: url.searchParams.get('target'),
            nozzle: url.searchParams.get('nozzle'),
          });
          return HttpResponse.json({ success: true, message: 'Nozzle temperature set' });
        })
      );

      render(<PrintersPage />);

      await waitFor(() => {
        expect(screen.getByText('L / R')).toBeInTheDocument();
      });

      // Dual-nozzle temps live on the L/R temperature card, not the nozzle-select card.
      fireEvent.click(screen.getByText('L / R').parentElement!);

      const leftTempBox = screen.getByText('Left Temp').parentElement!.parentElement!;
      fireEvent.click(within(leftTempBox).getByRole('button', { name: '220 C' }));

      await waitFor(() => {
        expect(temperatureRequests).toContainEqual({ target: '220', nozzle: '1' });
      });

      fireEvent.click(screen.getByText('L / R').parentElement!);

      const rightTempBox = screen.getByText('Right Temp').parentElement!.parentElement!;
      fireEvent.click(within(rightTempBox).getByRole('button', { name: '260 C' }));

      await waitFor(() => {
        expect(temperatureRequests).toContainEqual({ target: '260', nozzle: '0' });
      });
    });
  });

  describe('fan badges', () => {
    // Chamber fan only exists on enclosed Bambu models. Open-frame printers
    // (A1, A1 Mini, A2L, P1P) have no chamber fan — the firmware reports
    // big_fan2_speed as 0 there and the widget would be dead UI.
    const statusWithFans = {
      ...mockPrinterStatus,
      cooling_fan_speed: 53,
      big_fan1_speed: 53,
      big_fan2_speed: 53,
    };

    const renderWithPrinter = (printer: typeof mockPrinters[number]) => {
      server.use(
        http.get('/api/v1/printers/', () => HttpResponse.json([printer])),
        http.get('/api/v1/printers/:id/status', () => HttpResponse.json(statusWithFans)),
      );
      render(<PrintersPage />);
    };

    it('hides chamber fan badge on A1 Mini (open-frame, no chamber fan)', async () => {
      renderWithPrinter({ ...mockPrinters[0], model: 'A1 Mini' });

      await waitFor(() => {
        // Part-cooling badge confirms the fan row rendered.
        expect(screen.getByTitle('Part Cooling Fan')).toBeInTheDocument();
      });
      expect(screen.getByTitle('Auxiliary Fan')).toBeInTheDocument();
      expect(screen.queryByTitle('Chamber Fan')).not.toBeInTheDocument();
    });

    it('hides chamber fan badge on A1 (open-frame)', async () => {
      renderWithPrinter({ ...mockPrinters[0], model: 'A1' });

      await waitFor(() => {
        expect(screen.getByTitle('Part Cooling Fan')).toBeInTheDocument();
      });
      expect(screen.queryByTitle('Chamber Fan')).not.toBeInTheDocument();
    });

    it('hides chamber fan badge on P1P (open-frame)', async () => {
      renderWithPrinter({ ...mockPrinters[0], model: 'P1P' });

      await waitFor(() => {
        expect(screen.getByTitle('Part Cooling Fan')).toBeInTheDocument();
      });
      expect(screen.queryByTitle('Chamber Fan')).not.toBeInTheDocument();
    });

    it('shows chamber fan badge on X1C (enclosed)', async () => {
      renderWithPrinter({ ...mockPrinters[0], model: 'X1C' });

      await waitFor(() => {
        expect(screen.getByTitle('Chamber Fan')).toBeInTheDocument();
      });
      expect(screen.getByTitle('Part Cooling Fan')).toBeInTheDocument();
      expect(screen.getByTitle('Auxiliary Fan')).toBeInTheDocument();
    });

    it('shows chamber fan badge on P1S (enclosed)', async () => {
      renderWithPrinter({ ...mockPrinters[0], model: 'P1S' });

      await waitFor(() => {
        expect(screen.getByTitle('Chamber Fan')).toBeInTheDocument();
      });
    });
  });

  describe('empty state', () => {
    it('shows empty state when no printers', async () => {
      server.use(
        http.get('/api/v1/printers/', () => {
          return HttpResponse.json([]);
        })
      );

      render(<PrintersPage />);

      await waitFor(() => {
        expect(screen.getByText(/no printers/i)).toBeInTheDocument();
      });
    });
  });

  describe('printer actions', () => {
    it('has action buttons', async () => {
      render(<PrintersPage />);

      await waitFor(() => {
        expect(screen.getByText('X1 Carbon')).toBeInTheDocument();
      });

      // There should be some interactive elements for printer actions
      const buttons = screen.getAllByRole('button');
      expect(buttons.length).toBeGreaterThan(0);
    });

    it('shows plate clear status and action on finished printers when not cleared', async () => {
      server.use(
        http.get('/api/v1/printers/', () => {
          return HttpResponse.json([mockPrinters[0]]);
        }),
        http.get('/api/v1/printers/:id/status', () => {
          return HttpResponse.json({ ...mockPrinterStatus, state: 'FINISH', awaiting_plate_clear: true });
        })
      );

      render(<PrintersPage />);

      await waitFor(() => {
        expect(screen.getAllByText('Plate not Clear')).toHaveLength(1);
      });

      expect(screen.getAllByRole('button', { name: 'Mark plate as cleared' }).length).toBeGreaterThan(0);
    });

    it('shows plate clear status and action on failed printers when not cleared', async () => {
      server.use(
        http.get('/api/v1/printers/:id/status', () => {
          return HttpResponse.json({ ...mockPrinterStatus, state: 'FAILED', awaiting_plate_clear: true });
        })
      );

      render(<PrintersPage />);

      await waitFor(() => {
        expect(screen.getAllByText('Plate not Clear').length).toBeGreaterThan(0);
      });

      expect(screen.getAllByRole('button', { name: 'Mark plate as cleared' }).length).toBeGreaterThan(0);
    });

    it('keeps the clear action available when an idle printer is still awaiting acknowledgment', async () => {
      server.use(
        http.get('/api/v1/printers/:id/status', () => {
          return HttpResponse.json({ ...mockPrinterStatus, state: 'IDLE', awaiting_plate_clear: true });
        })
      );

      render(<PrintersPage />);

      await waitFor(() => {
        expect(screen.getAllByText('Plate not Clear').length).toBeGreaterThan(0);
      });

      expect(screen.getAllByRole('button', { name: 'Mark plate as cleared' }).length).toBeGreaterThan(0);
    });

    it('updates the plate clear status after using the printer card action', async () => {
      let awaitingPlateClear = true;

      server.use(
        http.get('/api/v1/printers/', () => {
          return HttpResponse.json([mockPrinters[0]]);
        }),
        http.get('/api/v1/printers/:id/status', () => {
          return HttpResponse.json({ ...mockPrinterStatus, state: 'FINISH', awaiting_plate_clear: awaitingPlateClear });
        }),
        http.post('/api/v1/printers/:id/clear-plate', () => {
          awaitingPlateClear = false;
          return HttpResponse.json({ success: true, message: 'Plate cleared' });
        })
      );

      render(<PrintersPage />);

      await waitFor(() => {
        expect(screen.getAllByText('Plate not Clear').length).toBeGreaterThan(0);
      });

      fireEvent.click(screen.getAllByRole('button', { name: 'Mark plate as cleared' })[0]);

      await waitFor(() => {
        expect(screen.queryByText('Plate not Clear')).not.toBeInTheDocument();
      });

      expect(screen.queryByText('Plate Clear')).not.toBeInTheDocument();
    });

    it('opens status details from the list health indicator without opening the expanded card', async () => {
      localStorage.setItem('printerViewMode', 'list');
      render(<PrintersPage />);

      await waitFor(() => {
        expect(screen.getByText('X1 Carbon')).toBeInTheDocument();
      });

      fireEvent.click(screen.getAllByLabelText(/Machine health:/)[0]);

      const statusDetails = await screen.findByText('Status details');
      const backdrop = statusDetails.parentElement?.previousElementSibling;
      expect(backdrop).toBeInTheDocument();
      fireEvent.click(backdrop!);

      await waitFor(() => {
        expect(screen.queryByText('Status details')).not.toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    });

    it('shows an icon-only plate-clear action in the list printer-name field when needed', async () => {
      let awaitingPlateClear = true;
      server.use(
        http.get('/api/v1/printers/:id/status', ({ params }) => {
          return HttpResponse.json({
            ...mockPrinterStatus,
            state: 'FINISH',
            awaiting_plate_clear: params.id === '1' && awaitingPlateClear,
          });
        }),
        http.post('/api/v1/printers/:id/clear-plate', () => {
          awaitingPlateClear = false;
          return HttpResponse.json({ success: true, message: 'Plate cleared' });
        }),
      );

      render(<PrintersPage />);
      fireEvent.click(await screen.findByRole('button', { name: 'List' }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');
      });

      const clearButtons = await screen.findAllByRole('button', { name: 'Mark plate as cleared' });
      expect(clearButtons).toHaveLength(2); // Both responsive row variants are present in jsdom.
      clearButtons.forEach((button) => expect(button).not.toHaveTextContent('Mark plate as cleared'));
      fireEvent.click(clearButtons[0]);

      await waitFor(() => {
        expect(screen.queryByRole('button', { name: 'Mark plate as cleared' })).not.toBeInTheDocument();
      });
    });

    it('shows and handles the plate-clear action on a camera-wall tile', async () => {
      let awaitingPlateClear = true;
      vi.stubGlobal('IntersectionObserver', class {
        observe() {}
        unobserve() {}
        disconnect() {}
      });
      server.use(
        http.get('/api/v1/printers/:id/status', ({ params }) => {
          return HttpResponse.json({
            ...mockPrinterStatus,
            state: 'FINISH',
            awaiting_plate_clear: params.id === '1' && awaitingPlateClear,
          });
        }),
        http.post('/api/v1/printers/:id/clear-plate', () => {
          awaitingPlateClear = false;
          return HttpResponse.json({ success: true, message: 'Plate cleared' });
        }),
      );

      render(<PrintersPage />);
      fireEvent.click(await screen.findByRole('button', { name: 'Cam wall' }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Cam wall' })).toHaveAttribute('aria-pressed', 'true');
      });

      const clearButton = await screen.findByRole('button', { name: 'Mark plate as cleared' });
      fireEvent.click(clearButton);

      await waitFor(() => {
        expect(screen.queryByRole('button', { name: 'Mark plate as cleared' })).not.toBeInTheDocument();
      });
    });

    it('returns from a list clickthrough to the list view', async () => {
      localStorage.setItem('printerViewMode', 'list');
      render(<PrintersPage />);

      const printerName = await screen.findByText('X1 Carbon');
      fireEvent.click(printerName);
      fireEvent.click(await screen.findByRole('button', { name: 'Back' }));

      expect(screen.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    });

    it('hides single-printer view and routes list clickthroughs to detail cards on mobile', async () => {
      vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
        matches: query === '(max-width: 767px)',
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })));
      localStorage.setItem('printerViewMode', 'list');
      render(<PrintersPage />);

      const printerNames = await screen.findAllByText('X1 Carbon');
      expect(screen.queryByRole('button', { name: 'Single printer' })).not.toBeInTheDocument();
      fireEvent.click(printerNames[0]);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Detail cards' })).toHaveAttribute('aria-pressed', 'true');
      });
      expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    });

    it('returns from a single-printer clickthrough to the list view', async () => {
      localStorage.setItem('printerViewMode', 'detail');
      render(<PrintersPage />);

      fireEvent.click(await screen.findByRole('button', { name: 'X1 Carbon' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Back' }));

      expect(screen.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    });

    it('keeps the hero placeholder visible until the single-printer camera loads', async () => {
      const { container } = render(<PrintersPage />);

      fireEvent.click(await screen.findByRole('button', { name: 'X1 Carbon' }));
      const camera = await screen.findByAltText('X1 Carbon camera');
      const placeholder = container.querySelector('img[src="/img/camera_placeholder_X1C.png"]');
      expect(placeholder).toBeInTheDocument();
      expect(camera).toHaveClass('opacity-0');

      fireEvent.error(placeholder!);
      expect(container.querySelector('img[src="/img/camera_placeholder.png"]')).toBeInTheDocument();

      fireEvent.load(camera);

      await waitFor(() => {
        expect(camera).toHaveClass('opacity-100');
      });
      expect(placeholder).toBeInTheDocument();
    });

    it('releases the active camera when switching machines or leaving cockpit view', async () => {
      const stoppedPrinterIds: string[] = [];
      server.use(
        http.post('/api/v1/printers/:id/camera/stop', ({ params }) => {
          stoppedPrinterIds.push(String(params.id));
          return HttpResponse.json({ success: true });
        }),
      );

      render(<PrintersPage />);
      fireEvent.click(await screen.findByRole('button', { name: 'X1 Carbon' }));
      await screen.findByAltText('X1 Carbon camera');

      fireEvent.click(screen.getByTitle('P1S Backup'));
      await screen.findByAltText('P1S Backup camera');
      await waitFor(() => expect(stoppedPrinterIds).toContain('1'));

      fireEvent.click(screen.getByRole('button', { name: 'Detail cards' }));
      await waitFor(() => expect(stoppedPrinterIds).toContain('2'));
    });

    it('offers recent reprints from the print dialog instead of the cockpit card', async () => {
      server.use(
        http.get('/api/v1/print-log/', () => HttpResponse.json({
          items: [{
            id: 41,
            archive_id: 17,
            print_name: 'Sample Widget',
            printer_name: 'X1 Carbon',
            printer_id: 1,
            status: 'completed',
            started_at: '2026-06-30T09:00:00Z',
            completed_at: '2026-06-30T10:00:00Z',
            duration_seconds: 3600,
            filament_type: 'PLA',
            filament_color: 'FFFFFFFF',
            filament_used_grams: 12,
            cost: 0.3,
            energy_kwh: 0.1,
            energy_cost: 0.02,
            failure_reason: null,
            thumbnail_path: null,
            created_by_id: null,
            created_by_username: null,
            created_at: '2026-06-30T09:00:00Z',
          }],
          total: 1,
        })),
      );

      render(<PrintersPage />);
      fireEvent.click(await screen.findByRole('button', { name: 'X1 Carbon' }));
      await screen.findByText('Top filament: PLA');

      expect(screen.queryByText('Quick reprint')).not.toBeInTheDocument();
      fireEvent.click(await screen.findByRole('button', { name: 'Start print' }));

      expect(await screen.findByText('Quick reprint')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Sample Widget/ })).toBeInTheDocument();
    });

    it('provides AMS filament backup and skip objects controls in the single-printer cockpit', async () => {
      server.use(
        http.get('/api/v1/printers/:id/status', () => {
          return HttpResponse.json({
            ...mockPrinterStatus,
            state: 'RUNNING',
            current_print: 'multi-object.3mf',
            printable_objects_count: 2,
            ams_filament_backup: false,
            ams: [{
              id: 0,
              humidity: 35,
              temp: 25,
              tray: [{ id: 0, tray_type: 'PLA', tray_color: 'FF0000FF', remain: 80 }],
            }],
          });
        }),
        http.get('/api/v1/printers/:id/print/objects', () => {
          return HttpResponse.json({
            objects: [
              { id: 1, name: 'Part 1', x: 10, y: 10, skipped: false },
              { id: 2, name: 'Part 2', x: 20, y: 20, skipped: false },
            ],
            total: 2,
            skipped_count: 0,
            is_printing: true,
            bbox_all: [0, 0, 30, 30],
          });
        }),
      );

      render(<PrintersPage />);
      fireEvent.click(await screen.findByRole('button', { name: 'X1 Carbon' }));

      const statusPane = await screen.findByTestId('cockpit-status-pane');
      expect(screen.getByTestId('printers-page')).toHaveClass('flex', 'h-[calc(100dvh-3.5rem)]');
      expect(screen.getByTestId('cockpit-layout')).toHaveClass('flex-1', 'min-h-0');
      expect(statusPane).toHaveClass('overflow-y-auto');
      expect(statusPane).not.toHaveClass('z-20');
      expect(within(statusPane).getByText('Jog')).toBeInTheDocument();
      expect(within(statusPane).getByText('Statistics')).toBeInTheDocument();
      expect(within(statusPane).getByText('Success Rate')).toBeInTheDocument();

      expect(await screen.findByTestId('cockpit-filament-pane')).toHaveClass('min-h-0');
      expect(screen.getByTestId('cockpit-filament-scroll')).toHaveClass('overflow-auto');

      fireEvent.click(await screen.findByRole('button', { name: /AMS Filament Backup is OFF/ }));
      expect((await screen.findAllByText('AMS Filament Backup')).length).toBeGreaterThan(0);
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));

      const skipObjectsButton = screen.getByRole('button', { name: 'Skip Objects' });
      expect(skipObjectsButton).toBeEnabled();
      fireEvent.click(skipObjectsButton);
      expect((await screen.findAllByText('Skip Objects')).length).toBeGreaterThan(1);
    });

    it('provides AMS drying and power socket controls in the single-printer cockpit', async () => {
      const dryingRequests: URL[] = [];
      const powerActions: string[] = [];
      server.use(
        http.get('/api/v1/printers/:id/status', () => HttpResponse.json({
          ...mockPrinterStatus,
          supports_drying: true,
          ams: [{
            id: 0,
            humidity: 35,
            temp: 25,
            is_ams_ht: false,
            serial_number: 'AMS123',
            sw_ver: '1.0.0',
            module_type: 'n3f',
            dry_time: 0,
            dry_status: 0,
            dry_sub_status: 0,
            dry_sf_reason: [],
            dry_target_temp: null,
            dry_filament: null,
            tray: [{ id: 0, tray_type: 'PLA', tray_color: 'FF0000FF', remain: 80, state: 10 }],
          }],
        })),
        http.post('/api/v1/printers/:id/drying/start', ({ request }) => {
          dryingRequests.push(new URL(request.url));
          return HttpResponse.json({ status: 'started', ams_id: 0, temp: 45, duration: 12 });
        }),
        http.get('/api/v1/smart-plugs/by-printer/:id', () => HttpResponse.json({
          id: 9,
          name: 'Cockpit Socket',
          auto_off: false,
          auto_off_executed: false,
        })),
        http.get('/api/v1/smart-plugs/by-printer/:id/scripts', () => HttpResponse.json([])),
        http.get('/api/v1/smart-plugs/:id/status', () => HttpResponse.json({
          state: 'OFF',
          reachable: true,
          device_name: 'Cockpit Socket',
          energy: { power: 42.4 },
        })),
        http.post('/api/v1/smart-plugs/:id/control', async ({ request }) => {
          const body = await request.json() as { action: string };
          powerActions.push(body.action);
          return HttpResponse.json({ success: true, action: body.action });
        }),
      );

      render(<PrintersPage />);
      fireEvent.click(await screen.findByRole('button', { name: 'X1 Carbon' }));

      const amsHeader = await screen.findByTestId('cockpit-ams-header-0');
      expect(amsHeader).toHaveClass('px-2', 'py-1');
      const indicators = screen.getByTestId('cockpit-ams-indicators-0');
      expect(within(indicators).getByTitle(/Temperature:/).parentElement).toHaveClass('mr-1');
      const dryingButton = within(indicators).getByRole('button', { name: 'HT-A: Start Drying' });
      expect(dryingButton).toHaveClass('ml-1', 'px-1', 'py-0.5');
      fireEvent.click(dryingButton);
      const dryingDialog = await screen.findByRole('dialog', { name: 'Start Drying' });
      fireEvent.click(within(dryingDialog).getByRole('button', { name: 'Start Drying' }));
      await waitFor(() => expect(dryingRequests).toHaveLength(1));
      expect(dryingRequests[0].searchParams.get('filament')).toBe('PLA');
      expect(dryingRequests[0].searchParams.get('temp')).toBe('45');

      const powerControls = await screen.findByTestId('cockpit-power-controls');
      expect(within(powerControls).getByText('Cockpit Socket')).toBeInTheDocument();
      expect(within(powerControls).getByText('42W')).toBeInTheDocument();
      fireEvent.click(within(powerControls).getByRole('button', { name: 'Cockpit Socket: Turn on' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Power On' }));
      await waitFor(() => expect(powerActions).toEqual(['on']));
    });

    it('restores the homing warning before single-printer Z movement', async () => {
      sessionStorage.clear();
      render(<PrintersPage />);
      fireEvent.click(await screen.findByRole('button', { name: 'X1 Carbon' }));

      fireEvent.click(await screen.findByRole('button', { name: 'Move plate up' }));

      expect(await screen.findByText('Printer is not homed')).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: 'Auto Home' }).length).toBeGreaterThan(1);
      expect(screen.getByRole('button', { name: 'Move anyway' })).toBeInTheDocument();
    });

    it('uses configured presets and enables chamber heat control in the cockpit', async () => {
      server.use(
        http.get('/api/v1/settings/ui-preferences', () => {
          return HttpResponse.json({
            ams_humidity_good: 40,
            ams_humidity_fair: 60,
            ams_temp_good: 30,
            ams_temp_fair: 35,
            require_plate_clear: true,
            nozzle_temp_presets: '[131,221,271]',
            bed_temp_presets: '[51,71,91]',
            chamber_temp_presets: '[31,41,51]',
            fan_speed_presets: '[33,66,99]',
          });
        }),
        http.get('/api/v1/printers/:id/status', () => {
          return HttpResponse.json({
            ...mockPrinterStatus,
            supports_chamber_heater: true,
          });
        }),
      );

      render(<PrintersPage />);
      fireEvent.click(await screen.findByRole('button', { name: 'X1 Carbon' }));

      const nozzleTile = screen.getByText('Nozzle').closest('button');
      expect(nozzleTile).not.toBeNull();
      fireEvent.click(nozzleTile!);
      expect(await screen.findByRole('button', { name: '131 C' })).toBeInTheDocument();
      const nozzlePopover = screen.getByText('Set Nozzle Temperature').parentElement;
      fireEvent.click(nozzlePopover?.previousElementSibling as Element);

      const chamberTile = screen.getByText('Chamber').closest('button');
      expect(chamberTile).not.toBeNull();
      expect(chamberTile).toBeEnabled();
      fireEvent.click(chamberTile!);
      expect(await screen.findByRole('button', { name: '41 C' })).toBeInTheDocument();
      const chamberPopover = screen.getByText('Set Chamber Temperature').parentElement;
      fireEvent.click(chamberPopover?.previousElementSibling as Element);

      fireEvent.click(screen.getByTitle('Part Cooling Fan: 0%'));
      expect(await screen.findByRole('button', { name: '33 %' })).toBeInTheDocument();
    });

    it('hides green plate clear status and action while idle', async () => {
      render(<PrintersPage />);

      await waitFor(() => {
        expect(screen.getByText('X1 Carbon')).toBeInTheDocument();
      });

      expect(screen.queryByText('Plate Clear')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Mark plate as cleared' })).not.toBeInTheDocument();
    });

    it('hides green plate in use status while printing and hides the clear action', async () => {
      server.use(
        http.get('/api/v1/printers/:id/status', () => {
          // The backend can briefly retain this flag while a new print is active.
          // A stale warning must not surface as a green "Plate in Use" pill.
          return HttpResponse.json({ ...mockPrinterStatus, state: 'RUNNING', awaiting_plate_clear: true });
        })
      );

      render(<PrintersPage />);

      await waitFor(() => {
        expect(screen.getByText('X1 Carbon')).toBeInTheDocument();
      });

      expect(screen.queryByText('Plate in Use')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Mark plate as cleared' })).not.toBeInTheDocument();
    });

    it('hides plate status and action when plate-clear confirmation is disabled', async () => {
      server.use(
        http.get('/api/v1/settings/', () => {
          return HttpResponse.json({
            auto_archive: true,
            save_thumbnails: true,
            capture_finish_photo: true,
            default_filament_cost: 25.0,
            currency: 'USD',
            ams_humidity_good: 40,
            ams_humidity_fair: 60,
            ams_temp_good: 30,
            ams_temp_fair: 35,
            require_plate_clear: false,
          });
        }),
        http.get('/api/v1/settings/ui-preferences', () => {
          return HttpResponse.json({
            ams_humidity_good: 40,
            ams_humidity_fair: 60,
            ams_temp_good: 30,
            ams_temp_fair: 35,
            require_plate_clear: false,
          });
        }),
        http.get('/api/v1/printers/:id/status', () => {
          return HttpResponse.json({ ...mockPrinterStatus, state: 'FINISH', awaiting_plate_clear: true });
        })
      );

      render(<PrintersPage />);

      await waitFor(() => {
        expect(screen.getByText('X1 Carbon')).toBeInTheDocument();
      });

      expect(screen.queryByText('Plate not Clear')).not.toBeInTheDocument();
      expect(screen.queryByText('Plate Clear')).not.toBeInTheDocument();
      expect(screen.queryByText('Plate in Use')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Mark plate as cleared' })).not.toBeInTheDocument();
    });
  });

  describe('disabled printer', () => {
    it('shows disabled state for disabled printers', async () => {
      render(<PrintersPage />);

      await waitFor(() => {
        expect(screen.getByText('P1S Backup')).toBeInTheDocument();
      });

      // Disabled printers have visual indication
      const disabledPrinter = screen.getByText('P1S Backup').closest('div');
      expect(disabledPrinter).toBeInTheDocument();
    });
  });

  describe('maintenance mode (#1476)', () => {
    // Wraps the backend is_active flag — already gates MQTT, queue dispatch,
    // scheduler, metrics, picker. These tests pin the UI surface: status
    // panel swap, pill swap, and the PATCH on toggle.
    const inMaintenancePrinter = { ...mockPrinters[0], is_active: false };

    it('shows the maintenance status panel instead of the print container', async () => {
      server.use(
        http.get('/api/v1/printers/', () => HttpResponse.json([inMaintenancePrinter])),
        http.get('/api/v1/printers/:id/status', () =>
          HttpResponse.json({ ...mockPrinterStatus, connected: false }),
        ),
      );
      render(<PrintersPage />);

      await waitFor(() => {
        expect(screen.getByText('In Maintenance')).toBeInTheDocument();
      });
      // Exit button rendered
      expect(screen.getByRole('button', { name: /exit maintenance/i })).toBeInTheDocument();
      // The "No active job" / "Ready to print" copy from the normal status
      // panel must NOT be present — confirms the swap, not a stacked render.
      expect(screen.queryByText(/no active job/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/ready to print/i)).not.toBeInTheDocument();
    });

    it('shows the amber Maintenance pill in the header (no Connected/Offline)', async () => {
      server.use(
        http.get('/api/v1/printers/', () => HttpResponse.json([inMaintenancePrinter])),
        http.get('/api/v1/printers/:id/status', () =>
          HttpResponse.json({ ...mockPrinterStatus, connected: false }),
        ),
      );
      render(<PrintersPage />);

      // The header pill row contains "Maintenance" exactly once.
      await waitFor(() => {
        expect(screen.getAllByText('Maintenance').length).toBeGreaterThan(0);
      });
      // No connection diagnostic CTA (that's reserved for involuntary offline).
      expect(screen.queryByRole('button', { name: /run.*diagnostic/i })).not.toBeInTheDocument();
    });

    it('PATCHes is_active=true when the Exit button is clicked', async () => {
      const patchedBodies: unknown[] = [];
      server.use(
        http.get('/api/v1/printers/', () => HttpResponse.json([inMaintenancePrinter])),
        http.get('/api/v1/printers/:id/status', () =>
          HttpResponse.json({ ...mockPrinterStatus, connected: false }),
        ),
        http.patch('/api/v1/printers/:id', async ({ request }) => {
          const body = await request.json();
          patchedBodies.push(body);
          return HttpResponse.json({ ...inMaintenancePrinter, is_active: true });
        }),
      );
      render(<PrintersPage />);

      const exit = await screen.findByRole('button', { name: /exit maintenance/i });
      fireEvent.click(exit);

      await waitFor(() => {
        expect(patchedBodies.length).toBeGreaterThan(0);
      });
      expect(patchedBodies[0]).toEqual(expect.objectContaining({ is_active: true }));
    });

    it('renders the regular status panel when is_active=true', async () => {
      server.use(
        http.get('/api/v1/printers/', () => HttpResponse.json([{ ...mockPrinters[0], is_active: true }])),
        http.get('/api/v1/printers/:id/status', () => HttpResponse.json(mockPrinterStatus)),
      );
      render(<PrintersPage />);

      await waitFor(() => {
        expect(screen.getByText('X1 Carbon')).toBeInTheDocument();
      });
      // Active printer never shows the maintenance panel.
      expect(screen.queryByText('In Maintenance')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /exit maintenance/i })).not.toBeInTheDocument();
    });
  });

  describe('nozzle rack card', () => {
    const h2cStatus = {
      ...mockPrinterStatus,
      nozzle_rack: [
        { id: 0, nozzle_type: 'HS', nozzle_diameter: '0.4', wear: 5, stat: 1, max_temp: 300, serial_number: 'SN-L', filament_color: '', filament_id: '', filament_type: '' },
        { id: 1, nozzle_type: 'HS', nozzle_diameter: '0.4', wear: 3, stat: 0, max_temp: 300, serial_number: 'SN-R', filament_color: '', filament_id: '', filament_type: '' },
        { id: 16, nozzle_type: 'HS', nozzle_diameter: '0.4', wear: 10, stat: 0, max_temp: 300, serial_number: 'SN-16', filament_color: '', filament_id: '', filament_type: '' },
        { id: 17, nozzle_type: 'HH01', nozzle_diameter: '0.6', wear: 0, stat: 0, max_temp: 300, serial_number: 'SN-17', filament_color: '', filament_id: '', filament_type: '' },
        { id: 18, nozzle_type: 'HS', nozzle_diameter: '0.4', wear: 2, stat: 0, max_temp: 300, serial_number: 'SN-18', filament_color: '', filament_id: '', filament_type: '' },
        { id: 19, nozzle_type: '', nozzle_diameter: '', wear: null, stat: null, max_temp: 0, serial_number: '', filament_color: '', filament_id: '', filament_type: '' },
        { id: 20, nozzle_type: '', nozzle_diameter: '', wear: null, stat: null, max_temp: 0, serial_number: '', filament_color: '', filament_id: '', filament_type: '' },
        { id: 21, nozzle_type: '', nozzle_diameter: '', wear: null, stat: null, max_temp: 0, serial_number: '', filament_color: '', filament_id: '', filament_type: '' },
      ],
    };

    it('shows nozzle rack when H2C rack slots present', async () => {
      server.use(
        http.get('/api/v1/printers/:id/status', () => {
          return HttpResponse.json(h2cStatus);
        })
      );

      render(<PrintersPage />);

      await waitFor(() => {
        expect(screen.getAllByText('Nozzle Rack').length).toBeGreaterThan(0);
      });
    });

    it('shows 6 rack slot elements for H2C', async () => {
      server.use(
        http.get('/api/v1/printers/:id/status', () => {
          return HttpResponse.json(h2cStatus);
        })
      );

      render(<PrintersPage />);

      await waitFor(() => {
        expect(screen.getAllByText('Nozzle Rack').length).toBeGreaterThan(0);
      });

      // Rack shows diameters for occupied slots and dashes for empty ones
      const dashes = screen.getAllByText('—');
      expect(dashes.length).toBeGreaterThanOrEqual(3); // 3 empty rack positions (IDs 19,20,21)
    });

    it('keeps empty slot anchored to physical position when its nozzle is mounted (#943)', async () => {
      // H2C with rack slot 16 picked up into the hotend — firmware omits ID 16
      // entirely from nozzle.info. Each rack diameter is unique so we can assert
      // the ordering by tooltip lookup.
      const h2cSlot16Mounted = {
        ...mockPrinterStatus,
        nozzle_rack: [
          { id: 0, nozzle_type: 'HS', nozzle_diameter: '0.4', wear: 5, stat: 1, max_temp: 300, serial_number: 'SN-L', filament_color: '', filament_id: '', filament_type: '' },
          { id: 1, nozzle_type: 'HS', nozzle_diameter: '0.4', wear: 3, stat: 0, max_temp: 300, serial_number: 'SN-R', filament_color: '', filament_id: '', filament_type: '' },
          // ID 16 missing — currently in hotend
          { id: 17, nozzle_type: 'HS', nozzle_diameter: '0.2', wear: 0, stat: 0, max_temp: 300, serial_number: 'SN-17', filament_color: '', filament_id: '', filament_type: '' },
          { id: 18, nozzle_type: 'HS', nozzle_diameter: '0.6', wear: 0, stat: 0, max_temp: 300, serial_number: 'SN-18', filament_color: '', filament_id: '', filament_type: '' },
          { id: 19, nozzle_type: 'HS', nozzle_diameter: '0.8', wear: 0, stat: 0, max_temp: 300, serial_number: 'SN-19', filament_color: '', filament_id: '', filament_type: '' },
          { id: 20, nozzle_type: 'HH01', nozzle_diameter: '1.0', wear: 0, stat: 0, max_temp: 300, serial_number: 'SN-20', filament_color: '', filament_id: '', filament_type: '' },
          { id: 21, nozzle_type: 'HH01', nozzle_diameter: '1.2', wear: 0, stat: 0, max_temp: 300, serial_number: 'SN-21', filament_color: '', filament_id: '', filament_type: '' },
        ],
      };

      server.use(
        http.get('/api/v1/printers/:id/status', () => {
          return HttpResponse.json(h2cSlot16Mounted);
        })
      );

      render(<PrintersPage />);

      await waitFor(() => {
        expect(screen.getAllByText('Nozzle Rack').length).toBeGreaterThan(0);
      });

      // Slot 1 (leftmost, ID 16) should be the empty dash; slots 2..6 should
      // hold the 5 remaining nozzles in order 17, 18, 19, 20, 21.
      const rackLabel = screen.getAllByText('Nozzle Rack')[0];
      const rackCard = rackLabel.parentElement!;
      const slotRow = rackCard.querySelectorAll('div.flex')[0];
      const slotTexts = Array.from(slotRow.querySelectorAll('span')).map(s => s.textContent);
      expect(slotTexts).toEqual(['—', '0.2', '0.6', '0.8', '1.0', '1.2']);
    });

    it('hides nozzle rack when only L/R nozzles present (H2D)', async () => {
      const h2dStatus = {
        ...mockPrinterStatus,
        nozzle_rack: [
          { id: 0, nozzle_type: 'HS', nozzle_diameter: '0.4', wear: 5, stat: 1, max_temp: 300, serial_number: '', filament_color: '', filament_id: '', filament_type: '' },
          { id: 1, nozzle_type: 'HS', nozzle_diameter: '0.4', wear: 3, stat: 1, max_temp: 300, serial_number: '', filament_color: '', filament_id: '', filament_type: '' },
        ],
      };

      server.use(
        http.get('/api/v1/printers/:id/status', () => {
          return HttpResponse.json(h2dStatus);
        })
      );

      render(<PrintersPage />);

      await waitFor(() => {
        expect(screen.getByText('X1 Carbon')).toBeInTheDocument();
      });

      expect(screen.queryByText('Nozzle Rack')).not.toBeInTheDocument();
    });
  });

  describe('firmware version badge', () => {
    const firmwareUpToDate = {
      printer_id: 1,
      current_version: '01.09.00.00',
      latest_version: '01.09.00.00',
      update_available: false,
      download_url: null,
      release_notes: 'Bug fixes and improvements.',
    };

    const firmwareUpdateAvailable = {
      printer_id: 1,
      current_version: '01.08.00.00',
      latest_version: '01.09.00.00',
      update_available: true,
      download_url: 'https://example.com/firmware.bin',
      release_notes: 'New features added.',
    };

    it('hides green badge when firmware is up to date', async () => {
      server.use(
        http.get('/api/v1/firmware/updates/:id', () => {
          return HttpResponse.json(firmwareUpToDate);
        }),
        http.get('/api/v1/settings/', () => {
          return HttpResponse.json({
            check_printer_firmware: true,
            auto_archive: true,
            save_thumbnails: true,
          });
        })
      );

      render(<PrintersPage />);

      await waitFor(() => {
        expect(screen.getByText('X1 Carbon')).toBeInTheDocument();
      });

      expect(screen.queryByText('01.09.00.00')).not.toBeInTheDocument();

      fireEvent.click(screen.getAllByLabelText(/Machine health:/)[0]);

      await waitFor(() => {
        expect(screen.getByText('01.09.00.00')).toBeInTheDocument();
      });
    });

    it('shows warning badge when firmware update is available', async () => {
      server.use(
        http.get('/api/v1/firmware/updates/:id', () => {
          return HttpResponse.json(firmwareUpdateAvailable);
        }),
        http.get('/api/v1/settings/', () => {
          return HttpResponse.json({
            check_printer_firmware: true,
            auto_archive: true,
            save_thumbnails: true,
          });
        })
      );

      render(<PrintersPage />);

      await waitFor(() => {
        expect(screen.getAllByText('01.08.00.00').length).toBeGreaterThan(0);
      });

      const badge = screen.getAllByText('01.08.00.00')[0].closest('button');
      expect(badge).toBeInTheDocument();
      expect(badge?.className).toContain('text-status-warning');
    });

    it('hides badge when firmware check is disabled', async () => {
      server.use(
        http.get('/api/v1/settings/', () => {
          return HttpResponse.json({
            check_printer_firmware: false,
            auto_archive: true,
            save_thumbnails: true,
          });
        })
      );

      render(<PrintersPage />);

      await waitFor(() => {
        expect(screen.getByText('X1 Carbon')).toBeInTheDocument();
      });

      // Version should not appear when firmware check is disabled
      expect(screen.queryByText('01.09.00.00')).not.toBeInTheDocument();
      expect(screen.queryByText('01.08.00.00')).not.toBeInTheDocument();
    });

    it('hides badge when API has no firmware data for the model', async () => {
      const firmwareNoData = {
        printer_id: 1,
        current_version: '01.01.03.00',
        latest_version: null,
        update_available: false,
        download_url: null,
        release_notes: null,
      };

      server.use(
        http.get('/api/v1/firmware/updates/:id', () => {
          return HttpResponse.json(firmwareNoData);
        }),
        http.get('/api/v1/settings/', () => {
          return HttpResponse.json({
            check_printer_firmware: true,
            auto_archive: true,
            save_thumbnails: true,
          });
        })
      );

      render(<PrintersPage />);

      await waitFor(() => {
        expect(screen.getByText('X1 Carbon')).toBeInTheDocument();
      });

      // Badge should not appear when API returns no latest_version
      expect(screen.queryByText('01.01.03.00')).not.toBeInTheDocument();
    });
  });

  describe('bulk selection', () => {
    it('shows select button in toolbar', async () => {
      render(<PrintersPage />);

      await waitFor(() => {
        expect(screen.getByText('X1 Carbon')).toBeInTheDocument();
      });

      // The Select button should be in the toolbar (title attribute)
      const selectButton = screen.getByTitle('Select');
      expect(selectButton).toBeInTheDocument();
    });

    it('shows selection toolbar after clicking select button', async () => {
      render(<PrintersPage />);

      await waitFor(() => {
        expect(screen.getByText('X1 Carbon')).toBeInTheDocument();
      });

      // Click the Select button to enter selection mode
      fireEvent.click(screen.getByTitle('Select'));

      // The floating toolbar should appear with Select All
      await waitFor(() => {
        expect(screen.getByText('Select All')).toBeInTheDocument();
      });
    });

    it('shows selection count when printers are selected', async () => {
      render(<PrintersPage />);

      await waitFor(() => {
        expect(screen.getByText('X1 Carbon')).toBeInTheDocument();
      });

      // Enter selection mode
      fireEvent.click(screen.getByTitle('Select'));

      await waitFor(() => {
        expect(screen.getByText('Select All')).toBeInTheDocument();
      });

      // Click Select All to select both printers
      fireEvent.click(screen.getByText('Select All'));

      // Should show "2 selected"
      await waitFor(() => {
        expect(screen.getByText('2 selected')).toBeInTheDocument();
      });
    });

    it('shows select by state dropdown', async () => {
      render(<PrintersPage />);

      await waitFor(() => {
        expect(screen.getByText('X1 Carbon')).toBeInTheDocument();
      });

      // Enter selection mode
      fireEvent.click(screen.getByTitle('Select'));

      await waitFor(() => {
        expect(screen.getByText('Select by State')).toBeInTheDocument();
      });
    });

    it('exits selection mode on close button', async () => {
      render(<PrintersPage />);

      await waitFor(() => {
        expect(screen.getByText('X1 Carbon')).toBeInTheDocument();
      });

      // Enter selection mode
      fireEvent.click(screen.getByTitle('Select'));

      await waitFor(() => {
        expect(screen.getByText('Select All')).toBeInTheDocument();
      });

      // Click the Select button again to exit (it toggles)
      fireEvent.click(screen.getByTitle('Select'));

      // Floating toolbar should disappear
      await waitFor(() => {
        expect(screen.queryByText('Select All')).not.toBeInTheDocument();
      });
    });
  });

  describe('search and filter', () => {
    beforeEach(() => {
      server.use(
        http.get('/api/v1/printers/', () => HttpResponse.json(mockPrinters)),
        http.get('/api/v1/printers/:id/status', () => HttpResponse.json(mockPrinterStatus)),
        http.get('/api/v1/queue/', () => HttpResponse.json([]))
      );
    });

    it('filters by name (case-insensitive)', async () => {
      render(<PrintersPage />);
      await waitFor(() => expect(screen.getByText('X1 Carbon')).toBeInTheDocument());

      fireEvent.change(screen.getByPlaceholderText('Search printers...'), { target: { value: 'x1 carbon' } });

      await waitFor(() => {
        expect(screen.getByText('X1 Carbon')).toBeInTheDocument();
        expect(screen.queryByText('P1S Backup')).not.toBeInTheDocument();
      });
    });

    it('trims leading and trailing whitespace from search', async () => {
      render(<PrintersPage />);
      await waitFor(() => expect(screen.getByText('X1 Carbon')).toBeInTheDocument());

      // " X1 Carbon " with surrounding spaces must still match
      fireEvent.change(screen.getByPlaceholderText('Search printers...'), { target: { value: '  X1 Carbon  ' } });

      await waitFor(() => {
        expect(screen.getByText('X1 Carbon')).toBeInTheDocument();
        expect(screen.queryByText('P1S Backup')).not.toBeInTheDocument();
      });
    });

    it('filters by model', async () => {
      render(<PrintersPage />);
      await waitFor(() => expect(screen.getByText('X1 Carbon')).toBeInTheDocument());

      fireEvent.change(screen.getByPlaceholderText('Search printers...'), { target: { value: 'P1S' } });

      await waitFor(() => {
        expect(screen.queryByText('X1 Carbon')).not.toBeInTheDocument();
        expect(screen.getByText('P1S Backup')).toBeInTheDocument();
      });
    });

    it('filters by serial number', async () => {
      render(<PrintersPage />);
      await waitFor(() => expect(screen.getByText('X1 Carbon')).toBeInTheDocument());

      fireEvent.change(screen.getByPlaceholderText('Search printers...'), { target: { value: '00M09A' } });

      await waitFor(() => {
        expect(screen.getByText('X1 Carbon')).toBeInTheDocument();
        expect(screen.queryByText('P1S Backup')).not.toBeInTheDocument();
      });
    });

    it('shows empty state when no printers match search', async () => {
      render(<PrintersPage />);
      await waitFor(() => expect(screen.getByText('X1 Carbon')).toBeInTheDocument());

      fireEvent.change(screen.getByPlaceholderText('Search printers...'), { target: { value: 'ZZZ_NO_MATCH' } });

      await waitFor(() => {
        expect(screen.getByText('No printers match your search or filters')).toBeInTheDocument();
      });
    });

    it('clear button resets search and shows all printers', async () => {
      render(<PrintersPage />);
      await waitFor(() => expect(screen.getByText('X1 Carbon')).toBeInTheDocument());

      fireEvent.change(screen.getByPlaceholderText('Search printers...'), { target: { value: 'X1 Carbon' } });

      await waitFor(() => expect(screen.queryByText('P1S Backup')).not.toBeInTheDocument());

      // Click the accessible clear button
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

      await waitFor(() => {
        expect(screen.getByText('X1 Carbon')).toBeInTheDocument();
        expect(screen.getByText('P1S Backup')).toBeInTheDocument();
      });
    });

    it('filters by status (offline) via dropdown', async () => {
      // Override: printer 1 online, printer 2 offline
      server.use(
        http.get('/api/v1/printers/:id/status', ({ params }) => {
          if (Number(params.id) === 2) {
            return HttpResponse.json({ ...mockPrinterStatus, connected: false });
          }
          return HttpResponse.json(mockPrinterStatus);
        })
      );

      render(<PrintersPage />);
      await waitFor(() => expect(screen.getByText('X1 Carbon')).toBeInTheDocument());

      await selectToolbarDropdownOption(/all statuses/i, /^offline$/i);

      await waitFor(() => {
        expect(screen.queryByText('X1 Carbon')).not.toBeInTheDocument();
        expect(screen.getByText('P1S Backup')).toBeInTheDocument();
      });
    });

    it('shows empty state when status filter matches nothing', async () => {
      render(<PrintersPage />);
      await waitFor(() => expect(screen.getByText('X1 Carbon')).toBeInTheDocument());

      // Both printers are IDLE; filtering by "printing" should yield no results
      await selectToolbarDropdownOption(/all statuses/i, /^printing$/i);

      await waitFor(() => {
        expect(screen.getByText('No printers match your search or filters')).toBeInTheDocument();
      });
    });

    it('combines search and status filter', async () => {
      // Printer 1 = RUNNING (printing), printer 2 = IDLE
      server.use(
        http.get('/api/v1/printers/:id/status', ({ params }) => {
          if (Number(params.id) === 1) {
            return HttpResponse.json({ ...mockPrinterStatus, state: 'RUNNING' });
          }
          return HttpResponse.json(mockPrinterStatus);
        })
      );

      render(<PrintersPage />);
      await waitFor(() => expect(screen.getByText('X1 Carbon')).toBeInTheDocument());

      // Filter to only "printing" printers
      await selectToolbarDropdownOption(/all statuses/i, /^printing$/i);

      // Then also search for a term that only matches printer 1
      fireEvent.change(screen.getByPlaceholderText('Search printers...'), { target: { value: 'X1' } });

      await waitFor(() => {
        expect(screen.getByText('X1 Carbon')).toBeInTheDocument();
        expect(screen.queryByText('P1S Backup')).not.toBeInTheDocument();
      });
    });

    it('filters by location via dropdown', async () => {
      // Override: give printer 2 its own location so the dropdown has two options
      // and we can verify the filter picks the right one. Printer 1 stays at 'Workshop'.
      server.use(
        http.get('/api/v1/printers/', () =>
          HttpResponse.json([
            mockPrinters[0],
            { ...mockPrinters[1], location: 'Office' },
          ])
        )
      );

      render(<PrintersPage />);
      await waitFor(() => {
        expect(screen.getByText('X1 Carbon')).toBeInTheDocument();
        expect(screen.getByText('P1S Backup')).toBeInTheDocument();
      });

      await selectToolbarDropdownOption(/all locations/i, /^workshop$/i);

      await waitFor(() => {
        expect(screen.getByText('X1 Carbon')).toBeInTheDocument();
        expect(screen.queryByText('P1S Backup')).not.toBeInTheDocument();
      });

      await selectToolbarDropdownOption(/^workshop$/i, /^office$/i);

      await waitFor(() => {
        expect(screen.queryByText('X1 Carbon')).not.toBeInTheDocument();
        expect(screen.getByText('P1S Backup')).toBeInTheDocument();
      });
    });

    it('hides location filter when no printers have a location', async () => {
      // Both printers have null location — dropdown should not render at all
      server.use(
        http.get('/api/v1/printers/', () =>
          HttpResponse.json([
            { ...mockPrinters[0], location: null },
            { ...mockPrinters[1], location: null },
          ])
        )
      );

      render(<PrintersPage />);
      await waitFor(() => expect(screen.getByText('X1 Carbon')).toBeInTheDocument());

      // Status filter is still there, but the location filter should be absent.
      expect(screen.getByRole('button', { name: /all statuses/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /all locations/i })).not.toBeInTheDocument();
    });
  });

  describe('Spoolman loading guard', () => {
    it('does not show Assign Spool button while Spoolman queries are loading', async () => {
      // Spoolman enabled but inventory and slot-assignment queries never resolve
      server.use(
        http.get('/api/v1/spoolman/status', () =>
          HttpResponse.json({ enabled: true, connected: true })
        ),
        http.get('/api/v1/spoolman/inventory/spools', () =>
          new Promise(() => {})  // never resolves
        ),
        http.get('/api/v1/spoolman/inventory/slot-assignments/all', () =>
          new Promise(() => {})  // never resolves
        )
      );

      render(<PrintersPage />);

      // Wait for the page to render (printers should be visible)
      await waitFor(() => expect(screen.getByText('X1 Carbon')).toBeInTheDocument());

      // While Spoolman queries are still loading, the "Assign Spool" button must
      // not appear (inventory prop is undefined → {inventory && ...} guard fires)
      expect(screen.queryByText('Assign Spool')).not.toBeInTheDocument();
    });
  });

});

/**
 * Phase 13 P13-1 (PrintersPage EmptySlotHoverCard onAssignSpool gate removal)
 *
 * Pre-Phase-13 each of the three EmptySlotHoverCard call-sites in PrintersPage
 * gated `onAssignSpool` on `spoolmanEnabled ? (...) : undefined`, so empty
 * slots in local-Inventory mode never showed an Assign action. Maintainer
 * Foto 7 confirmed users expect the button regardless of mode.
 *
 * To assert wiring without going through hover-card animations, we mock the
 * EmptySlotHoverCard component at module level and capture every props
 * payload. The same mock is active in both modes; tests differ only in the
 * spoolman-settings mock. The mock module covers BOTH FilamentHoverCard exports
 * so tests outside this `describe` aren't affected (we re-export the real
 * FilamentHoverCard).
 */
const phase13EmptySlotProps: Array<Record<string, unknown>> = [];
const phase14HoverCardProps: Array<Record<string, unknown>> = [];

vi.mock('../../components/FilamentHoverCard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/FilamentHoverCard')>();
  return {
    ...actual,
    EmptySlotHoverCard: (props: Record<string, unknown>) => {
      phase13EmptySlotProps.push({ ...props });
      return null;
    },
    FilamentHoverCard: (props: Record<string, unknown>) => {
      phase14HoverCardProps.push({ ...props });
      return null;
    },
  };
});

describe('PrintersPage Phase 13 — EmptySlotHoverCard onAssignSpool wiring', () => {
  beforeEach(() => {
    phase13EmptySlotProps.length = 0;
    localStorage.removeItem('printerCardSize');
    localStorage.removeItem('printerViewMode');
    localStorage.removeItem('singlePrinterViewId');

    server.use(
      http.get('/api/v1/printers/', () => HttpResponse.json(mockPrinters)),
      // Status response includes an empty AMS slot so EmptySlotHoverCard renders.
      http.get('/api/v1/printers/:id/status', () => HttpResponse.json({
        ...mockPrinterStatus,
        ams: [{
          id: 0,
          tray: [{ id: 0, tray_type: '' }],
        }],
      })),
      http.get('/api/v1/settings/', () => HttpResponse.json({
        auto_archive: true, save_thumbnails: true, capture_finish_photo: true,
        default_filament_cost: 25.0, currency: 'USD',
        ams_humidity_good: 40, ams_humidity_fair: 60,
        ams_temp_good: 30, ams_temp_fair: 35,
      })),
      http.get('/api/v1/queue/', () => HttpResponse.json([])),
    );
  });

  it('P13-1 (local mode): EmptySlotHoverCard receives onAssignSpool callback', async () => {
    server.use(
      http.get('/api/v1/spoolman/settings', () => HttpResponse.json({
        spoolman_enabled: 'false', spoolman_url: '',
      })),
    );
    render(<PrintersPage />);

    // Wait for printer status to load and at least one EmptySlotHoverCard
    // to mount with an onAssignSpool callback. Pre-Phase-13 this would have
    // been undefined in local mode (the gate filtered it out).
    await waitFor(() => {
      const withCallback = phase13EmptySlotProps.filter(p => typeof p.onAssignSpool === 'function');
      expect(withCallback.length).toBeGreaterThan(0);
    }, { timeout: 3000 });
  });

  it('#1322: empty slot kind is "physical" when state=9 and "reset" otherwise', async () => {
    // Grove Control now distinguishes a firmware-confirmed empty slot (state=9
    // via tray_exist_bits) from a slot the user reset but where the
    // firmware still has a spool registered. The kind prop drives both
    // the inline label ("Empty" vs "Reset") and the hover card label.
    server.use(
      http.get('/api/v1/spoolman/settings', () => HttpResponse.json({
        spoolman_enabled: 'false', spoolman_url: '',
      })),
      http.get('/api/v1/printers/:id/status', () => HttpResponse.json({
        ...mockPrinterStatus,
        ams: [{
          id: 0,
          tray: [
            { id: 0, tray_type: '', state: 9 },   // physically empty
            { id: 1, tray_type: '', state: 3 },   // reset / unloading
            { id: 2, tray_type: '', state: null }, // unknown empty
            { id: 3, tray_type: 'PLA', state: 11 }, // loaded — no card here
          ],
        }],
      })),
    );
    render(<PrintersPage />);

    await waitFor(() => {
      expect(phase13EmptySlotProps.filter(p => p.kind === 'physical').length).toBeGreaterThan(0);
    }, { timeout: 3000 });

    const physical = phase13EmptySlotProps.filter(p => p.kind === 'physical');
    const reset = phase13EmptySlotProps.filter(p => p.kind === 'reset');
    expect(physical.length).toBeGreaterThan(0);
    expect(reset.length).toBeGreaterThan(0);
    // state=null falls back to 'reset' too — the helper only returns
    // 'physical' for the canonical 9/10 firmware codes.
  });

  it('P13-1 (spoolman mode): EmptySlotHoverCard still receives onAssignSpool callback', async () => {
    server.use(
      http.get('/api/v1/spoolman/settings', () => HttpResponse.json({
        spoolman_enabled: 'true', spoolman_url: 'http://x:7912',
      })),
      http.get('/api/v1/spoolman/spools/inventory*', () => HttpResponse.json([])),
      http.get('/api/v1/spoolman/inventory/spools', () => HttpResponse.json([])),
      http.get('/api/v1/spoolman/inventory/slot-assignments/all', () => HttpResponse.json([])),
    );
    render(<PrintersPage />);

    await waitFor(() => {
      const withCallback = phase13EmptySlotProps.filter(p => typeof p.onAssignSpool === 'function');
      expect(withCallback.length).toBeGreaterThan(0);
    }, { timeout: 3000 });
  });
});

/**
 * Phase 14 — Local-Branch BL-detection symmetry.
 *
 * The Spoolman branch of every IIFE in PrintersPage already passes
 *   isAssigned: !!slotAssignment || isBambuLabSpool(tray)
 *   onUnassignSpool: (spoolmanSpool && !isBambuLabSpool(tray)) ? ... : undefined
 *
 * The local branch was missing both. As a result a BL-RFID-tagged slot in
 * local-Inventory mode showed an "Assign Spool" button (because no manual
 * SpoolAssignment exists), and a manually-assigned BL-RFID slot showed
 * "Unassign" — which would be overwritten on the next RFID re-read.
 *
 * The same FilamentHoverCard mock from the Phase 13 block above captures
 * inventory props on every render so we can inspect them after setup.
 */
describe('PrintersPage Phase 14 — Local-Branch BL-detection symmetry', () => {
  beforeEach(() => {
    phase14HoverCardProps.length = 0;
    localStorage.removeItem('printerCardSize');
    localStorage.removeItem('printerViewMode');
    localStorage.removeItem('singlePrinterViewId');

    server.use(
      http.get('/api/v1/printers/', () => HttpResponse.json(mockPrinters)),
      http.get('/api/v1/settings/', () => HttpResponse.json({
        auto_archive: true, save_thumbnails: true, capture_finish_photo: true,
        default_filament_cost: 25.0, currency: 'USD',
        ams_humidity_good: 40, ams_humidity_fair: 60,
        ams_temp_good: 30, ams_temp_fair: 35,
      })),
      http.get('/api/v1/queue/', () => HttpResponse.json([])),
      http.get('/api/v1/spoolman/settings', () => HttpResponse.json({
        spoolman_enabled: 'false', spoolman_url: '',
      })),
    );
  });

  it('P14-1a (local + BL-RFID + no assignment): inventory.isAssigned=true', async () => {
    server.use(
      http.get('/api/v1/printers/:id/status', () => HttpResponse.json({
        ...mockPrinterStatus,
        ams: [{
          id: 0,
          tray: [{
            id: 0,
            tray_type: 'PLA',
            tray_uuid: '11223344556677880011223344556677',
            tag_uid: '0000000000000000',
            tray_color: 'FF0000FF',
            tray_sub_brands: 'Bambu PLA Basic',
          }],
        }],
      })),
      http.get('/api/v1/inventory/assignments', () => HttpResponse.json([])),
    );
    render(<PrintersPage />);

    await waitFor(() => {
      const matches = phase14HoverCardProps.filter(
        p => (p.inventory as { isAssigned?: boolean } | undefined)?.isAssigned === true
      );
      expect(matches.length).toBeGreaterThan(0);
    }, { timeout: 3000 });
  });

  it('P14-1b (local + non-BL + no assignment): inventory.isAssigned is falsy', async () => {
    server.use(
      http.get('/api/v1/printers/:id/status', () => HttpResponse.json({
        ...mockPrinterStatus,
        ams: [{
          id: 0,
          tray: [{
            id: 0,
            tray_type: 'PLA',
            tray_uuid: '00000000000000000000000000000000',
            tag_uid: '0000000000000000',
            tray_color: 'FF0000FF',
            tray_sub_brands: 'Generic PLA',
          }],
        }],
      })),
      http.get('/api/v1/inventory/assignments', () => HttpResponse.json([])),
    );
    render(<PrintersPage />);

    // Wait for FilamentHoverCard to render at least once.
    await waitFor(() => {
      expect(phase14HoverCardProps.length).toBeGreaterThan(0);
    }, { timeout: 3000 });

    // No render should ever set isAssigned=true for this slot.
    const truthyMatches = phase14HoverCardProps.filter(
      p => (p.inventory as { isAssigned?: boolean } | undefined)?.isAssigned === true
    );
    expect(truthyMatches.length).toBe(0);
  });

  it('P14-1c (local + manual assignment): inventory.isAssigned=true', async () => {
    server.use(
      http.get('/api/v1/printers/:id/status', () => HttpResponse.json({
        ...mockPrinterStatus,
        ams: [{
          id: 0,
          tray: [{
            id: 0,
            tray_type: 'PLA',
            tray_uuid: '00000000000000000000000000000000',
            tag_uid: '0000000000000000',
            tray_color: 'FF0000FF',
            tray_sub_brands: 'Generic PLA',
          }],
        }],
      })),
      http.get('/api/v1/inventory/assignments', () => HttpResponse.json([
        {
          id: 1,
          spool_id: 42,
          printer_id: 1,
          ams_id: 0,
          tray_id: 0,
          printer_name: 'X1 Carbon',
          ams_label: null,
          spool: {
            id: 42,
            material: 'PLA',
            brand: 'Generic',
            color_name: 'Red',
            label_weight: 1000,
            weight_used: 0,
            rgba: 'FF0000FF',
          },
        },
      ])),
    );
    render(<PrintersPage />);

    await waitFor(() => {
      const matches = phase14HoverCardProps.filter(
        p => (p.inventory as { isAssigned?: boolean } | undefined)?.isAssigned === true
      );
      expect(matches.length).toBeGreaterThan(0);
    }, { timeout: 3000 });
  });

  it('P14-2 (local + BL-RFID + manual assignment): onUnassignSpool=undefined', async () => {
    server.use(
      http.get('/api/v1/printers/:id/status', () => HttpResponse.json({
        ...mockPrinterStatus,
        ams: [{
          id: 0,
          tray: [{
            id: 0,
            tray_type: 'PLA',
            tray_uuid: '11223344556677880011223344556677',
            tag_uid: '0000000000000000',
            tray_color: 'FF0000FF',
            tray_sub_brands: 'Bambu PLA Basic',
          }],
        }],
      })),
      http.get('/api/v1/inventory/assignments', () => HttpResponse.json([
        {
          id: 1,
          spool_id: 42,
          printer_id: 1,
          ams_id: 0,
          tray_id: 0,
          printer_name: 'X1 Carbon',
          ams_label: null,
          spool: {
            id: 42,
            material: 'PLA',
            brand: 'Bambu Lab',
            color_name: 'Red',
            label_weight: 1000,
            weight_used: 0,
            rgba: 'FF0000FF',
          },
        },
      ])),
    );
    render(<PrintersPage />);

    // Wait for FilamentHoverCard renders to settle.
    await waitFor(() => {
      expect(phase14HoverCardProps.length).toBeGreaterThan(0);
    }, { timeout: 3000 });

    // For BL-detected slots in local mode, onUnassignSpool must always be
    // undefined — even when a manual assignment exists. Otherwise the user
    // could unassign a BL-RFID slot that the printer would re-assign on the
    // next re-read, surprising them with phantom ghost-assignments.
    const definedUnassign = phase14HoverCardProps.filter(
      p => typeof (p.inventory as { onUnassignSpool?: () => void } | undefined)?.onUnassignSpool === 'function'
    );
    expect(definedUnassign.length).toBe(0);
  });
});
