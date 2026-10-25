/**
 * Location sensor defaults: merging server alert defaults with local
 * preferences, colour preferences, and alert status for readings.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { LocationHASensorReading } from '../../api/client';
import {
  defaultLocationSensorDefaults,
  loadLocationSensorAlertAboveColor,
  loadLocationSensorAlertBelowColor,
  loadLocationSensorAlertOptimalColor,
  loadLocationSensorColorizeValues,
  loadLocationSensorDefaults,
  locationSensorReadingAlertStatus,
  locationSensorValueColorClass,
  saveLocationSensorAlertAboveColor,
  saveLocationSensorAlertBelowColor,
  saveLocationSensorAlertOptimalColor,
  saveLocationSensorColorizeValues,
  saveLocationSensorShowOnCardDefaults,
  serializeLocationSensorAlertDefaults,
  useLocationSensorColorPrefs,
} from '../../utils/locationSensorDefaults';

let store: Record<string, string>;

beforeEach(() => {
  store = {};
  vi.mocked(localStorage.getItem).mockImplementation((key: string) => store[key] ?? null);
  vi.mocked(localStorage.setItem).mockImplementation((key: string, value: string) => {
    store[key] = value;
  });
});

afterEach(() => {
  vi.mocked(localStorage.getItem).mockReset();
  vi.mocked(localStorage.setItem).mockReset();
});

function breakStorage() {
  vi.mocked(localStorage.getItem).mockImplementation(() => {
    throw new Error('blocked');
  });
  vi.mocked(localStorage.setItem).mockImplementation(() => {
    throw new Error('blocked');
  });
}

describe('alert defaults', () => {
  it('uses the built-ins when nothing is stored', () => {
    expect(loadLocationSensorDefaults()).toEqual(defaultLocationSensorDefaults());
    expect(loadLocationSensorDefaults('')).toEqual(defaultLocationSensorDefaults());
  });

  it('takes only valid alert fields from the server setting', () => {
    const merged = loadLocationSensorDefaults(
      JSON.stringify({
        temperature: { alertAbove: '35', alertBelow: 18, notifyOnAlert: true, showOnCard: false, evil: 'x' },
        battery: { notifyOnAlert: 'yes' },
      }),
    );

    expect(merged.temperature).toEqual({ alertAbove: '35', alertBelow: '20', notifyOnAlert: true, showOnCard: true });
    expect(merged.battery.notifyOnAlert).toBe(false);
    expect(merged.humidity).toEqual(defaultLocationSensorDefaults().humidity);
  });

  it('ignores a corrupted setting', () => {
    expect(loadLocationSensorDefaults('{nope')).toEqual(defaultLocationSensorDefaults());
  });

  it('round-trips through serialise and keeps show-on-card per browser', () => {
    const defaults = defaultLocationSensorDefaults();
    defaults.humidity.alertAbove = '50';
    defaults.battery.showOnCard = false;

    saveLocationSensorShowOnCardDefaults(defaults);
    const loaded = loadLocationSensorDefaults(serializeLocationSensorAlertDefaults(defaults));

    expect(loaded.humidity.alertAbove).toBe('50');
    expect(loaded.battery.showOnCard).toBe(false);
    expect(JSON.parse(serializeLocationSensorAlertDefaults(defaults)).battery).not.toHaveProperty('showOnCard');
  });

  it('survives unavailable or corrupted storage', () => {
    store['bambuddy-location-sensor-show-on-card-defaults'] = '{bad';
    expect(loadLocationSensorDefaults().temperature.showOnCard).toBe(true);

    breakStorage();
    expect(loadLocationSensorDefaults().temperature.showOnCard).toBe(true);
    expect(() => saveLocationSensorShowOnCardDefaults(defaultLocationSensorDefaults())).not.toThrow();
  });
});

describe('colour preferences', () => {
  it('defaults, saves and validates colours', () => {
    expect([
      loadLocationSensorColorizeValues(),
      loadLocationSensorAlertAboveColor(),
      loadLocationSensorAlertBelowColor(),
      loadLocationSensorAlertOptimalColor(),
    ]).toEqual([true, 'purple', 'red', 'green']);

    saveLocationSensorColorizeValues(false);
    saveLocationSensorAlertAboveColor('orange');
    saveLocationSensorAlertBelowColor('blue');
    saveLocationSensorAlertOptimalColor('pink');

    expect([
      loadLocationSensorColorizeValues(),
      loadLocationSensorAlertAboveColor(),
      loadLocationSensorAlertBelowColor(),
      loadLocationSensorAlertOptimalColor(),
    ]).toEqual([false, 'orange', 'blue', 'pink']);

    store['bambuddy-location-sensor-alert-above-color'] = 'chartreuse';
    expect(loadLocationSensorAlertAboveColor()).toBe('purple');
  });

  it('falls back when storage is blocked', () => {
    breakStorage();

    expect([
      loadLocationSensorColorizeValues(),
      loadLocationSensorAlertAboveColor(),
      loadLocationSensorAlertBelowColor(),
      loadLocationSensorAlertOptimalColor(),
    ]).toEqual([true, 'purple', 'red', 'green']);
    for (const save of [
      () => saveLocationSensorColorizeValues(true),
      () => saveLocationSensorAlertAboveColor('red'),
      () => saveLocationSensorAlertBelowColor('red'),
      () => saveLocationSensorAlertOptimalColor('red'),
    ]) {
      expect(save).not.toThrow();
    }
  });

  it('the hook updates when a preference is saved', () => {
    const { result, unmount } = renderHook(() => useLocationSensorColorPrefs());
    expect(result.current.aboveColor).toBe('purple');

    act(() => saveLocationSensorAlertAboveColor('yellow'));

    expect(result.current.aboveColor).toBe('yellow');
    unmount();
  });
});

describe('alert status', () => {
  const numeric = (overrides: Partial<LocationHASensorReading>): LocationHASensorReading =>
    ({
      reachable: true,
      state: '25',
      kind: 'numeric',
      value: 25,
      alert_above: 30,
      alert_below: 20,
      alert_state: null,
      ...overrides,
    }) as LocationHASensorReading;

  it.each([
    [numeric({ value: 31 }), 'above'],
    [numeric({ value: 19 }), 'below'],
    [numeric({}), 'ok'],
    [numeric({ alert_above: null, alert_below: null }), null],
    [numeric({ value: null }), null],
    [numeric({ reachable: false }), null],
    [numeric({ state: null }), null],
    [numeric({ kind: 'binary', state: 'ON', alert_state: 'on' }), 'above'],
    [numeric({ kind: 'binary', state: 'off', alert_state: 'on' }), 'ok'],
    [numeric({ kind: 'binary', state: 'off', alert_state: null }), null],
  ])('%# → %s', (reading, status) => {
    expect(locationSensorReadingAlertStatus(reading)).toBe(status);
  });

  it('maps a status to a colour class', () => {
    expect(locationSensorValueColorClass('above', 'red', 'blue', 'green')).toBe('text-red-400');
    expect(locationSensorValueColorClass('below', 'red', 'blue', 'green')).toBe('text-blue-400');
    expect(locationSensorValueColorClass('ok', 'red', 'blue', 'green')).toBe('text-green-400');
    expect(locationSensorValueColorClass(null, 'red', 'blue', 'green')).toBe('');
  });
});
