import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { canonicalFilamentType } from '../../utils/amsHelpers';
import { FilamentMaterial, filamentMaterialIdentityKey, type FilamentMaterialJson } from '../../utils/filamentMaterial';
import { FilamentProfileRow } from './FilamentProfileRow';
import { useFilamentLabels } from './useFilamentLabels';
import type { FilamentReqsData } from './types';

export type FilamentOverrideSelection = {
  type: string;
  color: string;
  material: FilamentMaterialJson;
};

interface FilamentOverrideProps {
  filamentReqs: FilamentReqsData | undefined;
  availableFilaments: Array<{ type: string; color: string; tray_info_idx: string; tray_sub_brands: string; extruder_id: number | null }>;
  overrides: Record<number, FilamentOverrideSelection>;
  onChange: (overrides: Record<number, FilamentOverrideSelection>) => void;

}

/**
 * Filament override UI for model-based queue assignment.
 * Allows users to override the 3MF's original filament choices with
 * filaments available across printers of the selected model.
 */
export function FilamentOverride({
  filamentReqs,
  availableFilaments,
  overrides,
  onChange,
}: FilamentOverrideProps) {
  const { t } = useTranslation();

  // Per-slot sub-brand + material-disambiguated colour labels (#1718). The
  // shared hook fronts the three queries that power the resolution so this
  // component and ``FilamentMapping`` cannot drift apart on label content.
  const labels = useFilamentLabels(filamentReqs?.filaments);

  const availableWithMaterial = useMemo(
    () =>
      availableFilaments.map((filament) => {
        const material = FilamentMaterial.fromAmsTray({
          tray_type: filament.type,
          tray_sub_brands: filament.tray_sub_brands,
          tray_color: filament.color,
          tray_info_idx: filament.tray_info_idx,
        });
        return {
          ...filament,
          material,
          value: filamentMaterialIdentityKey(material),
        };
      }),
    [availableFilaments],
  );

  // Index available filaments by canonical type for per-slot filtering.
  // Types in the same equivalence group (e.g. PA-CF / PA12-CF / PAHT-CF) share one bucket.
  const filamentsByType = useMemo(() => {
    const map: Record<string, typeof availableWithMaterial> = {};
    for (const f of availableWithMaterial) {
      const key = canonicalFilamentType(f.type);
      if (!map[key]) map[key] = [];
      map[key].push(f);
    }
    return map;
  }, [availableWithMaterial]);

  const filaments = filamentReqs?.filaments;
  if (!filaments || filaments.length === 0) {
    return null;
  }

  const handleChange = (slotId: number, value: string) => {
    if (value === '') {
      // Reset to original
      const next = { ...overrides };
      delete next[slotId];
      onChange(next);
    } else {
      const selected = availableWithMaterial.find((filament) => filament.value === value);
      if (!selected) return;
      onChange({
        ...overrides,
        [slotId]: {
          type: selected.material.family,
          color: selected.material.rgbHex,
          material: selected.material.toQueueJson(),
        },
      });
    }
  };

  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 text-sm text-bambu-gray mb-2">
        <span>{t('printModal.filamentOverride')}</span>
      </div>
      <p className="text-xs text-bambu-gray mb-2">{t('printModal.filamentOverrideHint')}</p>
      <div className="bg-bambu-dark rounded-lg p-3 space-y-2">
        {filaments.map((req, slotIdx) => {
          const override = overrides[req.slot_id];
          const isOverridden = !!override;
          // Only show filaments of the same type AND compatible nozzle/extruder
          const sameType = filamentsByType[canonicalFilamentType(req.type)] || [];
          // On dual-nozzle printers (H2D), filter to filaments on the correct extruder.
          // nozzle_id from 3MF maps to extruder_id from AMS. If nozzle_id is undefined
          // (single-nozzle) or extruder_id is null, no nozzle filtering is needed.
          const compatible = req.nozzle_id != null
            ? sameType.filter((f) => f.extruder_id == null || f.extruder_id === req.nozzle_id)
            : sameType;

          const reqMaterial = FilamentMaterial.fromRequirement(req);
          const { resolvedName, colorLabel } = labels[slotIdx] ?? {
            resolvedName: reqMaterial.materialLabel || req.type,
            colorLabel: reqMaterial.genericColorName,
          };

          return (
            <FilamentProfileRow
              key={req.slot_id}
              requiredColor={req.color}
              requiredLabel={resolvedName}
              usedGrams={req.used_grams}
              requiredTitle={`${t('printModal.originalFilament')}: ${resolvedName} - ${colorLabel}`}
              value={isOverridden ? filamentMaterialIdentityKey(FilamentMaterial.fromQueueOverride(override)) : ''}
              emptyLabel={`${t('printModal.originalFilament')}: ${resolvedName} (${colorLabel})`}
              options={compatible.map((filament) => ({
                value: filament.value,
                label: filament.material.displayName,
              }))}
              onChange={(value) => handleChange(req.slot_id, value)}
              disabled={compatible.length === 0}
              isManual={isOverridden}
              resetLabel={t('printModal.resetToOriginal')}
              onReset={isOverridden ? () => handleChange(req.slot_id, '') : undefined}
            />
          );
        })}
      </div>
    </div>
  );
}
