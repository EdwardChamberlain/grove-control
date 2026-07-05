import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AMSTray } from '../../api/client';
import type { AmsSlotModel } from '../../components/printer/amsSlotModel';
import { useAmsSlotController } from '../../hooks/useAmsSlotController';

const tray: AMSTray = {
  id: 0,
  tray_color: 'FF0000FF',
  tray_type: 'PLA',
  tray_sub_brands: 'PLA Basic',
  tray_id_name: null,
  tray_info_idx: 'GFA00',
  remain: 75,
  k: 0.025,
  cali_idx: 3,
  tag_uid: 'tag-1',
  tray_uuid: 'uuid-1',
  nozzle_temp_min: null,
  nozzle_temp_max: null,
  drying_temp: null,
  drying_time: null,
  state: 10,
};

const filledModel: AmsSlotModel = {
  trayTag: 'TAG-1',
  inventoryAvailable: true,
  isBambuLab: false,
  canLinkSpool: true,
  fillLevel: 75,
  filamentData: {
    vendor: 'Generic',
    profile: 'Generic PLA',
    colorName: 'Red',
    colorHex: 'FF0000FF',
    kFactor: '0.025',
    fillLevel: 75,
    trayUuid: 'uuid-1',
    tagUid: 'tag-1',
  },
};

function renderController() {
  return renderHook(() => useAmsSlotController({
    printerId: 7,
    printerModel: 'X1C',
    spoolmanEnabled: true,
    canConfigure: true,
    onUnlinkSpool: vi.fn(),
  }));
}

describe('useAmsSlotController', () => {
  it('uses the same link, assign, and configure wiring for a populated slot', () => {
    const { result } = renderController();
    const bindings = result.current.getBindings({
      amsId: 2,
      trayId: 1,
      trayCount: 4,
      tray,
      slotPreset: { ams_id: 2, tray_id: 1, preset_id: 'preset-1', preset_name: 'PLA' },
      extruderId: 1,
      location: 'AMS-C Slot 2',
      model: filledModel,
    });

    act(() => bindings.spoolman?.onLinkSpool?.());
    expect(result.current.linkModal).toEqual({ tagUid: 'tag-1', trayUuid: 'uuid-1', amsId: 2, trayId: 1 });

    act(() => bindings.inventory?.onAssignSpool());
    expect(result.current.assignModal?.trayInfo).toEqual({
      type: 'PLA', material: 'PLA', profile: 'Generic PLA', color: 'FF0000FF', location: 'AMS-C Slot 2',
    });

    act(() => bindings.configureSlot.onConfigure());
    expect(result.current.configureModal).toMatchObject({
      amsId: 2, trayId: 1, trayCount: 4, trayType: 'PLA', extruderId: 1, caliIdx: 3, savedPresetId: 'preset-1',
    });
  });

  it('gives empty regular, HT, and external slots the same assign/configure behavior', () => {
    const { result } = renderController();
    const emptyModel: AmsSlotModel = { ...filledModel, canLinkSpool: false, filamentData: null };
    const bindings = result.current.getBindings({
      amsId: 255,
      trayId: 1,
      trayCount: 1,
      extruderId: 0,
      location: 'External',
      emptyLocation: 'External Slot 2',
      model: emptyModel,
    });

    act(() => bindings.onAssignSpool?.());
    expect(result.current.assignModal?.trayInfo).toEqual({ type: '', profile: '', color: '', location: 'External Slot 2' });

    act(() => bindings.configureSlot.onConfigure());
    expect(result.current.configureModal).toEqual({ amsId: 255, trayId: 1, trayCount: 1, extruderId: 0 });
    expect(bindings.spoolman).toBeUndefined();
  });
});
