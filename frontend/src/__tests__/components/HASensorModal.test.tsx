/**
 * The Home Assistant sensor modal (#1148, #448).
 *
 * Focused on the unconfigured-Home-Assistant path, which is the state a first
 * time user is actually in: the entity picker can only ever come back empty
 * there, and an empty list reads as "I have no sensors" rather than as "you
 * have not connected Home Assistant yet".
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HASensorModal } from '../../components/HASensorModal';
import { api } from '../../api/client';
import { render } from '../utils';

vi.mock('../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../api/client')>('../../api/client');
  return {
    ...actual,
    api: { ...actual.api, getSettings: vi.fn(), getBindableHAEntities: vi.fn(), updateHASensor: vi.fn() },
  };
});

const getSettings = vi.mocked(api.getSettings);
const getEntities = vi.mocked(api.getBindableHAEntities);
const updateSensor = vi.mocked(api.updateHASensor);

const PRINTERS = [{ id: 4, name: 'X1C-1' }] as never;

function settings(overrides = {}) {
  return {
    ha_enabled: true,
    ha_url: 'http://homeassistant.local:8123',
    ha_token: 'token',
    ...overrides,
  } as never;
}

describe('HASensorModal', () => {
  beforeEach(() => {
    getSettings.mockReset();
    getEntities.mockReset();
    getEntities.mockResolvedValue([]);
  });

  it('warns when Home Assistant is not configured at all', async () => {
    getSettings.mockResolvedValue(settings({ ha_enabled: false, ha_url: '', ha_token: '' }));

    render(<HASensorModal printers={PRINTERS} onClose={() => {}} />);

    expect(
      await screen.findByText(/Home Assistant is not configured/)
    ).toBeInTheDocument();
    expect(screen.getByText('Settings → Network → Home Assistant')).toBeInTheDocument();
  });

  it('warns when the integration is configured but switched off', async () => {
    getSettings.mockResolvedValue(settings({ ha_enabled: false }));

    render(<HASensorModal printers={PRINTERS} onClose={() => {}} />);

    expect(await screen.findByText(/Home Assistant is not configured/)).toBeInTheDocument();
  });

  it('does not ask Home Assistant for entities it cannot reach', async () => {
    getSettings.mockResolvedValue(settings({ ha_token: '' }));

    render(<HASensorModal printers={PRINTERS} onClose={() => {}} />);

    await screen.findByText(/Home Assistant is not configured/);
    expect(getEntities).not.toHaveBeenCalled();
  });

  it('blocks saving a new sensor while unconfigured', async () => {
    getSettings.mockResolvedValue(settings({ ha_enabled: false }));

    render(<HASensorModal printers={PRINTERS} onClose={() => {}} />);

    await screen.findByText(/Home Assistant is not configured/);
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  });

  it('shows no warning once Home Assistant is configured', async () => {
    getSettings.mockResolvedValue(settings());

    render(<HASensorModal printers={PRINTERS} onClose={() => {}} />);

    await waitFor(() => expect(getEntities).toHaveBeenCalled());
    expect(screen.queryByText(/Home Assistant is not configured/)).not.toBeInTheDocument();
  });

  it('shows a spinner on Save while an edited sensor is being saved', async () => {
    getSettings.mockResolvedValue(settings());
    updateSensor.mockReturnValue(new Promise(() => {}));
    const sensor = {
      id: 9,
      printer_id: 4,
      name: 'Enclosure door',
      entity_id: 'binary_sensor.door',
      kind: 'binary',
      device_class: 'door',
      unit: null,
      alert_state: null,
      alert_above: null,
      alert_below: null,
      block_print: false,
      notify_on_alert: false,
      show_on_printer_card: true,
    } as never;

    render(<HASensorModal sensor={sensor} printers={PRINTERS} onClose={() => {}} />);
    await waitFor(() => expect(getEntities).toHaveBeenCalled());

    const save = screen.getByRole('button', { name: /save/i });
    fireEvent.click(save);

    await waitFor(() => expect(save.querySelector('.spinner')).not.toBeNull());
    expect(save).toBeDisabled();
  });
});
