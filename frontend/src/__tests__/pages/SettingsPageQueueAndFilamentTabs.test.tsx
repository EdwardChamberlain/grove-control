/**
 * SettingsPage: the Queue and Filament tabs. Each control on these tabs
 * autosaves, so every test asserts on the settings body the page sends.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { SettingsPage } from '../../pages/SettingsPage';
import { server } from '../mocks/server';

const baseSettings = {
  auto_archive: true,
  save_thumbnails: true,
  capture_finish_photo: true,
  default_filament_cost: 25.0,
  currency: 'USD',
  ams_humidity_good: 40,
  ams_humidity_fair: 60,
  ams_temp_good: 30,
  ams_temp_fair: 35,
  ams_history_retention_days: 30,
  time_format: 'system',
  date_format: 'system',
  require_plate_clear: false,
  door_cycle_clears_plate: false,
  queue_max_concurrent_uploads: 1,
  use_slicer_api: false,
  preferred_slicer: 'bambu_studio',
  queue_drying_enabled: false,
  queue_drying_block: false,
  ambient_drying_enabled: false,
  print_drying_enabled: false,
  disable_filament_warnings: false,
  prefer_lowest_filament: false,
  per_printer_mapping_expanded: false,
  check_updates: false,
  check_printer_firmware: false,
  bed_cooled_threshold: 35,
};

/** Serves the settings page and records each autosaved patch. */
function useSettings(overrides: Record<string, unknown> = {}) {
  const saves: Record<string, unknown>[] = [];
  server.use(
    http.get('/api/v1/settings/', () => HttpResponse.json({ ...baseSettings, ...overrides })),
    http.put('/api/v1/settings/', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      saves.push(body);
      return HttpResponse.json({ ...baseSettings, ...overrides, ...body });
    }),
    http.get('/api/v1/printers/', () => HttpResponse.json([])),
    http.get('/api/v1/smart-plugs/', () => HttpResponse.json([])),
    http.get('/api/v1/notifications/', () => HttpResponse.json([])),
    http.get('/api/v1/api-keys/', () => HttpResponse.json([])),
    http.get('/api/v1/virtual-printer/status', () => HttpResponse.json({ running: false })),
    http.get('/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: false, requires_setup: false })),
    http.get('/api/v1/external-links/', () => HttpResponse.json([])),
  );
  return saves;
}

function lastSaved(saves: Record<string, unknown>[], key: string) {
  const matching = saves.filter((body) => key in body);
  return matching.length ? matching[matching.length - 1][key] : undefined;
}

/** Open a tab and wait for the settings to load, then let the load guard clear. */
async function openTab(user: ReturnType<typeof userEvent.setup>, tab: string, marker: string) {
  render(<SettingsPage />);
  await waitFor(() => expect(screen.getByText('Date Format')).toBeInTheDocument());
  await user.click(screen.getAllByText(tab).find((el) => el.tagName === 'BUTTON') ?? screen.getAllByText(tab)[0]);
  await screen.findByText(marker);
  // The page clears its initial-load guard on a 100 ms timer started when the settings load. This
  // later timer is registered after that one, so timers fire in order and the guard is always clear.
  await new Promise((resolve) => setTimeout(resolve, 150));
}

/** The switch on the row that carries a given label. */
function rowSwitch(label: string): HTMLElement {
  const row = screen.getByText(label).parentElement?.parentElement as HTMLElement;
  return within(row).getByRole('checkbox');
}

/** The input or select that sits beside a field label. */
function fieldFor(label: string): HTMLElement {
  const field = screen.getByText(label).parentElement?.querySelector<HTMLElement>('input, select');
  if (!field) throw new Error(`no field under label ${label}`);
  return field;
}

beforeEach(() => {
  window.history.replaceState({}, '', '/');
  localStorage.clear();
});

describe('SettingsPage Queue tab', () => {
  it('saves the plate-clear confirmation switches', async () => {
    const saves = useSettings();
    const user = userEvent.setup();
    await openTab(user, 'Workflow', 'Require plate-clear confirmation');

    await user.click(rowSwitch('Require plate-clear confirmation'));
    await waitFor(() => expect(lastSaved(saves, 'require_plate_clear')).toBe(true));

    await user.click(rowSwitch('Door open-close marks plate clear'));
    await waitFor(() => expect(lastSaved(saves, 'door_cycle_clears_plate')).toBe(true));
  });

  it('clamps concurrent uploads between one and sixteen', async () => {
    const saves = useSettings();
    const user = userEvent.setup();
    await openTab(user, 'Workflow', 'Printer sessions in flight');

    fireEvent.change(fieldFor('Printer sessions in flight'), { target: { value: '40' } });
    await waitFor(() => expect(lastSaved(saves, 'queue_max_concurrent_uploads')).toBe(16));

    fireEvent.change(fieldFor('Printer sessions in flight'), { target: { value: '0' } });
    await waitFor(() => expect(lastSaved(saves, 'queue_max_concurrent_uploads')).toBe(1));
  });

  it('switches the preferred slicer and the slicer API', async () => {
    const saves = useSettings();
    const user = userEvent.setup();
    await openTab(user, 'Workflow', 'Preferred Slicer');

    await user.selectOptions(fieldFor('Preferred Slicer'), 'orcaslicer');
    await waitFor(() => expect(lastSaved(saves, 'preferred_slicer')).toBe('orcaslicer'));

    await user.click(rowSwitch('Use Slicer API'));
    await waitFor(() => expect(lastSaved(saves, 'use_slicer_api')).toBe(true));
  });

  it('turns on drying, and only offers the wait option once auto-drying is on', async () => {
    const saves = useSettings();
    const user = userEvent.setup();
    await openTab(user, 'Workflow', 'Enable auto-drying');

    expect(screen.queryByText('Wait for drying to complete')).not.toBeInTheDocument();
    await user.click(rowSwitch('Enable auto-drying'));
    await waitFor(() => expect(lastSaved(saves, 'queue_drying_enabled')).toBe(true));

    await user.click(rowSwitch('Wait for drying to complete'));
    await waitFor(() => expect(lastSaved(saves, 'queue_drying_block')).toBe(true));

    await user.click(rowSwitch('Ambient drying'));
    await waitFor(() => expect(lastSaved(saves, 'ambient_drying_enabled')).toBe(true));

    await user.click(rowSwitch('Continue drying while printing'));
    await waitFor(() => expect(lastSaved(saves, 'print_drying_enabled')).toBe(true));
  });
});

describe('SettingsPage Filament tab', () => {
  it('saves the filament check switches', async () => {
    const saves = useSettings();
    const user = userEvent.setup();
    await openTab(user, 'Filament', 'Disable filament warnings');

    await user.click(rowSwitch('Disable filament warnings'));
    await waitFor(() => expect(lastSaved(saves, 'disable_filament_warnings')).toBe(true));

    await user.click(rowSwitch('Prefer lowest remaining filament'));
    await waitFor(() => expect(lastSaved(saves, 'prefer_lowest_filament')).toBe(true));

    await user.click(rowSwitch('Expand custom mapping by default'));
    await waitFor(() => expect(lastSaved(saves, 'per_printer_mapping_expanded')).toBe(true));
  });

  it('saves the AMS humidity, temperature and history thresholds', async () => {
    const saves = useSettings();
    const user = userEvent.setup();
    await openTab(user, 'Filament', 'Keep sensor history for');

    fireEvent.change(fieldFor('Good (green) ≤'), { target: { value: '30' } });
    await waitFor(() => expect(lastSaved(saves, 'ams_humidity_good')).toBe(30));

    fireEvent.change(fieldFor('Good (blue) ≤'), { target: { value: '25.5' } });
    await waitFor(() => expect(lastSaved(saves, 'ams_temp_good')).toBe(25.5));

    fireEvent.change(fieldFor('Keep sensor history for'), { target: { value: '90' } });
    await waitFor(() => expect(lastSaved(saves, 'ams_history_retention_days')).toBe(90));
  });
});

describe('SettingsPage humidity thresholds', () => {
  /** The row of the humidity table for one filament type. */
  function thresholdInput(filament: string): HTMLInputElement {
    const table = screen.getByText('Threshold').closest('table') as HTMLElement;
    const row = within(table).getByText(filament).closest('tr') as HTMLElement;
    return within(row).getByRole('spinbutton') as HTMLInputElement;
  }

  it('saves a per-filament humidity threshold when Enter is pressed', async () => {
    const saves = useSettings();
    const user = userEvent.setup();
    await openTab(user, 'Workflow', 'Humidity Thresholds');

    await user.type(thresholdInput('PLA'), '{Control>}a{/Control}25{Enter}');

    await waitFor(() => expect(JSON.parse(lastSaved(saves, 'ams_humidity_thresholds') as string)).toEqual({ PLA: 25 }));
  });

  it('clamps a threshold into the 5 to 95 range', async () => {
    const saves = useSettings();
    const user = userEvent.setup();
    await openTab(user, 'Workflow', 'Humidity Thresholds');

    await user.type(thresholdInput('PETG'), '{Control>}a{/Control}150');
    await user.click(document.body);

    await waitFor(() => expect(JSON.parse(lastSaved(saves, 'ams_humidity_thresholds') as string)).toEqual({ PETG: 95 }));
  });

  it('drops an override when its field is cleared', async () => {
    const saves = useSettings({ ams_humidity_thresholds: JSON.stringify({ PLA: 30, PETG: 45 }) });
    const user = userEvent.setup();
    await openTab(user, 'Workflow', 'Humidity Thresholds');

    await user.type(thresholdInput('PLA'), '{Control>}a{/Control}{Backspace}');
    await user.click(document.body);

    await waitFor(() => expect(JSON.parse(lastSaved(saves, 'ams_humidity_thresholds') as string)).toEqual({ PETG: 45 }));
  });
});
