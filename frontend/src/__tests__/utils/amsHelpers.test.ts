import { describe, expect, it } from 'vitest';

import { getSlotPresetKey } from '../../utils/amsHelpers';

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
