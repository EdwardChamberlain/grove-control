import { useTranslation } from 'react-i18next';
import type { FilamentMaterialPayload, ModelFilamentOptions } from '../../api/client';
import { FilamentProfileRow } from './FilamentProfileRow';
import type { FilamentReqsData } from './types';

export type FilamentOverrideSelection = {
  material: FilamentMaterialPayload;
};

interface FilamentOverrideProps {
  filamentReqs: FilamentReqsData | undefined;
  availableOptions: ModelFilamentOptions | undefined;
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
  availableOptions,
  overrides,
  onChange,
}: FilamentOverrideProps) {
  const { t } = useTranslation();

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
      const selected = availableOptions?.slots
        .flatMap((slot) => slot.options)
        .find((option) => materialKey(option.material) === value);
      if (!selected) return;
      onChange({
        ...overrides,
        [slotId]: {
          material: selected.material,
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
        {filaments.map((req) => {
          const override = overrides[req.slot_id];
          const isOverridden = !!override;
          const slot = availableOptions?.slots.find((item) => item.slot_id === req.slot_id);
          const requiredMaterial = slot?.material;
          const options = slot?.options ?? [];
          const overrideKey = isOverridden ? materialKey(overrides[req.slot_id].material) : '';

          return (
            <FilamentProfileRow
              key={req.slot_id}
              requiredColor={req.color}
              requiredLabel={requiredMaterial?.material_label || req.type}
              usedGrams={req.used_grams}
              requiredTitle={requiredMaterial?.display_name || req.type}
              value={overrideKey}
              emptyLabel={`${t('printModal.originalFilament')}: ${requiredMaterial?.display_name || req.type}`}
              options={options.map((option) => ({
                value: materialKey(option.material),
                label: option.material.display_name,
              }))}
              onChange={(value) => handleChange(req.slot_id, value)}
              disabled={options.length === 0}
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

function materialKey(material: FilamentMaterialPayload): string {
  return [material.family, material.subtype || '', material.color_hex, material.profile_id || ''].join('|');
}
