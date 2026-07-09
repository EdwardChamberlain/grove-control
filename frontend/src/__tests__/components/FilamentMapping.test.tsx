/**
 * Tests for the FilamentMapping component's Filament Track Switch (FTS)
 * handling (#1162).
 *
 * The FTS accessory routes any AMS slot to either extruder dynamically. When
 * present (printer status `fila_switch.installed === true`), the per-extruder
 * dropdown filter must be suppressed — otherwise the print modal's filament
 * dropdown is empty since the printer reports info bits 8-11 = 0xE
 * (uninitialized) for every AMS unit.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { FilamentMapping } from '../../components/PrintModal/FilamentMapping';
import type { PrinterStatus } from '../../api/client';

const mockFilamentReqs = {
  filaments: [
    // Required filament asks for the LEFT extruder (nozzle_id=1).
    // Without FTS the dropdown filter would only allow slots with extruderId=1.
    { slot_id: 1, type: 'PETG', color: '#00FF00', used_grams: 25, used_meters: 8.5, nozzle_id: 1 },
  ],
};

function createStatus(overrides: Partial<PrinterStatus>): PrinterStatus {
  return {
    id: 1,
    name: 'X2D',
    connected: true,
    state: 'IDLE',
    ams: [
      {
        id: 0,
        // Realistic FTS-installed bundle: AMS reports extruder bits 8-11 = 0xE,
        // so ams_extruder_map ends up empty.
        tray: [
          { id: 0, tray_type: 'PLA', tray_color: 'FF0000', tray_info_idx: 'GFA00', tray_sub_brands: 'Bambu PLA' },
          { id: 1, tray_type: 'PETG', tray_color: '00FF00', tray_info_idx: 'GFG00', tray_sub_brands: 'Bambu PETG' },
        ],
      },
    ],
    vt_tray: [],
    ams_extruder_map: {},
    ...overrides,
  } as PrinterStatus;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FilamentMapping — FTS routing', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/v1/printers/:id/spool-assignments', () => HttpResponse.json([])),
    );
  });

  it('shows same-material slots across FTS routes', async () => {
    server.use(
      http.get(
        '/api/v1/printers/:id/status',
        () =>
          HttpResponse.json(
            createStatus({
              fila_switch: {
                installed: true,
                in_slots: [-1, 1],
                out_extruders: [0, 1],
                stat: 0,
                info: 2,
              },
            }),
          ),
      ),
    );

    render(
      <FilamentMapping
        printerId={1}
        filamentReqs={mockFilamentReqs}
        manualMappings={{}}
        onManualMappingChange={() => {}}
        currencySymbol="$"
        defaultCostPerKg={0}
        defaultExpanded
      />,
    );

    // PETG remains available despite the route, while unrelated PLA must not
    // be offered as an unsafe manual override.
    await waitFor(() => {
      expect(screen.getByText(/PETG Basic - Green/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/PLA - Red/)).not.toBeInTheDocument();

    // The slot currently fed into a track gets an [L]/[R] badge. AMS-0 slot 1
    // (global tray ID 1) is in fila_switch.in_slots[1], whose track terminates
    // at extruder 1 → the LEFT-nozzle short label appears in that option.
    const petgOption = screen.getByText(/PETG Basic - Green/);
    expect(petgOption.textContent).toMatch(/\[L\]/);

    // AMS-0 slot 0 (global tray ID 0) is NOT currently fed into any track —
    // FTS routes it on demand, so no badge.
  });

  it('offers cross-extruder slots in the dropdown without FTS (#1722)', async () => {
    // Before #1722 the dropdown filtered to only slots whose extruder matched
    // the filament's slicer-assigned nozzle. On a dual-nozzle printer with one
    // AMS per side, that prevented the user from picking a slot on the OTHER
    // extruder even when they'd intentionally loaded the required filament
    // there. The fix: trust the user, show every loaded slot regardless of
    // which extruder it's wired to. The L/R badge on the filament row still
    // tells the user what the slicer planned; the printer firmware accepts
    // or rejects the cross-extruder ams_mapping at start-print.
    server.use(
      http.get(
        '/api/v1/printers/:id/status',
        () =>
          HttpResponse.json(
            createStatus({
              fila_switch: null,
              ams_extruder_map: { '0': 0 },  // AMS 0 → right nozzle (extruder 0)
            }),
          ),
      ),
    );

    render(
      <FilamentMapping
        printerId={1}
        filamentReqs={mockFilamentReqs}
        manualMappings={{}}
        onManualMappingChange={() => {}}
        currencySymbol="$"
        defaultCostPerKg={0}
        defaultExpanded
      />,
    );

    // Required nozzle is 1 (LEFT) and AMS 0 is wired to extruder 0 (RIGHT).
    // The same-material PETG slot must still appear across extruders; the PLA
    // slot remains excluded because manual mapping cannot cross materials.
    await waitFor(() => {
      expect(screen.getByText(/PETG Basic - Green/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/PLA - Red/)).not.toBeInTheDocument();
  });

  it('renders canonical material and generated colour on the required side', async () => {
    // Profile id GFA01 carries the material subtype, while the display colour
    // comes from the generic colour helper rather than catalogue names.
    server.use(
      http.get(
        '/api/v1/printers/:id/status',
        () =>
          HttpResponse.json(
            createStatus({
              fila_switch: null,
              ams_extruder_map: { '0': 1 },
            }),
          ),
      ),
    );

    const charcoalReqs = {
      filaments: [
        { slot_id: 1, type: 'PLA', color: '#000000', used_grams: 25, used_meters: 8.5, nozzle_id: 1, tray_info_idx: 'GFA01' },
      ],
    };

    render(
      <FilamentMapping
        printerId={1}
        filamentReqs={charcoalReqs}
        manualMappings={{}}
        onManualMappingChange={() => {}}
        currencySymbol="$"
        defaultCostPerKg={0}
        defaultExpanded
      />,
    );

    // Required-side type text picks up the resolved subtype.
    await waitFor(() => {
      expect(screen.getByText(/PLA Matte/)).toBeInTheDocument();
    });
    // The swatch tooltip carries the canonical generated label.
    await waitFor(() => {
      const swatch = screen.getByTitle(/Required: PLA Matte - Black/);
      expect(swatch).toBeInTheDocument();
    });
  });
});
