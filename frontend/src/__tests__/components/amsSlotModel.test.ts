import { describe, expect, it, vi } from 'vitest';
import type { AMSTray, InventorySpool, SpoolAssignment } from '../../api/client';
import { buildAmsInventoryConfig, resolveAmsSlotModel } from '../../components/printer/amsSlotModel';

function makeTray(overrides: Partial<AMSTray> = {}): AMSTray {
  return {
    id: 0,
    tray_color: 'FF0000FF',
    tray_type: 'PLA',
    tray_sub_brands: 'PLA Basic',
    tray_id_name: null,
    tray_info_idx: 'GFA00',
    remain: 75,
    k: 0.025,
    cali_idx: null,
    tag_uid: null,
    tray_uuid: null,
    nozzle_temp_min: null,
    nozzle_temp_max: null,
    drying_temp: null,
    drying_time: null,
    state: 10,
    ...overrides,
  };
}

function makeSpool(overrides: Partial<InventorySpool> = {}): InventorySpool {
  return {
    id: 10,
    material: 'PLA',
    subtype: null,
    color_name: 'Red',
    rgba: 'FF0000FF',
    extra_colors: null,
    effect_type: null,
    brand: 'Example',
    label_weight: 1000,
    core_weight: 250,
    core_weight_catalog_id: null,
    weight_used: 250,
    slicer_filament: null,
    slicer_filament_name: 'Example PLA @BBL X1C',
    nozzle_temp_min: null,
    nozzle_temp_max: null,
    ...overrides,
  };
}

function makeInventoryAssignment(spool = makeSpool()): SpoolAssignment {
  return {
    id: 20,
    spool_id: spool.id,
    printer_id: 1,
    printer_name: 'Printer',
    ams_id: 0,
    tray_id: 0,
    fingerprint_color: null,
    fingerprint_type: null,
    spool,
    configured: true,
    created_at: '2026-01-01T00:00:00Z',
  };
}

const baseArgs = {
  printerId: 1,
  printerSerial: 'SERIAL',
  amsId: 0,
  trayId: 0,
  spoolmanEnabled: false,
  spoolmanLoading: false,
};

describe('resolveAmsSlotModel', () => {
  it('uses saved slot presets before inventory and cloud profile names', () => {
    const model = resolveAmsSlotModel({
      ...baseArgs,
      tray: makeTray(),
      slotPreset: { ams_id: 0, tray_id: 0, preset_id: 'saved', preset_name: 'Saved PLA Profile' },
      cloudInfo: { name: 'Cloud PLA Profile' },
      inventoryAssignment: makeInventoryAssignment(),
    });

    expect(model.filamentData?.profile).toBe('Saved PLA Profile');
  });

  it('falls back to live AMS remaining when inventory temporarily reports 0%', () => {
    const model = resolveAmsSlotModel({
      ...baseArgs,
      tray: makeTray({ remain: 64 }),
      inventoryAssignment: makeInventoryAssignment(makeSpool({ weight_used: 1000 })),
    });

    expect(model.fillLevel).toBe(64);
    expect(model.filamentData?.fillSource).toBe('ams');
  });

  it('resolves cloud profiles for external spools', () => {
    const model = resolveAmsSlotModel({
      ...baseArgs,
      amsId: 255,
      tray: makeTray({ id: 254, tray_sub_brands: null }),
      cloudInfo: { name: 'External Cloud Profile' },
    });

    expect(model.filamentData?.profile).toBe('External Cloud Profile');
  });

  it('uses Spoolman slot assignment for profile and fill before inventory', () => {
    const spoolmanSpool = makeSpool({ id: 42, brand: 'Spoolman', label_weight: 1000, weight_used: 100 });
    const model = resolveAmsSlotModel({
      ...baseArgs,
      tray: makeTray(),
      spoolmanEnabled: true,
      spoolmanSlotAssignments: [{ printer_id: 1, ams_id: 0, tray_id: 0, spoolman_spool_id: 42 }],
      spoolmanSpools: [spoolmanSpool],
      inventoryAssignment: makeInventoryAssignment(makeSpool({ weight_used: 500 })),
    });

    expect(model.fillLevel).toBe(90);
    expect(model.filamentData?.fillSource).toBe('spoolman');
    expect(model.filamentData?.profile).toBe('Spoolman Example PLA');
    expect(model.canLinkSpool).toBe(false);
  });
});

describe('buildAmsInventoryConfig', () => {
  it('provides the same assigned spool and unassign action to every view', () => {
    const spool = makeSpool();
    const model = resolveAmsSlotModel({
      ...baseArgs,
      tray: makeTray(),
      inventoryAssignment: makeInventoryAssignment(spool),
    });
    const onUnassign = vi.fn();
    const config = buildAmsInventoryConfig(model, {
      onAssignSpool: vi.fn(),
      onUnassignInventorySpool: onUnassign,
    });

    expect(config?.assignedSpool).toMatchObject({ id: spool.id, remainingWeightGrams: 750 });
    expect(config?.isAssigned).toBe(true);
    config?.onUnassignSpool?.();
    expect(onUnassign).toHaveBeenCalledOnce();
  });

  it('hides inventory actions while Spoolman data is loading', () => {
    const model = resolveAmsSlotModel({
      ...baseArgs,
      tray: makeTray(),
      spoolmanEnabled: true,
      spoolmanLoading: true,
    });

    expect(buildAmsInventoryConfig(model, { onAssignSpool: vi.fn() })).toBeUndefined();
  });
});
