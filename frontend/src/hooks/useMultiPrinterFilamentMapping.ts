import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { api, type FilamentMappingPreview, type FilamentMaterialView, type Printer, type PrinterStatus } from '../api/client';
import { formatSlotLabel } from '../utils/amsHelpers';
import type { FilamentRequirement } from './useFilamentMapping';

export type PrinterMatchStatus = 'full' | 'partial' | 'missing';

export interface PerPrinterConfig {
  useDefault: boolean;
  manualMappings: Record<number, number>;
  autoConfigured: boolean;
}

export interface LoadedFilament {
  globalTrayId: number;
  label: string;
  material: FilamentMaterialView;
}

export interface PrinterMappingResult {
  printerId: number;
  printerName: string;
  status: PrinterStatus | undefined;
  isLoading: boolean;
  loadedFilaments: LoadedFilament[];
  autoMapping: number[] | undefined;
  finalMapping: number[] | undefined;
  matchStatus: PrinterMatchStatus;
  exactMatches: number;
  typeOnlyMatches: number;
  missingTypes: number;
  totalSlots: number;
  config: PerPrinterConfig;
  comparisons: FilamentMappingPreview['comparisons'];
}

export interface UseMultiPrinterFilamentMappingResult {
  printerResults: PrinterMappingResult[];
  isLoading: boolean;
  perPrinterConfigs: Record<number, PerPrinterConfig>;
  updatePrinterConfig: (printerId: number, config: Partial<PerPrinterConfig>) => void;
  autoConfigureAll: () => void;
  autoConfigurePrinter: (printerId: number) => void;
  getFinalMapping: (printerId: number) => number[] | undefined;
  allPrintersReady: boolean;
}

const DEFAULT_PRINTER_CONFIG: PerPrinterConfig = {
  useDefault: true,
  manualMappings: {},
  autoConfigured: false,
};

function toLoadedFilaments(preview: FilamentMappingPreview | undefined): LoadedFilament[] {
  return (preview?.loaded_filaments ?? []).map((filament) => ({
    globalTrayId: filament.global_tray_id,
    label: formatSlotLabel(filament.ams_id, filament.tray_id, filament.is_ht, filament.is_external),
    material: filament.material,
  }));
}

function matchSummary(comparisons: FilamentMappingPreview['comparisons']): Pick<PrinterMappingResult, 'matchStatus' | 'exactMatches' | 'typeOnlyMatches' | 'missingTypes' | 'totalSlots'> {
  const exactMatches = comparisons.filter((comparison) => comparison.status === 'match').length;
  const typeOnlyMatches = comparisons.filter((comparison) => comparison.status === 'material_only').length;
  const missingTypes = comparisons.filter((comparison) => comparison.status === 'missing').length;
  return {
    matchStatus: missingTypes > 0 ? 'missing' : typeOnlyMatches > 0 ? 'partial' : 'full',
    exactMatches,
    typeOnlyMatches,
    missingTypes,
    totalSlots: comparisons.length,
  };
}

/**
 * Presents backend mapping decisions for each selected printer. The browser
 * sends user intent (requirements and explicit slot choices) but does not
 * parse material labels, choose candidates, or score compatibility.
 */
export function useMultiPrinterFilamentMapping(
  selectedPrinterIds: number[],
  printers: Printer[] | undefined,
  filamentReqs: { filaments: FilamentRequirement[] } | undefined,
  defaultMappings: Record<number, number>,
  perPrinterConfigs: Record<number, PerPrinterConfig>,
  setPerPrinterConfigs: React.Dispatch<React.SetStateAction<Record<number, PerPrinterConfig>>>,
  forceColorMatch: boolean,
): UseMultiPrinterFilamentMappingResult {
  const statusQueries = useQueries({
    queries: selectedPrinterIds.map((printerId) => ({
      queryKey: ['printer-status', printerId],
      queryFn: () => api.getPrinterStatus(printerId),
      enabled: selectedPrinterIds.length > 0,
      staleTime: 5000,
    })),
  });

  const previewQueries = useQueries({
    queries: selectedPrinterIds.map((printerId) => {
      const config = perPrinterConfigs[printerId] || DEFAULT_PRINTER_CONFIG;
      const manualMappings = config.useDefault ? defaultMappings : config.manualMappings;
      return {
        queryKey: ['filament-mapping-preview', printerId, filamentReqs?.filaments, manualMappings, forceColorMatch],
        queryFn: () => api.previewFilamentMapping(printerId, {
          filaments: filamentReqs?.filaments ?? [],
          manual_mappings: manualMappings,
          force_color_match: forceColorMatch,
        }),
        enabled: selectedPrinterIds.length > 0 && !!filamentReqs?.filaments?.length,
        staleTime: 5000,
      };
    }),
  });

  const printerResults = useMemo((): PrinterMappingResult[] => selectedPrinterIds.map((printerId, index) => {
    const config = perPrinterConfigs[printerId] || DEFAULT_PRINTER_CONFIG;
    const preview = previewQueries[index]?.data;
    const comparisons = preview?.comparisons ?? [];
    return {
      printerId,
      printerName: printers?.find((printer) => printer.id === printerId)?.name || `Printer ${printerId}`,
      status: statusQueries[index]?.data,
      isLoading: Boolean(statusQueries[index]?.isLoading || previewQueries[index]?.isLoading),
      loadedFilaments: toLoadedFilaments(preview),
      autoMapping: preview?.auto_mapping ?? undefined,
      finalMapping: preview?.mapping ?? undefined,
      comparisons,
      config,
      ...matchSummary(comparisons),
    };
  }), [selectedPrinterIds, printers, statusQueries, previewQueries, perPrinterConfigs]);

  const updatePrinterConfig = (printerId: number, updates: Partial<PerPrinterConfig>) => {
    setPerPrinterConfigs((previous) => ({
      ...previous,
      [printerId]: { ...(previous[printerId] || DEFAULT_PRINTER_CONFIG), ...updates },
    }));
  };

  const autoConfigurePrinter = (printerId: number) => {
    const mapping = printerResults.find((result) => result.printerId === printerId)?.autoMapping;
    if (!mapping) return;
    const manualMappings: Record<number, number> = {};
    mapping.forEach((trayId, index) => {
      if (trayId >= 0) manualMappings[index + 1] = trayId;
    });
    updatePrinterConfig(printerId, { useDefault: false, manualMappings, autoConfigured: true });
  };

  return {
    printerResults,
    isLoading: statusQueries.some((query) => query.isLoading) || previewQueries.some((query) => query.isLoading),
    perPrinterConfigs,
    updatePrinterConfig,
    autoConfigurePrinter,
    autoConfigureAll: () => selectedPrinterIds.forEach(autoConfigurePrinter),
    getFinalMapping: (printerId) => printerResults.find((result) => result.printerId === printerId)?.finalMapping,
    allPrintersReady: printerResults.every((result) => result.matchStatus !== 'missing'),
  };
}
