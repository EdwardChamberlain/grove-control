import type {
  AMSTray,
  InventorySpool,
  LinkedSpoolInfo,
  SlotPresetMapping,
  SpoolAssignment,
} from '../../api/client';
import { getColorName } from '../../utils/colors';
import {
  getFallbackSpoolTag,
  getSpoolmanFillLevel,
  isBambuLabSpool,
} from '../../utils/amsHelpers';
import type { FilamentData, InventoryConfig } from '../FilamentHoverCard';

export interface AmsSpoolmanSlotAssignment {
  printer_id: number;
  ams_id: number;
  tray_id: number;
  spoolman_spool_id: number;
}

export interface AmsSlotModel {
  trayTag?: string;
  linkedSpool?: LinkedSpoolInfo;
  spoolmanAssignment?: AmsSpoolmanSlotAssignment;
  spoolmanSpool?: InventorySpool;
  inventoryAssignment?: SpoolAssignment;
  inventoryAvailable: boolean;
  isBambuLab: boolean;
  canLinkSpool: boolean;
  fillLevel: number | null;
  filamentData: FilamentData | null;
}

export function buildAmsInventoryConfig(
  model: AmsSlotModel,
  callbacks: {
    onAssignSpool: () => void;
    onUnassignSpoolmanSpool?: (spoolId: number) => void;
    onUnassignInventorySpool?: () => void;
  },
): InventoryConfig | undefined {
  if (!model.filamentData || !model.inventoryAvailable) return undefined;

  const assignedSpool = model.spoolmanAssignment
    ? model.spoolmanSpool
    : model.inventoryAssignment?.spool;
  const isSpoolmanAssignment = !!model.spoolmanAssignment;

  return {
    assignedSpool: assignedSpool ? {
      id: assignedSpool.id,
      material: assignedSpool.material,
      brand: assignedSpool.brand ?? null,
      color_name: assignedSpool.color_name ?? null,
      remainingWeightGrams: assignedSpool.label_weight
        ? Math.max(0, Math.round(assignedSpool.label_weight - assignedSpool.weight_used))
        : undefined,
    } : null,
    onAssignSpool: callbacks.onAssignSpool,
    onUnassignSpool: !model.isBambuLab && assignedSpool
      ? isSpoolmanAssignment
        ? () => callbacks.onUnassignSpoolmanSpool?.(assignedSpool.id)
        : callbacks.onUnassignInventorySpool
      : undefined,
    isAssigned: !!model.spoolmanAssignment || !!model.inventoryAssignment || model.isBambuLab,
  };
}

export function resolveAmsSlotModel({
  tray,
  printerId,
  printerSerial,
  amsId,
  trayId,
  slotPreset,
  cloudInfo,
  spoolmanEnabled,
  spoolmanLoading,
  linkedSpools,
  spoolmanSpools,
  spoolmanSlotAssignments,
  inventoryAssignment,
}: {
  tray?: AMSTray;
  printerId: number;
  printerSerial: string;
  amsId: number;
  trayId: number;
  slotPreset?: SlotPresetMapping;
  cloudInfo?: { name: string } | null;
  spoolmanEnabled: boolean;
  spoolmanLoading: boolean;
  linkedSpools?: Record<string, LinkedSpoolInfo>;
  spoolmanSpools?: InventorySpool[];
  spoolmanSlotAssignments?: AmsSpoolmanSlotAssignment[];
  inventoryAssignment?: SpoolAssignment;
}): AmsSlotModel {
  const hasAmsFill = !!tray?.tray_type && tray.remain >= 0;
  const trayTag = (tray?.tray_uuid || tray?.tag_uid || getFallbackSpoolTag(printerSerial, amsId, trayId))?.toUpperCase();
  const linkedSpool = trayTag ? linkedSpools?.[trayTag] : undefined;
  const spoolmanFill = getSpoolmanFillLevel(linkedSpool);
  const spoolmanAssignment = spoolmanEnabled && !spoolmanLoading
    ? spoolmanSlotAssignments?.find(assignment => assignment.printer_id === printerId && assignment.ams_id === amsId && assignment.tray_id === trayId)
    : undefined;
  const spoolmanSpool = spoolmanAssignment
    ? spoolmanSpools?.find(spool => spool.id === spoolmanAssignment.spoolman_spool_id)
    : undefined;
  const spoolmanSlotFill = spoolmanSpool && (spoolmanSpool.label_weight ?? 0) > 0
    ? Math.round(Math.max(0, (spoolmanSpool.label_weight ?? 0) - spoolmanSpool.weight_used) / (spoolmanSpool.label_weight ?? 1) * 100)
    : null;
  const inventoryFill = inventoryAssignment?.spool && inventoryAssignment.spool.label_weight > 0
    ? Math.round(Math.max(0, inventoryAssignment.spool.label_weight - inventoryAssignment.spool.weight_used) / inventoryAssignment.spool.label_weight * 100)
    : null;
  // Inventory usage can temporarily exceed its label weight. When the printer
  // still reports filament, trust the live AMS value instead of showing 0%.
  const resolvedInventoryFill = inventoryFill === 0 && hasAmsFill && tray.remain > 0 ? null : inventoryFill;
  const fillLevel = spoolmanFill ?? spoolmanSlotFill ?? resolvedInventoryFill ?? (hasAmsFill ? tray.remain : null);
  const fillSource = spoolmanFill != null || spoolmanSlotFill != null
    ? 'spoolman' as const
    : resolvedInventoryFill != null
      ? 'inventory' as const
      : hasAmsFill
        ? 'ams' as const
        : undefined;
  const profile = slotPreset?.preset_name
    || (spoolmanSpool
      ? [spoolmanSpool.brand, spoolmanSpool.slicer_filament_name?.split('@')[0].trim() || spoolmanSpool.material].filter(Boolean).join(' ').trim()
      : null)
    || inventoryAssignment?.spool?.slicer_filament_name
    || cloudInfo?.name
    || tray?.tray_sub_brands
    || tray?.tray_type
    || '';
  const isBambuLab = !!tray && isBambuLabSpool(tray);

  return {
    trayTag,
    linkedSpool,
    spoolmanAssignment,
    spoolmanSpool,
    inventoryAssignment,
    inventoryAvailable: !spoolmanEnabled || !spoolmanLoading,
    isBambuLab,
    canLinkSpool: spoolmanEnabled && !spoolmanAssignment && !inventoryAssignment,
    fillLevel,
    filamentData: tray?.tray_type ? {
      vendor: isBambuLab ? 'Bambu Lab' : 'Generic',
      profile,
      colorName: getColorName(tray.tray_color || ''),
      colorHex: tray.tray_color || null,
      kFactor: (tray.k ?? 0.020).toFixed(3),
      fillLevel,
      trayUuid: tray.tray_uuid || null,
      tagUid: tray.tag_uid || null,
      fillSource,
    } : null,
  };
}
