import { describe, expect, it } from 'vitest';

import { getAmsSlotExtruderId, getSlotPresetKey } from '../../utils/amsHelpers';

describe('getSlotPresetKey', () => {
  it('keys regular AMS slots by unit and tray', () => {
    expect(getSlotPresetKey(0, 0)).toBe(0);
    expect(getSlotPresetKey(2, 3)).toBe(11);
  });

  it('keys AMS-HT slots by unit ID', () => {
    expect(getSlotPresetKey(128, 0)).toBe(128);
    expect(getSlotPresetKey(135, 0)).toBe(135);
  });

  it('keys external spool slots using ams_id 255', () => {
    expect(getSlotPresetKey(255, 0)).toBe(1020);
    expect(getSlotPresetKey(255, 1)).toBe(1021);
  });
});

describe('getAmsSlotExtruderId', () => {
  it('uses the printer mapping for regular and HT AMS units', () => {
    const amsExtruderMap = { '0': 0, '128': 1 };
    expect(getAmsSlotExtruderId({ amsId: 0, trayId: 2, isDualNozzle: true, amsExtruderMap })).toBe(0);
    expect(getAmsSlotExtruderId({ amsId: 128, trayId: 0, isDualNozzle: true, amsExtruderMap })).toBe(1);
  });

  it('maps dual-nozzle external slots to their fixed left and right extruders', () => {
    expect(getAmsSlotExtruderId({ amsId: 255, trayId: 0, isDualNozzle: true })).toBe(1);
    expect(getAmsSlotExtruderId({ amsId: 255, trayId: 1, isDualNozzle: true })).toBe(0);
  });

  it('does not filter external K-profiles on single-nozzle printers', () => {
    expect(getAmsSlotExtruderId({ amsId: 255, trayId: 0, isDualNozzle: false })).toBeUndefined();
  });
});
