import { useMemo } from 'react';
import { FilamentMaterial, type FilamentMaterialJson } from '../../utils/filamentMaterial';

/** Legacy export retained for callers/tests that still strip vendor prefixes. */
export function extractMaterialHint(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length <= 1) return name.trim();
  return parts.slice(1).join(' ');
}

export interface FilamentLabel {
  resolvedName: string;
  colorLabel: string;
}

interface FilamentReqLike {
  type: string;
  color: string;
  tray_info_idx?: string;
  material?: FilamentMaterialJson;
}

/** Resolve per-slot labels from canonical material data, without catalogue names. */
export function useFilamentLabels(reqs: readonly FilamentReqLike[] | undefined): FilamentLabel[] {
  return useMemo(
    () =>
      (reqs || []).map((req) => {
        const material = FilamentMaterial.fromRequirement(req);
        return {
          resolvedName: material.materialLabel || req.type,
          colorLabel: material.genericColorName,
        };
      }),
    [reqs],
  );
}
