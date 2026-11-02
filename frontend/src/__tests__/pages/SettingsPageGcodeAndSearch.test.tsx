/**
 * SettingsPage: the per-model G-code injection editor on the Workflow tab, and
 * the settings search that jumps to a setting on another tab.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
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
  time_format: 'system',
  date_format: 'system',
  gcode_snippets: null as string | null,
  check_updates: false,
  check_printer_firmware: false,
  bed_cooled_threshold: 35,
};

/** Serves settings and printers, and records every settings PUT. */
function useSettings(overrides: Record<string, unknown> = {}, printers: unknown[] = []) {
  const saves: Record<string, unknown>[] = [];
  server.use(
    http.get('/api/v1/settings/', () => HttpResponse.json({ ...baseSettings, ...overrides })),
    http.put('/api/v1/settings/', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      saves.push(body);
      return HttpResponse.json({ ...baseSettings, ...overrides, ...body });
    }),
    http.get('/api/v1/printers/', () => HttpResponse.json(printers)),
    http.get('/api/v1/smart-plugs/', () => HttpResponse.json([])),
    http.get('/api/v1/notifications/', () => HttpResponse.json([])),
    http.get('/api/v1/api-keys/', () => HttpResponse.json([])),
    http.get('/api/v1/virtual-printer/status', () => HttpResponse.json({ running: false })),
    http.get('/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: false, requires_setup: false })),
    http.get('/api/v1/external-links/', () => HttpResponse.json([])),
  );
  return saves;
}

const printers = [
  { id: 1, name: 'X1 Carbon', model: 'X1C' },
  { id: 2, name: 'P1S', model: 'P1S' },
];

beforeEach(() => {
  window.history.replaceState({}, '', '/');
  localStorage.clear();
});

describe('SettingsPage G-code injection', () => {
  it('shows which printer models already have G-code configured', async () => {
    useSettings({ gcode_snippets: JSON.stringify({ X1C: { start_gcode: 'G28', end_gcode: '' } }) }, printers);
    const user = userEvent.setup();
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText('Date Format')).toBeInTheDocument());
    await user.click(screen.getAllByText('Workflow').find((el) => el.tagName === 'BUTTON') ?? screen.getAllByText('Workflow')[0]);

    expect(await screen.findByText('G-code Injection')).toBeInTheDocument();
    expect(screen.getByText('X1C')).toBeInTheDocument();
    expect(screen.getByText('P1S')).toBeInTheDocument();
    expect(screen.getAllByText('Configured')).toHaveLength(1);
  });

  it('saves a printer model\'s start G-code when the field loses focus', async () => {
    const saves = useSettings({}, printers);
    const user = userEvent.setup();
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText('Date Format')).toBeInTheDocument());
    await user.click(screen.getAllByText('Workflow').find((el) => el.tagName === 'BUTTON') ?? screen.getAllByText('Workflow')[0]);

    await user.click(await screen.findByRole('button', { name: /P1S/ }));
    await user.type(screen.getByPlaceholderText('G-code prepended before the print starts...'), 'M400');
    await user.click(document.body);

    await waitFor(() => expect(saves.length).toBeGreaterThan(0));
    const body = saves.at(-1) as { gcode_snippets: string };
    expect(Object.keys(body)).toEqual(['gcode_snippets']);
    expect(JSON.parse(body.gcode_snippets)).toEqual({ P1S: { start_gcode: 'M400', end_gcode: '' } });
  });

  it('explains that G-code needs printers when none are added', async () => {
    useSettings({}, []);
    const user = userEvent.setup();
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText('Date Format')).toBeInTheDocument());
    await user.click(screen.getAllByText('Workflow').find((el) => el.tagName === 'BUTTON') ?? screen.getAllByText('Workflow')[0]);

    expect(await screen.findByText('No printers found. Add printers to configure G-code snippets.')).toBeInTheDocument();
  });
});

describe('SettingsPage settings search', () => {
  it('shows a message when no setting matches', async () => {
    useSettings();
    const user = userEvent.setup();
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText('Date Format')).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText('Search settings…'), 'qqqqzzzz');
    expect(await screen.findByText('No matching settings.')).toBeInTheDocument();
  });

  it('jumps to the tab that holds a matching setting and clears the search', async () => {
    // The jump scrolls the card into view, which jsdom does not implement.
    Element.prototype.scrollIntoView = vi.fn();
    useSettings();
    const user = userEvent.setup();
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByText('Date Format')).toBeInTheDocument());

    const search = screen.getByPlaceholderText('Search settings…');
    await user.type(search, 'ftp retry');
    await user.click(await screen.findByRole('button', { name: /retry/i }));

    expect(await screen.findByText('Enable retry')).toBeInTheDocument();
    await waitFor(() => expect(search).toHaveValue(''));
  });
});
