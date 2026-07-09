import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Circle, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';
import { api } from '../../api/client';
import { useFilamentMapping } from '../../hooks/useFilamentMapping';
import { getGlobalTrayId, effectivePreferLowest } from '../../utils/amsHelpers';
import { FilamentMaterial } from '../../utils/filamentMaterial';
import { FilamentProfileRow } from './FilamentProfileRow';
import { useFilamentLabels } from './useFilamentLabels';
import type { FilamentMappingProps } from './types';

/**
 * Filament mapping UI for comparing required filaments with loaded AMS slots.
 * Shows auto-matched and manually overridden slot assignments.
 */
export function FilamentMapping({
  printerId,
  filamentReqs,
  manualMappings,
  onManualMappingChange,
  currencySymbol,
  defaultCostPerKg,
  defaultExpanded = false,
}: FilamentMappingProps & { defaultExpanded?: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  // Fetch printer status
  const { data: printerStatus } = useQuery({
    queryKey: ['printer-status', printerId],
    queryFn: () => api.getPrinterStatus(printerId),
    enabled: !!printerId,
  });

  const { data: assignments } = useQuery({
    queryKey: ['spool-assignments', printerId],
    queryFn: () => api.getAssignments(printerId),
    enabled: !!printerId,
  });

  // Settings + inventory map drive the same prefer-lowest + AMS-backup gate
  // the dispatcher uses (#1766). Without this, the per-slot dropdown's
  // auto-suggestion could disagree with what actually gets dispatched.
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: api.getSettings,
  });
  const { data: inventoryRemain } = useQuery({
    queryKey: ['printer-inventory-remain', printerId],
    queryFn: () => api.getInventoryRemain(printerId),
    enabled: !!printerId,
    staleTime: 30 * 1000,
  });
  const inventoryByTrayId = useMemo(() => {
    if (!inventoryRemain?.inventory_remain_g) return undefined;
    const map = new Map<number, number>();
    Object.entries(inventoryRemain.inventory_remain_g).forEach(([key, grams]) => {
      const gtid = Number(key);
      if (!Number.isNaN(gtid)) map.set(gtid, grams);
    });
    return map;
  }, [inventoryRemain]);
  const gatedPreferLowest = effectivePreferLowest(
    settings?.prefer_lowest_filament,
    printerStatus?.ams_filament_backup,
  );

  const { loadedFilaments, filamentComparison, hasTypeMismatch, hasColorMismatch } =
    useFilamentMapping(filamentReqs, printerStatus, manualMappings, gatedPreferLowest, inventoryByTrayId);

  // Per-slot sub-brand + material-disambiguated colour labels (#1718). Same
  // shared hook the model-mode FilamentOverride uses so both panels render
  // the same sliced-3MF identity. Falls back to the raw type / generic
  // colour bucket when the SKU is unknown or the by-material lookup hasn't
  // resolved — never blanks out the required row.
  const filamentLabels = useFilamentLabels(filamentReqs?.filaments);

  const trayCostMap = useMemo(() => {
    const map = new Map<number, number | null>();
    for (const assignment of assignments || []) {
      const isExternal = assignment.ams_id === 255;
      const globalTrayId = getGlobalTrayId(assignment.ams_id, assignment.tray_id, isExternal);
      map.set(globalTrayId, assignment.spool?.cost_per_kg ?? null);
    }
    return map;
  }, [assignments]);

  const trayRemainingWeightMap = useMemo(() => {
    const map = new Map<number, number | null>();
    for (const assignment of assignments || []) {
      const isExternal = assignment.ams_id === 255;
      const globalTrayId = getGlobalTrayId(assignment.ams_id, assignment.tray_id, isExternal);
      const spool = assignment.spool;
      if (!spool) {
        map.set(globalTrayId, null);
        continue;
      }
      map.set(globalTrayId, Math.max(0, Math.round((spool.label_weight ?? 0) - (spool.weight_used ?? 0))));
    }
    return map;
  }, [assignments]);

  const totalCost = useMemo(() => {
    let total = 0;
    for (const item of filamentComparison) {
      const trayId = item.loaded?.globalTrayId;
      if (trayId == null) continue;
      const assignedCost = trayCostMap.get(trayId) ?? null;
      const costPerKg = assignedCost ?? defaultCostPerKg;
      if (costPerKg > 0) {
        total += (item.used_grams / 1000) * costPerKg;
      }
    }
    return total;
  }, [filamentComparison, trayCostMap, defaultCostPerKg]);

  const hasAnyCost = useMemo(
    () => Array.from(trayCostMap.values()).some((v) => v != null && v > 0),
    [trayCostMap]
  );
  const hasFilamentReqs = filamentReqs?.filaments && filamentReqs.filaments.length > 0;
  const isDualNozzle = filamentReqs?.filaments?.some((f) => f.nozzle_id != null) ?? false;

  // Filament Track Switch: when installed, AMS-to-extruder mapping is dynamic
  // (any slot can be routed to either extruder), so the per-nozzle dropdown
  // filter is suppressed. fila_switch.in_slots[track] = currently fed slot,
  // fila_switch.out_extruders[track] = extruder that track terminates at. See #1162.
  const ftsInstalled = printerStatus?.fila_switch?.installed === true;
  const ftsExtruderForSlot = (globalTrayId: number): number | null => {
    const fs = printerStatus?.fila_switch;
    if (!fs?.installed) return null;
    const track = fs.in_slots.indexOf(globalTrayId);
    if (track < 0) return null;
    return fs.out_extruders[track] ?? null;
  };

  // Don't render if no filament requirements
  if (!hasFilamentReqs) {
    return null;
  }

  // Don't render until we have printer status to do the comparison
  if (!printerStatus) {
    return null;
  }

  // Determine status indicator color
  const statusColor = hasTypeMismatch
    ? '#f97316' // orange
    : hasColorMismatch
    ? '#facc15' // yellow
    : '#00ae42'; // green

  const handleSlotChange = (slotId: number, value: string) => {
    if (slotId > 0) {
      if (value === '') {
        // Clear manual override
        const next = { ...manualMappings };
        delete next[slotId];
        onManualMappingChange(next);
      } else {
        onManualMappingChange({
          ...manualMappings,
          [slotId]: parseInt(value, 10),
        });
      }
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      // Request fresh data from printer via MQTT pushall command
      await api.refreshPrinterStatus(printerId);
      // Wait a moment for printer to respond, then refetch
      await new Promise((r) => setTimeout(r, 500));
      await queryClient.refetchQueries({ queryKey: ['printer-status', printerId] });
    } finally {
      setIsRefreshing(false);
    }
  };

  return (
    <div className="mb-4">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-2 text-sm text-bambu-gray hover:text-white transition-colors w-full"
      >
        <Circle className="w-4 h-4" fill={statusColor} stroke="none" />
        <span>{t('printModal.filamentMapping')}</span>
        {hasTypeMismatch ? (
          <span className="text-xs text-orange-400">(Type not found)</span>
        ) : hasColorMismatch ? (
          <span className="text-xs text-yellow-400">(Color mismatch)</span>
        ) : (
          <span className="text-xs text-bambu-green">(Ready)</span>
        )}
        {isExpanded ? (
          <ChevronUp className="w-4 h-4 ml-auto" />
        ) : (
          <ChevronDown className="w-4 h-4 ml-auto" />
        )}
      </button>

      {isExpanded && (
        <div className="mt-2 bg-bambu-dark rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-bambu-gray">{t('printModal.mappingHint')}</span>
            <button
              type="button"
              onClick={handleRefresh}
              className="flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-bambu-gray/30 hover:border-bambu-gray hover:bg-bambu-dark-tertiary transition-colors text-bambu-gray hover:text-white"
              disabled={isRefreshing}
            >
              <RefreshCw className={`w-3 h-3 ${isRefreshing ? 'animate-spin' : ''}`} />
              <span>Re-read</span>
            </button>
          </div>
          {filamentComparison.map((item, idx) => {
            const slotId = item.slot_id ?? 0;
            const itemMaterial = FilamentMaterial.fromRequirement(item);
            const { resolvedName, colorLabel } = filamentLabels[idx] ?? {
              resolvedName: itemMaterial.materialLabel || item.type,
              colorLabel: itemMaterial.genericColorName,
            };
            const compatibleLoadedFilaments = loadedFilaments.filter(
              (filament) => itemMaterial.isFamilyMatch(filament.material),
            );
            const options = compatibleLoadedFilaments.map((filament) => {
              const remainingWeight = trayRemainingWeightMap.get(filament.globalTrayId);
              const remainingLabel = remainingWeight != null
                ? t('printModal.slotRemainingShort', {
                    grams: remainingWeight,
                    defaultValue: ` - ${remainingWeight}g left`,
                  })
                : '';
              const ftsTargetExtruder = ftsInstalled ? ftsExtruderForSlot(filament.globalTrayId) : null;
              const ftsBadge = ftsTargetExtruder == null
                ? ''
                : ` [${ftsTargetExtruder === 1 ? t('printModal.leftNozzle') : t('printModal.rightNozzle')}]`;
              return {
                value: String(filament.globalTrayId),
                label: `${filament.label}: ${filament.material.displayName}${remainingLabel}${ftsBadge}`,
              };
            });
            const nozzleBadge = isDualNozzle && item.nozzle_id != null ? (
              <span
                className="inline-flex items-center justify-center w-3.5 h-3.5 rounded text-[9px] font-bold leading-none bg-bambu-gray/20 text-bambu-gray shrink-0"
                title={item.nozzle_id === 1 ? t('printModal.leftNozzleTooltip') : t('printModal.rightNozzleTooltip')}
              >
                {item.nozzle_id === 1 ? t('printModal.leftNozzle') : t('printModal.rightNozzle')}
              </span>
            ) : undefined;
            return (
              <FilamentProfileRow
                key={slotId || idx}
                requiredColor={item.color}
                requiredLabel={resolvedName}
                usedGrams={item.used_grams}
                leadingBadge={nozzleBadge}
                requiredTitle={`Required: ${resolvedName} - ${colorLabel}`}
                value={item.loaded ? String(item.loaded.globalTrayId) : ''}
                emptyLabel={t('printModal.selectFilamentSlot')}
                options={options}
                onChange={(value) => handleSlotChange(slotId, value)}
                status={item.status}
                isManual={item.isManual}
                selectTitle={item.isManual ? t('printModal.manuallySelected') : t('printModal.automaticallyMatched')}
              />
            );
          })}
          <div className="text-xs text-bambu-gray">
            {t('printModal.totalCost')}{' '}
            <span className="text-white">
              {totalCost > 0 || hasAnyCost ? `${currencySymbol}${totalCost.toFixed(2)}` : 'N/A'}
            </span>
          </div>
          {hasTypeMismatch && (
            <p className="text-xs text-orange-400 mt-2">Required filament type not found in printer.</p>
          )}
        </div>
      )}
    </div>
  );
}
