import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, AlertTriangle, ChevronDown, ChevronUp, Loader2, Palette, Pencil, Printer, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PrintQueueItemCreate, PrintQueueItemUpdate, SmartPlug, SpoolAssignment } from '../../api/client';
import { api } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { Card, CardContent } from '../Card';
import { Button } from '../Button';
import { ConfirmModal } from '../ConfirmModal';
import { useToast } from '../../contexts/ToastContext';
import { buildLoadedFilaments, useFilamentMapping } from '../../hooks/useFilamentMapping';
import { useMultiPrinterFilamentMapping, type PerPrinterConfig } from '../../hooks/useMultiPrinterFilamentMapping';
import { getColorName } from '../../utils/colors';
import { getCurrencySymbol } from '../../utils/currency';
import { getBedTypeInfo } from '../../utils/bedType';
import { isGcodeCompatible } from '../../utils/printer';
import { toDateTimeLocalValue, parseUTCDate } from '../../utils/date';
import { getGlobalTrayId, effectivePreferLowest } from '../../utils/amsHelpers';
import { FilamentMapping } from './FilamentMapping';
import { FilamentOverride } from './FilamentOverride';
import { PlateSelector } from './PlateSelector';
import { PrinterSelector } from './PrinterSelector';
import { PrintOptionsPanel } from './PrintOptions';
import { ScheduleOptionsPanel } from './ScheduleOptions';
import { VariantCandidates, type VariantCandidate } from './VariantCandidates';
import type {
  AssignmentMode,
  PrintModalProps,
  PrintOptions,
  ScheduleOptions,
} from './types';
import { DEFAULT_PRINT_OPTIONS, DEFAULT_SCHEDULE_OPTIONS } from './types';

/**
 * Unified PrintModal component that handles queue item creation and editing.
 * - 'create': Create a print queue item from an archive or library file
 * - 'edit-queue-item': Edit existing queue item
 *
 * Both archiveId and libraryFileId are supported. Library files are archived at
 * print start time by the scheduler, not when queued.
 */
export function PrintModal({
  mode,
  archiveId,
  libraryFileId,
  archiveName,
  queueItem,
  initialSelectedPrinterIds,
  onClose,
  onSuccess,
  projectId,
  cleanupLibraryAfterDispatch,
  variantFiles,
}: PrintModalProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();

  // Determine if we're printing a library file
  const isLibraryFile = !!libraryFileId && !archiveId;
  const isEditing = mode === 'edit-queue-item';

  // Cross-model alternatives (#671). One candidate is not a choice, so a
  // single-entry list behaves exactly like an ordinary print.
  const isCrossModel = mode === 'create' && (variantFiles?.length ?? 0) > 1;
  // Editing an already-queued cross-model item. The candidates are shown so the
  // dialog doesn't misrepresent the job as a plain "Any H2D" — which is what it
  // did before, offering a printer picker whose Save would have left a row with
  // both variants and a printer_id. They are not editable here: changing the
  // set after queueing needs a variant-level API that doesn't exist, and the
  // backend refuses the printer/model change either way.
  const editingVariants: VariantCandidate[] =
    mode === 'edit-queue-item' && (queueItem?.variants?.length ?? 0) > 1
      ? queueItem!.variants!.map((v) => ({
          id: v.library_file_id,
          filename: v.filename,
          sliced_for_model: v.target_model,
        }))
      : [];
  const hasEditingVariants = editingVariants.length > 0;
  const [candidates, setCandidates] = useState<VariantCandidate[]>(variantFiles ?? []);
  const [candidatePlates, setCandidatePlates] = useState<Record<number, number | null>>({});

  type FilamentWarningItem = {
    printerName: string;
    slotLabel: string;
    requiredGrams: number;
    remainingGrams: number;
  };

  // Multiple printer selection (used for all modes now)
  const [selectedPrinters, setSelectedPrinters] = useState<number[]>(() => {
    // Initialize with the queue item's printer if editing
    if (mode === 'edit-queue-item' && queueItem?.printer_id) {
      return [queueItem.printer_id];
    }
    if (initialSelectedPrinterIds?.length) {
      return initialSelectedPrinterIds;
    }
    return [];
  });

  // Multi-select plates: create mode users can pick a subset of plates
  const [selectedPlates, setSelectedPlates] = useState<Set<number>>(() => {
    if (mode === 'edit-queue-item' && queueItem?.plate_id != null) {
      return new Set([queueItem.plate_id]);
    }
    return new Set();
  });

  // Derived single-plate value for filament queries and single-select contexts
  const selectedPlate = selectedPlates.size === 1 ? [...selectedPlates][0] : null;

  // Quantity — number of independent queue items to create.
  const [quantity, setQuantity] = useState(1);

  // Per-plate quantities for multi-plate files (#342). Keyed by plate index;
  // a plate with no entry means one run. Only used in create mode on a
  // multi-plate file, where it replaces the single global Quantity field.
  const [plateQuantities, setPlateQuantities] = useState<Record<number, number>>({});

  const [printOptions, setPrintOptions] = useState<PrintOptions>(() => {
    if (mode === 'edit-queue-item' && queueItem) {
      return {
        bed_levelling: queueItem.bed_levelling ?? DEFAULT_PRINT_OPTIONS.bed_levelling,
        flow_cali: queueItem.flow_cali ?? DEFAULT_PRINT_OPTIONS.flow_cali,
        vibration_cali: queueItem.vibration_cali ?? DEFAULT_PRINT_OPTIONS.vibration_cali,
        layer_inspect: queueItem.layer_inspect ?? DEFAULT_PRINT_OPTIONS.layer_inspect,
        timelapse: queueItem.timelapse ?? DEFAULT_PRINT_OPTIONS.timelapse,
        nozzle_offset_cali: queueItem.nozzle_offset_cali ?? DEFAULT_PRINT_OPTIONS.nozzle_offset_cali,
      };
    }
    return DEFAULT_PRINT_OPTIONS;
  });

  const [scheduleOptions, setScheduleOptions] = useState<ScheduleOptions>(() => {
    if (mode === 'edit-queue-item' && queueItem) {
      const scheduledTime = queueItem.scheduled_time
        ? toDateTimeLocalValue(parseUTCDate(queueItem.scheduled_time) ?? new Date())
        : '';
      return {
        insertAtTop: false,
        postponePrint: Boolean(queueItem.scheduled_time),
        scheduledTime,
        requireManualStart: queueItem.manual_start,
        requirePreviousSuccess: queueItem.require_previous_success,
        waitForDryingComplete: queueItem.wait_for_drying_complete ?? false,
        chamberHeatSoak: queueItem.chamber_heat_soak ?? false,
        heatSoakTemperature: queueItem.heat_soak_temperature ?? 60,
        heatSoakMinutes: queueItem.heat_soak_minutes ?? 30,
        autoOffAfter: queueItem.auto_off_after,
        gcodeInjection: queueItem.gcode_injection ?? false,
      };
    }
    return DEFAULT_SCHEDULE_OPTIONS;
  });

  // Manual slot overrides: slot_id (1-indexed) -> globalTrayId (default mapping for single printer or all printers)
  const [manualMappings, setManualMappings] = useState<Record<number, number>>(() => {
    if (mode === 'edit-queue-item' && queueItem?.ams_mapping && Array.isArray(queueItem.ams_mapping)) {
      const mappings: Record<number, number> = {};
      queueItem.ams_mapping.forEach((globalTrayId, idx) => {
        if (globalTrayId !== -1) {
          mappings[idx + 1] = globalTrayId;
        }
      });
      return mappings;
    }
    return {};
  });

  // Per-printer override configs (for multi-printer selection)
  const [perPrinterConfigs, setPerPrinterConfigs] = useState<Record<number, PerPrinterConfig>>({});

  // Assignment mode: 'printer' (specific) or 'model' (any of model)
  const [assignmentMode, setAssignmentMode] = useState<AssignmentMode>(() => {
    // Cross-model alternatives are model-based by definition — naming one
    // printer would defeat the point of offering the other file.
    if (isCrossModel) {
      return 'model';
    }
    // Initialize from queue item if editing with target_model
    if (mode === 'edit-queue-item' && queueItem?.target_model) {
      return 'model';
    }
    // Farm-wide printing is the default for new jobs unless a caller has
    // explicitly pre-selected a printer (for example, direct print from a
    // printer page).
    if (mode === 'create' && !initialSelectedPrinterIds?.length) {
      return 'model';
    }
    return 'printer';
  });

  // Target model for model-based assignment
  const [targetModel, setTargetModel] = useState<string | null>(() => {
    if (mode === 'edit-queue-item' && queueItem?.target_model) {
      return queueItem.target_model;
    }
    return null;
  });

  // Target location for model-based assignment (optional filter)
  const [targetLocation, setTargetLocation] = useState<string | null>(() => {
    if (mode === 'edit-queue-item' && queueItem?.target_location) {
      return queueItem.target_location;
    }
    return null;
  });

  // Filament overrides for model-based assignment: slot_id -> {type, color}
  const [filamentOverrides, setFilamentOverrides] = useState<Record<number, { type: string; color: string }>>(() => {
    if (mode === 'edit-queue-item' && queueItem?.filament_overrides) {
      const overrides: Record<number, { type: string; color: string }> = {};
      for (const o of queueItem.filament_overrides) {
        overrides[o.slot_id] = { type: o.type, color: o.color };
      }
      return overrides;
    }
    return {};
  });

  // Matching is a job-level choice. The API persists it per slot as well for
  // backwards compatibility, but users should not have to manage repeated
  // checkboxes for what is conceptually one dispatch policy.
  const [forceColorMatch, setForceColorMatch] = useState(() => {
    if (mode !== 'edit-queue-item' || !queueItem) return true;
    if (typeof queueItem.force_color_match === 'boolean') return queueItem.force_color_match;
    return queueItem.filament_overrides?.some((override) => override.force_color_match !== false) ?? true;
  });
  const [isModelFilamentOptionsExpanded, setIsModelFilamentOptionsExpanded] = useState(false);

  // Track initial values for clearing mappings on change (edit mode only)
  const [initialPrinterIds] = useState(() => (mode === 'edit-queue-item' && queueItem?.printer_id ? [queueItem.printer_id] : []));
  const [initialPlateId] = useState(() => (mode === 'edit-queue-item' && queueItem ? queueItem.plate_id : null));

  // Submission state for multi-printer
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitProgress, setSubmitProgress] = useState({ current: 0, total: 0 });

  const [filamentWarningItems, setFilamentWarningItems] = useState<FilamentWarningItem[] | null>(null);

  // Track which printers have had the "Expand custom mapping by default" setting applied
  // This ensures the setting only affects initial state, not preventing unchecking
  const [initialExpandApplied, setInitialExpandApplied] = useState<Set<number>>(new Set());

  // Printer counts and effective printer for filament mapping
  const effectivePrinterCount = selectedPrinters.length;
  // For filament mapping, use first selected printer (mapping applies to all)
  const effectivePrinterId = selectedPrinters.length > 0 ? selectedPrinters[0] : null;

  // Queries
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: api.getSettings,
  });

  // Sync print option defaults from settings once available
  const printDefaultsApplied = useRef(false);
  useEffect(() => {
    if (!settings || printDefaultsApplied.current || mode === 'edit-queue-item') return;
    printDefaultsApplied.current = true;
    setPrintOptions({
      bed_levelling: settings.default_bed_levelling ?? DEFAULT_PRINT_OPTIONS.bed_levelling,
      flow_cali: settings.default_flow_cali ?? DEFAULT_PRINT_OPTIONS.flow_cali,
      vibration_cali: settings.default_vibration_cali ?? DEFAULT_PRINT_OPTIONS.vibration_cali,
      layer_inspect: settings.default_layer_inspect ?? DEFAULT_PRINT_OPTIONS.layer_inspect,
      timelapse: settings.default_timelapse ?? DEFAULT_PRINT_OPTIONS.timelapse,
      nozzle_offset_cali: settings.default_nozzle_offset_cali ?? DEFAULT_PRINT_OPTIONS.nozzle_offset_cali,
    });
  }, [settings, mode]);

  const currencySymbol = getCurrencySymbol(settings?.currency || 'USD');
  const defaultCostPerKg = settings?.default_filament_cost ?? 0;

  const { data: printers, isLoading: loadingPrinters } = useQuery({
    queryKey: ['printers'],
    queryFn: api.getPrinters,
  });

  // Auto-off only has an effect when every explicitly selected printer has an
  // enabled, non-script smart plug. Model-targeted jobs are assigned later, so
  // there is no reliable printer association to expose this control for.
  const { data: smartPlugs } = useQuery({
    queryKey: ['smart-plugs'],
    queryFn: api.getSmartPlugs,
    enabled: assignmentMode === 'printer' && selectedPrinters.length > 0 && hasPermission('smart_plugs:read'),
  });
  const canAutoOffAfterPrint = useMemo(() => {
    if (assignmentMode !== 'printer' || selectedPrinters.length === 0 || !smartPlugs) return false;
    return selectedPrinters.every((printerId) => smartPlugs.some((plug: SmartPlug) => (
      plug.printer_id === printerId
      && plug.enabled
      && !(plug.plug_type === 'homeassistant' && plug.ha_entity_id?.startsWith('script.'))
    )));
  }, [assignmentMode, selectedPrinters, smartPlugs]);

  const canInsertAtTop = hasPermission('queue:insert_top');

  // Prevent stale edit state or a changed printer selection from submitting
  // privileged / inapplicable options that are no longer available.
  useEffect(() => {
    if ((!canInsertAtTop && scheduleOptions.insertAtTop) || (!canAutoOffAfterPrint && scheduleOptions.autoOffAfter)) {
      setScheduleOptions((current) => ({
        ...current,
        insertAtTop: canInsertAtTop ? current.insertAtTop : false,
        autoOffAfter: canAutoOffAfterPrint ? current.autoOffAfter : false,
      }));
    }
  }, [canInsertAtTop, canAutoOffAfterPrint, scheduleOptions.insertAtTop, scheduleOptions.autoOffAfter]);

  const { data: spoolAssignments } = useQuery({
    queryKey: ['spool-assignments'],
    queryFn: () => api.getAssignments(),
    staleTime: 30 * 1000,
    enabled: !isEditing && assignmentMode === 'printer',
  });

  // Fetch per-printer Map<globalTrayId, gramsRemaining> via the dedicated
  // backend endpoint (#1766). Server-side mirrors `_build_inventory_remain_overrides`
  // so internal and Spoolman modes both work uniformly, VT/external slots are
  // excluded, and negative grams are clamped — single source of truth between
  // the client-side preview and dispatch-time picks.
  const inventoryRemainQueries = useQueries({
    queries: selectedPrinters.map((printerId) => ({
      queryKey: ['printer-inventory-remain', printerId],
      queryFn: () => api.getInventoryRemain(printerId),
      staleTime: 30 * 1000,
      enabled: selectedPrinters.length > 0,
    })),
  });
  const inventoryByTrayIdPerPrinter = useMemo(() => {
    const result = new Map<number, Map<number, number>>();
    selectedPrinters.forEach((printerId, idx) => {
      const data = inventoryRemainQueries[idx]?.data?.inventory_remain_g;
      if (!data) return;
      const printerMap = new Map<number, number>();
      Object.entries(data).forEach(([key, grams]) => {
        const gtid = Number(key);
        if (!Number.isNaN(gtid)) printerMap.set(gtid, grams);
      });
      result.set(printerId, printerMap);
    });
    return result;
  }, [selectedPrinters, inventoryRemainQueries]);

  // Fetch archive details to get sliced_for_model
  const { data: archiveDetails } = useQuery({
    queryKey: ['archive', archiveId],
    queryFn: () => api.getArchive(archiveId!),
    enabled: !!archiveId && !isLibraryFile,
  });

  // Fetch library file details to get sliced_for_model
  const { data: libraryFileDetails } = useQuery({
    queryKey: ['library-file', libraryFileId],
    queryFn: () => api.getLibraryFile(libraryFileId!),
    enabled: isLibraryFile && !!libraryFileId,
  });

  // Get sliced_for_model from archive or library file
  const slicedForModel = archiveDetails?.sliced_for_model || libraryFileDetails?.sliced_for_model || null;

  // Fetch plates for archives
  const { data: archivePlatesData, isError: archivePlatesError } = useQuery({
    queryKey: ['archive-plates', archiveId],
    queryFn: () => api.getArchivePlates(archiveId!),
    enabled: !!archiveId && !isLibraryFile,
    retry: false,
  });

  // Fetch plates for library files
  const { data: libraryPlatesData } = useQuery({
    queryKey: ['library-file-plates', libraryFileId],
    queryFn: () => api.getLibraryFilePlates(libraryFileId!),
    enabled: isLibraryFile && !!libraryFileId,
  });

  // Combine plates data from either source
  const platesData = isLibraryFile ? libraryPlatesData : archivePlatesData;

  // Fetch filament requirements for archives
  const { data: archiveFilamentReqs, isError: archiveFilamentReqsError } = useQuery({
    queryKey: ['archive-filaments', archiveId, selectedPlate],
    queryFn: () => api.getArchiveFilamentRequirements(archiveId!, selectedPlate ?? undefined),
    enabled: !!archiveId && !isLibraryFile && (selectedPlate !== null || !platesData?.is_multi_plate),
    retry: false,
  });

  // Fetch filament requirements for library files (with plate support)
  const { data: libraryFilamentReqs } = useQuery({
    queryKey: ['library-file-filaments', libraryFileId, selectedPlate],
    queryFn: () => api.getLibraryFileFilamentRequirements(libraryFileId!, selectedPlate ?? undefined),
    enabled: isLibraryFile && !!libraryFileId && (selectedPlate !== null || !platesData?.is_multi_plate),
  });

  // Track if archive data couldn't be loaded (archive deleted or file missing)
  const archiveDataMissing = !isLibraryFile && (archivePlatesError || archiveFilamentReqsError);

  // Combine filament requirements from either source
  const effectiveFilamentReqs = isLibraryFile ? libraryFilamentReqs : archiveFilamentReqs;

  // Fetch available filaments for model-based assignment (for filament override UI)
  const { data: availableFilaments } = useQuery({
    queryKey: ['available-filaments', targetModel, targetLocation],
    queryFn: () => api.getAvailableFilaments(targetModel!, targetLocation ?? undefined),
    enabled: assignmentMode === 'model' && !!targetModel,
  });

  // A cross-model job (#671) has no single target model, so the query above is
  // disabled and the override UI would silently vanish — leaving less control
  // than the ordinary "Any X1C" flow offers. Ask each candidate's model instead
  // and offer the union: the job can land on any of them, so anything loaded on
  // any of them is a legitimate choice. Picking one only some models have is
  // allowed and meaningful — it narrows which candidates can match.
  const candidateModels = useMemo(
    () => Array.from(new Set(candidates.map((c) => c.sliced_for_model).filter((m): m is string => !!m))),
    [candidates],
  );
  const candidateFilamentQueries = useQueries({
    queries: isCrossModel
      ? candidateModels.map((model) => ({
          queryKey: ['available-filaments', model, targetLocation],
          queryFn: () => api.getAvailableFilaments(model, targetLocation ?? undefined),
        }))
      : [],
  });
  const crossModelFilaments = useMemo(() => {
    const seen = new Set<string>();
    const merged: NonNullable<typeof availableFilaments> = [];
    for (const query of candidateFilamentQueries) {
      for (const filament of query.data ?? []) {
        // Same type+colour loaded on two models is one choice, not two.
        const key = `${filament.type}|${filament.color}|${filament.tray_info_idx}`;
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(filament);
        }
      }
    }
    return merged;
  }, [candidateFilamentQueries]);

  const effectiveAvailableFilaments = isCrossModel ? crossModelFilaments : availableFilaments;

  // Only fetch printer status when single printer selected (for filament mapping)
  const { data: printerStatus } = useQuery({
    queryKey: ['printer-status', effectivePrinterId],
    queryFn: () => api.getPrinterStatus(effectivePrinterId!),
    enabled: !!effectivePrinterId,
  });

  // Single-printer flow: gate prefer_lowest on this printer's backup state.
  // Multi-printer flow gates per-printer inside the hook (different printers
  // may have different backup states), so we pass the raw setting down.
  const singlePrinterPreferLowest = effectivePreferLowest(
    settings?.prefer_lowest_filament,
    printerStatus?.ams_filament_backup,
  );

  // Get AMS mapping from hook (only when single printer selected)
  const { amsMapping } = useFilamentMapping(
    effectiveFilamentReqs,
    printerStatus,
    manualMappings,
    singlePrinterPreferLowest,
    effectivePrinterId ? inventoryByTrayIdPerPrinter.get(effectivePrinterId) : undefined,
  );

  const handleManualMappingChange = (nextMappings: Record<number, number>) => {
    const loaded = buildLoadedFilaments(printerStatus);
    const changedSlotIds = new Set(
      [...Object.keys(manualMappings), ...Object.keys(nextMappings)]
        .map(Number)
        .filter((slotId) => manualMappings[slotId] !== nextMappings[slotId]),
    );

    setManualMappings(nextMappings);
    if (changedSlotIds.size === 0) return;

    setFilamentOverrides((current) => {
      const next = { ...current };
      for (const slotId of changedSlotIds) {
        const globalTrayId = nextMappings[slotId];
        if (globalTrayId == null) {
          delete next[slotId];
          continue;
        }
        const selected = loaded.find((filament) => filament.globalTrayId === globalTrayId);
        if (selected) {
          next[slotId] = { type: selected.type, color: selected.color };
        }
      }
      return next;
    });
  };

  // Multi-printer filament mapping (for per-printer configuration)
  const multiPrinterMapping = useMultiPrinterFilamentMapping(
    selectedPrinters,
    printers,
    effectiveFilamentReqs,
    manualMappings,
    perPrinterConfigs,
    setPerPrinterConfigs,
    settings?.prefer_lowest_filament,
    inventoryByTrayIdPerPrinter,
  );

  // Auto-select first plate when plates load (single or multi-plate)
  useEffect(() => {
    if (platesData?.plates && platesData.plates.length >= 1 && selectedPlates.size === 0) {
      setSelectedPlates(new Set([platesData.plates[0].index]));
    }
  }, [platesData, selectedPlates.size]);

  // Auto-select first printer when only one available
  useEffect(() => {
    // Skip auto-select for edit mode (already initialized from queueItem)
    if (mode === 'edit-queue-item') return;
    const activePrinters = printers?.filter(p => p.is_active) || [];
    if (activePrinters.length === 1 && selectedPrinters.length === 0) {
      setSelectedPrinters([activePrinters[0].id]);
    }
  }, [mode, printers, selectedPrinters.length]);

  // Clear manual mappings and per-printer configs when printer or plate changes
  useEffect(() => {
    if (mode === 'edit-queue-item') {
      // For edit mode, clear mappings if printer selection or plate changed from initial
      const printersChanged = JSON.stringify(selectedPrinters.sort()) !== JSON.stringify(initialPrinterIds.sort());
      if (printersChanged || selectedPlate !== initialPlateId) {
        setManualMappings({});
        setPerPrinterConfigs({});
        setInitialExpandApplied(new Set());
      }
    } else {
      setManualMappings({});
      setPerPrinterConfigs({});
      setInitialExpandApplied(new Set());
    }
  }, [mode, selectedPrinters, selectedPlate, initialPrinterIds, initialPlateId]);

  // A tray selected in the single-printer mapping is converted into a
  // type/colour profile override for the queue payload. That profile belongs
  // to the printer whose tray was selected; do not carry it across a direct
  // switch to another specific printer where it may no longer be loaded.
  const previousSelectedPrinters = useRef<number[] | null>(null);
  useEffect(() => {
    const previous = previousSelectedPrinters.current;
    const printerSelectionChanged = previous !== null
      && (previous.length !== selectedPrinters.length
        || previous.some((printerId, index) => printerId !== selectedPrinters[index]));

    if (mode === 'create' && assignmentMode === 'printer' && printerSelectionChanged) {
      setFilamentOverrides({});
    }

    previousSelectedPrinters.current = [...selectedPrinters];
  }, [mode, assignmentMode, selectedPrinters]);

  // Clear filament overrides when target model or plate changes (but not on initial mount for edit mode)
  const [prevTargetModel, setPrevTargetModel] = useState(targetModel);
  const [prevPlateForOverrides, setPrevPlateForOverrides] = useState(selectedPlate);
  useEffect(() => {
    if (targetModel !== prevTargetModel || selectedPlate !== prevPlateForOverrides) {
      setPrevTargetModel(targetModel);
      setPrevPlateForOverrides(selectedPlate);
      // Don't clear on initial render in edit mode (values are initialized from queueItem)
      if (mode !== 'edit-queue-item' || prevTargetModel !== null) {
        setFilamentOverrides({});
      }
    }
  }, [targetModel, selectedPlate, prevTargetModel, prevPlateForOverrides, mode]);

  // Auto-expand per-printer mapping when setting is enabled and multiple printers selected
  // Only applies once per printer on initial selection, not when user unchecks
  useEffect(() => {
    if (!settings?.per_printer_mapping_expanded) return;
    if (selectedPrinters.length <= 1) return;

    // Only auto-configure printers that:
    // 1. Haven't had initial expand applied yet
    // 2. Have their status loaded (so auto-configure will actually work)
    const printersReadyForExpand = selectedPrinters.filter(printerId => {
      if (initialExpandApplied.has(printerId)) return false;

      // Check if this printer has status loaded
      const result = multiPrinterMapping.printerResults.find(r => r.printerId === printerId);
      return result && result.status && !result.isLoading;
    });

    if (printersReadyForExpand.length > 0) {
      // Mark these printers as having been initially expanded
      setInitialExpandApplied(prev => {
        const next = new Set(prev);
        printersReadyForExpand.forEach(id => next.add(id));
        return next;
      });

      // Auto-configure printers
      printersReadyForExpand.forEach(printerId => {
        multiPrinterMapping.autoConfigurePrinter(printerId);
      });
    }
  }, [settings?.per_printer_mapping_expanded, selectedPrinters, initialExpandApplied, multiPrinterMapping]);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSubmitting) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, isSubmitting]);

  const isMultiPlate = platesData?.is_multi_plate ?? false;
  const plates = platesData?.plates ?? [];

  const spoolAssignmentsByPrinter = useMemo(() => {
    const map = new Map<number, Map<number, SpoolAssignment>>();
    if (!spoolAssignments) return map;
    spoolAssignments.forEach((assignment) => {
      const isExternal = assignment.ams_id === 255;
      const globalTrayId = getGlobalTrayId(
        assignment.ams_id,
        assignment.tray_id,
        isExternal
      );
      const printerMap = map.get(assignment.printer_id) ?? new Map();
      printerMap.set(globalTrayId, assignment);
      map.set(assignment.printer_id, printerMap);
    });
    return map;
  }, [spoolAssignments]);

  const filamentWarningMessage = useMemo(() => {
    if (!filamentWarningItems || filamentWarningItems.length === 0) return '';
    const lines = filamentWarningItems.map((item) =>
      t('printModal.insufficientFilamentLine', {
        printer: item.printerName,
        slot: item.slotLabel,
        required: Math.round(item.requiredGrams),
        remaining: Math.round(item.remainingGrams),
      })
    );
    return [t('printModal.insufficientFilamentMessage'), ...lines].join('\n');
  }, [filamentWarningItems, t]);

  // Add to queue mutation (single printer)
  const addToQueueMutation = useMutation({
    mutationFn: (data: PrintQueueItemCreate) => api.addToQueue(data),
  });

  // Update queue item mutation
  const updateQueueMutation = useMutation({
    mutationFn: (data: PrintQueueItemUpdate) => api.updateQueueItem(queueItem!.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      showToast('Queue item updated');
      onSuccess?.();
      onClose();
    },
    onError: (error: Error) => {
      showToast(error.message || 'Failed to update queue item', 'error');
    },
  });

  const handleSubmit = async (e?: React.FormEvent, options?: { skipFilamentCheck?: boolean }) => {
    e?.preventDefault();

    if (
      !options?.skipFilamentCheck &&
      !settings?.disable_filament_warnings &&
      !isEditing &&
      assignmentMode === 'printer'
    ) {
      const warningItems: FilamentWarningItem[] = [];
      const filamentReqs = effectiveFilamentReqs?.filaments ?? [];

      if (filamentReqs.length > 0 && spoolAssignmentsByPrinter.size > 0) {
        const getRemainingWeight = (labelWeight: number, weightUsed: number) => {
          if (!Number.isFinite(labelWeight) || labelWeight <= 0) return null;
          if (!Number.isFinite(weightUsed) || weightUsed < 0) return null;
          return Math.max(0, labelWeight - weightUsed);
        };

        for (const printerId of selectedPrinters) {
          const printerMapping = selectedPrinters.length > 1
            ? multiPrinterMapping.getFinalMapping(printerId)
            : amsMapping;
          if (!printerMapping) continue;

          const printerStatusForWarning = selectedPrinters.length > 1
            ? multiPrinterMapping.printerResults.find((result) => result.printerId === printerId)?.status
            : printerStatus;

          const loadedFilaments = buildLoadedFilaments(printerStatusForWarning);
          const slotLabelByTray = new Map(loadedFilaments.map((f) => [f.globalTrayId, f.label]));
          const assignments = spoolAssignmentsByPrinter.get(printerId);
          const printerName = printers?.find((p) => p.id === printerId)?.name ?? `Printer ${printerId}`;

          if (!assignments) continue;

          filamentReqs.forEach((req) => {
            if (!req.slot_id || req.slot_id <= 0) return;
            const globalTrayId = printerMapping[req.slot_id - 1];
            if (!Number.isFinite(globalTrayId) || globalTrayId < 0) return;

            const assignment = assignments.get(globalTrayId);
            const spool = assignment?.spool;
            if (!spool) return;

            const remainingGrams = getRemainingWeight(spool.label_weight, spool.weight_used);
            if (remainingGrams === null) return;
            if (remainingGrams >= req.used_grams) return;

            warningItems.push({
              printerName,
              slotLabel: slotLabelByTray.get(globalTrayId) ?? `Slot ${req.slot_id}`,
              requiredGrams: req.used_grams,
              remainingGrams,
            });
          });
        }
      }

      if (warningItems.length > 0) {
        setFilamentWarningItems(warningItems);
        return;
      }
    }

    // Validate printer/model selection
    if (assignmentMode === 'printer' && selectedPrinters.length === 0) {
      showToast('Please select at least one printer', 'error');
      return;
    }
    // A cross-model job has no single target model — each candidate carries its
    // own, and the backend gates each of them separately. Both checks below are
    // about the one-model case only.
    if (!isCrossModel && assignmentMode === 'model' && !targetModel) {
      showToast('Please select a target printer model', 'error');
      return;
    }
    // Cross-model safety gate (#2578) — mirrors the backend's 400 so the user
    // gets inline feedback instead of a failed request.
    if (!isCrossModel && assignmentMode === 'model' && !isGcodeCompatible(slicedForModel, targetModel)) {
      showToast(`File was sliced for ${slicedForModel} and cannot be dispatched to ${targetModel} printers`, 'error');
      return;
    }

    setIsSubmitting(true);
    // Calculate total API calls: plates × printers (or 1 for model-based)
    const platesToQueue = selectedPlates.size > 1
      ? plates.filter(p => selectedPlates.has(p.index))
      : [null];
    const totalCount = assignmentMode === 'model'
      ? platesToQueue.length
      : selectedPrinters.length * platesToQueue.length;
    setSubmitProgress({ current: 0, total: totalCount });

    const results: { success: number; failed: number; errors: string[] } = {
      success: 0,
      failed: 0,
      errors: [],
    };

    // Get mapping for a specific printer (per-printer override or default)
    const getMappingForPrinter = (printerId: number): number[] | undefined => {
      // For multi-printer selection, check if this printer has an override
      if (selectedPrinters.length > 1) {
        const printerConfig = perPrinterConfigs[printerId];
        if (printerConfig && !printerConfig.useDefault) {
          return multiPrinterMapping.getFinalMapping(printerId);
        }
      }
      // An automatically suggested mapping reflects the printer's current
      // load, not a user decision. Leave it out of the queue payload so a job
      // queued ahead of loading is resolved again when the printer is ready.
      return Object.keys(manualMappings).length > 0 ? amsMapping : undefined;
    };

    // Convert filament overrides from Record to array format for API.
    // Include all slots that either have a user override or have force_color_match enabled
    // (which is the default for model-based assignment).
    const buildFilamentOverridesArray = () => {
      const entries: Array<{ slot_id: number; type: string; color: string; color_name: string; force_color_match: boolean }> = [];

      // Process all slots from filament requirements (to capture force_color_match defaults)
      if (effectiveFilamentReqs?.filaments) {
        for (const req of effectiveFilamentReqs.filaments) {
          const userOverride = filamentOverrides[req.slot_id];
          const effectiveType = userOverride?.type ?? req.type;
          const effectiveColor = userOverride?.color ?? req.color;

          // Include every known slot so the job-level policy is explicit and
          // survives clients or API versions with different defaults.
          entries.push({ slot_id: req.slot_id, type: effectiveType, color: effectiveColor, color_name: getColorName(effectiveColor), force_color_match: forceColorMatch });
        }
      } else {
        // Fallback: no filament requirements data — only include explicit user overrides
        for (const [slotId, { type, color }] of Object.entries(filamentOverrides)) {
          const id = parseInt(slotId, 10);
          entries.push({ slot_id: id, type, color, color_name: getColorName(color), force_color_match: forceColorMatch });
        }
      }

      return entries.length > 0 ? entries : undefined;
    };

    const filamentOverridesArray = buildFilamentOverridesArray();

    const getFilamentOverridesForPrinter = (printerId: number | null) => {
      if (!filamentOverridesArray || printerId == null || selectedPrinters.length <= 1) {
        return filamentOverridesArray;
      }

      const config = perPrinterConfigs[printerId];
      const result = multiPrinterMapping.printerResults.find((entry) => entry.printerId === printerId);
      if (!config || config.useDefault || !result) {
        return filamentOverridesArray;
      }

      return filamentOverridesArray.map((override) => {
        const selectedTrayId = config.manualMappings[override.slot_id];
        if (selectedTrayId == null) return override;
        const selected = result.loadedFilaments.find((filament) => filament.globalTrayId === selectedTrayId);
        if (!selected) return override;
        return {
          ...override,
          type: selected.type,
          color: selected.color,
          color_name: selected.colorName,
        };
      });
    };

    // Cross-model alternatives (#671): ONE item carrying a candidate per file,
    // in the order the user arranged. This returns before the plate/printer
    // fan-out below because it deliberately fans out to nothing — the whole
    // point is that exactly one of these candidates ever runs.
    //
    // Filament overrides are shared rather than per-candidate, matching how
    // single-model assignment already behaves: the printer is unknown at queue
    // time, so what is expressed here is "this job needs PETG", which is true of
    // every slice of the same job. The AMS mapping is likewise absent — the
    // scheduler computes it against the printer it actually picks.
    if (isCrossModel) {
      try {
        await api.addToQueue({
          variants: candidates.map((c) => ({
            library_file_id: c.id,
            plate_id: candidatePlates[c.id] ?? null,
            filament_overrides: filamentOverridesArray,
          })),
          target_location: targetLocation,
          require_previous_success: scheduleOptions.requirePreviousSuccess,
          auto_off_after: scheduleOptions.autoOffAfter,
          gcode_injection: scheduleOptions.gcodeInjection,
          manual_start: scheduleOptions.requireManualStart,
          scheduled_time: scheduleOptions.postponePrint && scheduleOptions.scheduledTime
            ? new Date(scheduleOptions.scheduledTime).toISOString()
            : undefined,
          quantity,
          ...printOptions,
          project_id: projectId ?? undefined,
        });
        showToast(t('printModal.variants.queued', { count: candidates.length }), 'success');
        queryClient.invalidateQueries({ queryKey: ['queue'] });
        onSuccess?.();
        onClose();
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error), 'error');
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    const topInsertionCounts = new Map<string, number>();

    const applyTopInsertion = (
      queueData: PrintQueueItemCreate,
      printerId: number | null,
      itemCount = 1,
    ) => {
      if (!canInsertAtTop || !scheduleOptions.insertAtTop) return;
      const scopeKey = printerId !== null ? `printer:${printerId}` : 'unassigned';
      const insertPosition = (topInsertionCounts.get(scopeKey) ?? 0) + 1;
      queueData.insert_at_top = true;
      queueData.insert_position = insertPosition;
      topInsertionCounts.set(scopeKey, insertPosition + itemCount - 1);
    };

    // Common queue data for create and edit modes
    const getQueueData = (printerId: number | null, plateOverride?: number | null): PrintQueueItemCreate => {
      const printerOverrides = getFilamentOverridesForPrinter(printerId);
      return {
        printer_id: assignmentMode === 'printer' ? printerId : null,
        target_model: assignmentMode === 'model' ? targetModel : null,
        target_location: assignmentMode === 'model' ? targetLocation : null,
        // Persist colour requirements for both model-based and explicitly
        // assigned printers. Multi-printer manual mappings become each job's
        // enforced profile rather than only an AMS slot hint.
        filament_overrides: printerOverrides,
        force_color_match: forceColorMatch,
        // Use library_file_id for library files, archive_id for archives
        archive_id: isLibraryFile ? undefined : archiveId,
        library_file_id: isLibraryFile ? libraryFileId : undefined,
        require_previous_success: scheduleOptions.requirePreviousSuccess,
        wait_for_drying_complete: scheduleOptions.waitForDryingComplete,
        chamber_heat_soak: scheduleOptions.chamberHeatSoak,
        heat_soak_temperature: scheduleOptions.chamberHeatSoak ? scheduleOptions.heatSoakTemperature : 60,
        heat_soak_minutes: scheduleOptions.chamberHeatSoak ? scheduleOptions.heatSoakMinutes : 30,
        auto_off_after: canAutoOffAfterPrint ? scheduleOptions.autoOffAfter : false,
        gcode_injection: scheduleOptions.gcodeInjection,
        manual_start: scheduleOptions.requireManualStart,
        // When the user clicks "Print Anyway" on the frontend deficit warning,
        // persist that acknowledgement so the scheduler doesn't immediately
        // re-flag the item on its first dispatch tick (#1698-followup).
        skip_filament_check: options?.skipFilamentCheck === true ? true : undefined,
        ams_mapping: printerId ? getMappingForPrinter(printerId) : undefined,
        plate_id: plateOverride !== undefined ? plateOverride : selectedPlate,
        scheduled_time: scheduleOptions.postponePrint && scheduleOptions.scheduledTime
          ? new Date(scheduleOptions.scheduledTime).toISOString()
          : undefined,
        ...printOptions,
        project_id: projectId ?? undefined,
        cleanup_library_after_dispatch: cleanupLibraryAfterDispatch,
      };
    };

    // Model-based assignment
    if (assignmentMode === 'model') {
      let progressCounter = 0;
      for (const plate of platesToQueue) {
        progressCounter++;
        setSubmitProgress({ current: progressCounter, total: totalCount });
        const plateId = plate ? plate.index : selectedPlate;

        try {
          if (mode === 'edit-queue-item' && !plate) {
            // Edit mode - update with target_model (only for single plate)
            const updateData: PrintQueueItemUpdate = {
              printer_id: null,
              target_model: targetModel,
              target_location: targetLocation,
              filament_overrides: filamentOverridesArray || null,
              force_color_match: forceColorMatch,
              require_previous_success: scheduleOptions.requirePreviousSuccess,
              wait_for_drying_complete: scheduleOptions.waitForDryingComplete,
              chamber_heat_soak: scheduleOptions.chamberHeatSoak,
              heat_soak_temperature: scheduleOptions.chamberHeatSoak ? scheduleOptions.heatSoakTemperature : 60,
              heat_soak_minutes: scheduleOptions.chamberHeatSoak ? scheduleOptions.heatSoakMinutes : 30,
              auto_off_after: scheduleOptions.autoOffAfter,
              gcode_injection: scheduleOptions.gcodeInjection,
              manual_start: scheduleOptions.requireManualStart,
              ams_mapping: undefined,
              plate_id: plateId,
              scheduled_time: scheduleOptions.postponePrint && scheduleOptions.scheduledTime
                ? new Date(scheduleOptions.scheduledTime).toISOString()
                : null,
              ...printOptions,
            };
            await updateQueueMutation.mutateAsync(updateData);
          } else {
            // Add-to-queue mode with model-based assignment
            const queueData = getQueueData(null, plateId);
            const plateQuantity = quantityForPlate(plateId);
            if (plateQuantity > 1) queueData.quantity = plateQuantity;
            applyTopInsertion(queueData, null, plateQuantity);
            await addToQueueMutation.mutateAsync(queueData);
          }
          results.success++;
        } catch (error) {
          results.failed++;
          const plateName = plate ? (plate.name || `Plate ${plate.index}`) : '';
          results.errors.push(plateName ? `${plateName}: ${(error as Error).message}` : (error as Error).message);
        }
      }
    } else {
      // Printer-based assignment: loop through plates × printers
      let progressCounter = 0;
      for (const plate of platesToQueue) {
        const plateId = plate ? plate.index : selectedPlate;

        for (let i = 0; i < selectedPrinters.length; i++) {
          const printerId = selectedPrinters[i];
          progressCounter++;
          setSubmitProgress({ current: progressCounter, total: totalCount });

          try {
            if (isEditing && progressCounter === 1) {
              // Edit mode - update the original queue item for the first entry
              const printerMapping = getMappingForPrinter(printerId);
              const printerOverrides = getFilamentOverridesForPrinter(printerId);
              const updateData: PrintQueueItemUpdate = {
                printer_id: printerId,
                target_model: null,
                target_location: null,
                filament_overrides: printerOverrides || null,
                force_color_match: forceColorMatch,
                require_previous_success: scheduleOptions.requirePreviousSuccess,
                wait_for_drying_complete: scheduleOptions.waitForDryingComplete,
                chamber_heat_soak: scheduleOptions.chamberHeatSoak,
                heat_soak_temperature: scheduleOptions.chamberHeatSoak ? scheduleOptions.heatSoakTemperature : 60,
                heat_soak_minutes: scheduleOptions.chamberHeatSoak ? scheduleOptions.heatSoakMinutes : 30,
                auto_off_after: scheduleOptions.autoOffAfter,
                gcode_injection: scheduleOptions.gcodeInjection,
                manual_start: scheduleOptions.requireManualStart,
                ams_mapping: printerMapping,
                plate_id: plateId,
                scheduled_time: scheduleOptions.postponePrint && scheduleOptions.scheduledTime
                  ? new Date(scheduleOptions.scheduledTime).toISOString()
                  : null,
                ...printOptions,
              };
              await updateQueueMutation.mutateAsync(updateData);
            } else {
              // New print mode, staggered print, or edit mode with additional entries
              const queueData = getQueueData(printerId, plateId);
              const plateQuantity = quantityForPlate(plateId);
              if (plateQuantity > 1) queueData.quantity = plateQuantity;
              applyTopInsertion(queueData, printerId, plateQuantity);
              await addToQueueMutation.mutateAsync(queueData);
            }
            results.success++;
          } catch (error) {
            results.failed++;
            const printerName = printers?.find(p => p.id === printerId)?.name || `Printer ${printerId}`;
            const plateName = plate ? (plate.name || `Plate ${plate.index}`) : '';
            const label = plateName ? `${printerName} (${plateName})` : printerName;
            results.errors.push(`${label}: ${(error as Error).message}`);
          }
        }
      }
    }

    setIsSubmitting(false);

    // Show result toast
    if (results.failed === 0) {
      if (isEditing) {
        if (mode === 'edit-queue-item') {
          showToast('Queue item updated');
        }
      } else if (results.success === 1) {
        showToast(
          assignmentMode === 'model'
              ? `Queued for any ${targetModel}`
              : t('queue.printQueued'),
        );
      } else {
        showToast(
          t('queue.itemsQueued', { count: results.success }),
        );
      }
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      onSuccess?.();
      onClose();
    } else if (results.success === 0) {
      showToast(`Failed: ${results.errors[0]}`, 'error');
    } else {
      showToast(`${results.success} succeeded, ${results.failed} failed`, 'error');
      queryClient.invalidateQueries({ queryKey: ['queue'] });
    }
  };

  const isPending = isSubmitting || updateQueueMutation.isPending;

  const canSubmit = useMemo(() => {
    if (isPending) return false;

    // Need valid printer/model selection
    if (assignmentMode === 'printer' && selectedPrinters.length === 0) return false;
    // Both are about the single-model case. A cross-model job has no one target
    // model, and each candidate is gated against its own by the backend (#671).
    if (!isCrossModel && assignmentMode === 'model' && !targetModel) return false;
    // Cross-model mismatch cannot be queued (#2578)
    if (!isCrossModel && assignmentMode === 'model' && !isGcodeCompatible(slicedForModel, targetModel)) return false;

    // For multi-plate files, need at least one plate selected
    if (isMultiPlate && selectedPlates.size === 0) return false;

    if (scheduleOptions.chamberHeatSoak && (
      !Number.isInteger(scheduleOptions.heatSoakTemperature) || scheduleOptions.heatSoakTemperature < 30 || scheduleOptions.heatSoakTemperature > 60 ||
      !Number.isInteger(scheduleOptions.heatSoakMinutes) || scheduleOptions.heatSoakMinutes < 1 || scheduleOptions.heatSoakMinutes > 120
    )) return false;

    if (scheduleOptions.postponePrint) {
      const scheduledTime = new Date(scheduleOptions.scheduledTime);
      if (!scheduleOptions.scheduledTime || scheduledTime <= new Date()) return false;
    }

    return true;
  }, [
    selectedPrinters.length,
    assignmentMode,
    targetModel,
    slicedForModel,
    isMultiPlate,
    selectedPlates.size,
    isPending,
    isCrossModel,
    scheduleOptions.postponePrint,
    scheduleOptions.scheduledTime,
    scheduleOptions.chamberHeatSoak,
    scheduleOptions.heatSoakTemperature,
    scheduleOptions.heatSoakMinutes,
  ]);

  // Quantity only applies for single-printer or model-based assignment (not multi-printer)
  const effectiveQuantity = (assignmentMode === 'printer' && selectedPrinters.length > 1) ? 1 : quantity;

  // On a multi-plate file the per-plate steppers own the quantity and the
  // global field is hidden (#342) — the reporter's case is "plate 1 once,
  // plate 2 twice", which one shared number cannot express. Single-plate
  // files, and edit mode, keep the single field exactly as before.
  const usePerPlateQuantities = mode === 'create' && isMultiPlate && plates.length > 1;

  /** Runs to queue for one plate. `null` = the single-plate / whole-file case. */
  const quantityForPlate = (plateIndex: number | null): number => {
    if (!usePerPlateQuantities || plateIndex == null) return effectiveQuantity;
    // Multi-printer fan-out already means one copy per printer; multiplying by
    // a per-plate count on top would silently produce plates × printers × n.
    if (assignmentMode === 'printer' && selectedPrinters.length > 1) return 1;
    return Math.max(1, plateQuantities[plateIndex] ?? 1);
  };

  // Clear gcode_injection if the admin removes all snippets while the modal
  // is open — the checkbox itself hides via hasGcodeSnippets in
  // ScheduleOptions, but the boolean would otherwise stay true and ship to
  // the API. The previous gate also reset the flag whenever effectiveQuantity
  // dropped to <= 1, which silently un-ticked the checkbox on every single-
  // print create flow (#1852). The scheduler reads item.gcode_injection per
  // queue item regardless of batch size, so there's no underlying reason for
  // the quantity-1 case to be blocked.
  useEffect(() => {
    if (
      mode === 'create' &&
      scheduleOptions.gcodeInjection &&
      !settings?.gcode_snippets
    ) {
      setScheduleOptions((opts) => ({ ...opts, gcodeInjection: false }));
    }
  }, [mode, effectiveQuantity, settings?.gcode_snippets, scheduleOptions.gcodeInjection]);

  // Modal title and action button text based on mode
  const getModalConfig = () => {
    if (!isEditing) {
      return {
        title: t('common.print'),
        icon: Printer,
        submitText: t('common.print'),
        submitIcon: Printer,
        loadingText: submitProgress.total > 1
          ? t('queue.addingProgress', { current: submitProgress.current, total: submitProgress.total })
          : t('queue.adding'),
      };
    }
    // edit-queue-item mode
    return {
      title: t('queue.editQueueItem'),
      icon: Pencil,
      submitText: t('common.save'),
      submitIcon: Pencil,
      loadingText: submitProgress.total > 1
        ? t('queue.savingProgress', { current: submitProgress.current, total: submitProgress.total })
        : t('common.saving'),
    };
  };

  const modalConfig = getModalConfig();
  const TitleIcon = modalConfig.icon;
  const SubmitIcon = modalConfig.submitIcon;

  // Show filament mapping when:
  // - Single printer selected
  // - For archives: plate is selected (for multi-plate) or not required (single-plate)
  // - For library files: always show (no plate selection)
  const showFilamentMapping = effectivePrinterId && selectedPlates.size <= 1 && (
    isLibraryFile || (isMultiPlate ? selectedPlate !== null : true)
  );

  // Dual-nozzle gate for the Nozzle Offset Calibration toggle (#1682).
  // Mirrors backend `DUAL_NOZZLE_MODELS` so model-based assignment can show
  // the toggle without a specific printer selected. For printer-mode we rely
  // on the canonical `nozzle_count` field auto-detected from MQTT.
  const DUAL_NOZZLE_MODELS = useMemo(
    () => new Set(['H2D', 'H2DPRO', 'H2C', 'X2D']),
    [],
  );
  const showDualNozzleOptions = useMemo(() => {
    if (assignmentMode === 'model') {
      if (!targetModel) return false;
      return DUAL_NOZZLE_MODELS.has(targetModel.toUpperCase().replace(/[\s-]/g, ''));
    }
    if (!printers || selectedPrinters.length === 0) return false;
    return selectedPrinters.some(id => printers.find(p => p.id === id)?.nozzle_count === 2);
  }, [assignmentMode, targetModel, printers, selectedPrinters, DUAL_NOZZLE_MODELS]);

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      onClick={isSubmitting ? undefined : onClose}
    >
      <Card
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <CardContent className="p-0">
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-bambu-dark-tertiary">
            <div className="flex items-center gap-2">
              <TitleIcon className="w-5 h-5 text-bambu-green" />
              <h2 className="text-lg font-semibold text-white">{modalConfig.title}</h2>
            </div>
            <Button variant="ghost" size="sm" onClick={onClose} disabled={isSubmitting}>
              <X className="w-5 h-5" />
            </Button>
          </div>

          <form onSubmit={handleSubmit} className="p-4 space-y-4">
            {/* Archive name */}
            <p className="text-sm text-bambu-gray">
              <span className="block text-bambu-gray mb-1">Print Job</span>
              <span className="text-white font-medium truncate block">{archiveName}</span>
            </p>

            {/* Build-plate badge for the selected (or sole) plate — surfaced
                early so the user knows which plate to mount before scheduling
                (#1281). PlateSelector renders its own per-plate badges for
                multi-plate files; this badge covers the single-plate case and
                the multi-plate case where exactly one plate is selected. */}
            {(() => {
              if (!plates.length) return null;
              const target = selectedPlate != null
                ? plates.find(p => p.index === selectedPlate)
                : plates[0];
              const bed = getBedTypeInfo(target?.bed_type);
              if (!bed) return null;
              return (
                <p className="flex items-center gap-1.5 text-xs text-bambu-gray -mt-2" title={bed.label}>
                  <img src={bed.icon} alt="" className="w-4 h-4 object-contain flex-shrink-0" />
                  <span className="truncate">{bed.label}</span>
                </p>
              );
            })()}

            {/* Plate selection - first so users know filament requirements before selecting printers */}
            <PlateSelector
              plates={plates}
              isMultiPlate={isMultiPlate}
              selectedPlates={selectedPlates}
              onToggle={(plateIndex) => {
                setSelectedPlates(prev => {
                  const next = new Set(prev);
                  if (!isEditing) {
                    // Multi-select: toggle the plate
                    if (next.has(plateIndex)) {
                      next.delete(plateIndex);
                    } else {
                      next.add(plateIndex);
                    }
                  } else {
                    // Single-select: replace selection
                    next.clear();
                    next.add(plateIndex);
                  }
                  return next;
                });
              }}
              onSelectAll={!isEditing ? () => setSelectedPlates(new Set(plates.map(p => p.index))) : undefined}
              onDeselectAll={!isEditing ? () => setSelectedPlates(new Set()) : undefined}
              multiSelect={!isEditing}
              quantities={usePerPlateQuantities ? plateQuantities : undefined}
              onQuantityChange={usePerPlateQuantities
                ? (plateIndex, value) => setPlateQuantities(prev => ({ ...prev, [plateIndex]: value }))
                : undefined}
            />

            {/* Cross-model alternatives (#671) replace the printer picker entirely:
                the user already answered "which printer" by choosing these files,
                and the remaining question is only which they'd rather have. */}
            {isCrossModel && (
              <VariantCandidates
                candidates={candidates}
                onReorder={setCandidates}
                plateByFile={candidatePlates}
                onPlateChange={(fileId, plateId) =>
                  setCandidatePlates((prev) => ({ ...prev, [fileId]: plateId }))
                }
              />
            )}

            {hasEditingVariants && (
              <VariantCandidates
                candidates={editingVariants}
                readOnly
                readOnlyNote={t('printModal.variants.editNote')}
                onReorder={() => {}}
                plateByFile={{}}
                onPlateChange={() => {}}
              />
            )}

            {hasEditingVariants && (
              <VariantCandidates
                candidates={editingVariants}
                readOnly
                readOnlyNote={t('printModal.variants.editNote')}
                onReorder={() => {}}
                plateByFile={{}}
                onPlateChange={() => {}}
              />
            )}

            {/* Printer selection with per-printer mapping. Keep it visible for
                printer-originated launches so the initial target can be changed
                or switched to model-based assignment. */}
            {!isCrossModel && !hasEditingVariants && (
              <PrinterSelector
                printers={printers || []}
                selectedPrinterIds={selectedPrinters}
                onMultiSelect={setSelectedPrinters}
                isLoading={loadingPrinters}
                allowMultiple={!initialSelectedPrinterIds?.length}
                showInactive={mode === 'edit-queue-item'}
                disableBusy={false}
                printerMappingResults={multiPrinterMapping.printerResults}
                filamentReqs={effectiveFilamentReqs}
                onAutoConfigurePrinter={multiPrinterMapping.autoConfigurePrinter}
                onUpdatePrinterConfig={multiPrinterMapping.updatePrinterConfig}
                assignmentMode={assignmentMode}
                onAssignmentModeChange={!isEditing ? setAssignmentMode : undefined}
                targetModel={targetModel}
                onTargetModelChange={!isEditing ? setTargetModel : undefined}
                targetLocation={targetLocation}
                onTargetLocationChange={!isEditing ? setTargetLocation : undefined}
                slicedForModel={slicedForModel}
              />
            )}

            {/* Model assignments can be dispatched to any matching printer. Keep
                their profile controls together and out of the way by default. */}
            {assignmentMode === 'model' && (isCrossModel || targetModel) && !hasEditingVariants && (
              <section className="mb-4">
                <button
                  type="button"
                  onClick={() => setIsModelFilamentOptionsExpanded((expanded) => !expanded)}
                  aria-expanded={isModelFilamentOptionsExpanded}
                  aria-controls="model-filament-options"
                  className="flex w-full items-center gap-2 text-sm text-bambu-gray transition-colors hover:text-white"
                >
                  <Palette className="h-4 w-4" />
                  <span>{t('printModal.filamentOverride')}</span>
                  {isModelFilamentOptionsExpanded ? <ChevronUp className="ml-auto h-4 w-4" /> : <ChevronDown className="ml-auto h-4 w-4" />}
                </button>

                {isModelFilamentOptionsExpanded && (
                  <div id="model-filament-options" className="mt-2 space-y-3 rounded-lg bg-bambu-dark p-3">
                    <label className="group flex cursor-pointer items-center justify-between pb-2 border-b border-bambu-dark-tertiary">
                      <div>
                        <span className="text-sm text-white">{t('printModal.forceColorMatch')}</span>
                        <p className="text-xs text-bambu-gray">{t('printModal.forceColorMatchHint')}</p>
                      </div>
                      <input
                        type="checkbox"
                        checked={forceColorMatch}
                        onChange={(event) => setForceColorMatch(event.target.checked)}
                        className="peer sr-only"
                      />
                      <div className={`relative w-10 h-5 rounded-full transition-colors ${forceColorMatch ? 'bg-bambu-green' : 'bg-bambu-dark-tertiary'}`}>
                        <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${forceColorMatch ? 'translate-x-5' : 'translate-x-0.5'}`} />
                      </div>
                    </label>
                    <FilamentOverride
                      filamentReqs={effectiveFilamentReqs}
                      availableFilaments={effectiveAvailableFilaments ?? []}
                      overrides={filamentOverrides}
                      onChange={setFilamentOverrides}
                      forceColorMatch={forceColorMatch}
                      currencySymbol={currencySymbol}
                      defaultCostPerKg={defaultCostPerKg}
                      embedded
                      showHeader={false}
                    />
                  </div>
                )}
              </section>
            )}

            {/* Compatibility warning when sliced model doesn't match selected printer */}
            {slicedForModel && assignmentMode === 'printer' && selectedPrinters.length === 1 && (() => {
              const selectedPrinter = printers?.find(p => p.id === selectedPrinters[0]);
              if (selectedPrinter && selectedPrinter.model && slicedForModel !== selectedPrinter.model) {
                return (
                  <div className="p-3 mb-2 bg-yellow-500/10 border border-yellow-500/30 rounded-lg flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-yellow-400 flex-shrink-0" />
                    <span className="text-sm text-yellow-400">
                      File was sliced for {slicedForModel}, but printing on {selectedPrinter.model}
                    </span>
                  </div>
                );
              }
              return null;
            })()}

            {/* Warning when archive data couldn't be loaded */}
            {archiveDataMissing && (
              <div className="flex items-start gap-2 p-3 mb-2 bg-orange-500/10 border border-orange-500/30 rounded-lg text-sm">
                <AlertCircle className="w-4 h-4 text-orange-400 mt-0.5 flex-shrink-0" />
                <p className="text-orange-400">
                  Archive data unavailable. The source file may have been deleted. Filament mapping is disabled.
                </p>
              </div>
            )}

            {/* Slot mapping only applies to an explicitly selected printer. Model
                assignments derive their mapping from the chosen printer at dispatch. */}
            {assignmentMode === 'printer' && showFilamentMapping && !archiveDataMissing && selectedPrinters.length === 1 && (
              <FilamentMapping
                printerId={effectivePrinterId!}
                filamentReqs={effectiveFilamentReqs}
                manualMappings={manualMappings}
                onManualMappingChange={handleManualMappingChange}
                defaultExpanded={settings?.per_printer_mapping_expanded ?? false}
                currencySymbol={currencySymbol}
                defaultCostPerKg={defaultCostPerKg}
                forceColorMatch={forceColorMatch}
                onForceColorMatchChange={setForceColorMatch}
              />
            )}

            {/* Multiple-printer assignments have no single filament mapping
                panel, so retain this control alongside their filament UI. */}
            {!!effectiveFilamentReqs?.filaments?.length && !archiveDataMissing &&
              assignmentMode !== 'model' && selectedPrinters.length !== 1 && (
                <label className="flex items-center justify-between bg-bambu-dark rounded-lg p-3 cursor-pointer">
                  <div>
                    <span className="text-sm text-white">{t('printModal.forceColorMatch')}</span>
                    <p className="text-xs text-bambu-gray">{t('printModal.forceColorMatchHint')}</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={forceColorMatch}
                    onChange={(event) => setForceColorMatch(event.target.checked)}
                    className="peer sr-only"
                  />
                  <div className={`relative w-10 h-5 rounded-full transition-colors ${forceColorMatch ? 'bg-bambu-green' : 'bg-bambu-dark-tertiary'}`}>
                    <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${forceColorMatch ? 'translate-x-5' : 'translate-x-0.5'}`} />
                  </div>
                </label>
              )}

            {/* Print options */}
            {(mode === 'create' || effectivePrinterCount > 0 || (assignmentMode === 'model' && targetModel)) && (
              <PrintOptionsPanel
                options={printOptions}
                onChange={setPrintOptions}
                showDualNozzleOptions={showDualNozzleOptions}
              />
            )}

            <ScheduleOptionsPanel
              hasChamberHeater={(assignmentMode === 'model' ? [targetModel] : selectedPrinters.map(id => printers?.find(printer => printer.id === id)?.model))
                .every(model => ['H2C', 'H2D', 'H2DPRO', 'H2S', 'X2D', 'O1C', 'O1C2', 'O1D', 'O1E', 'O2D', 'O1S', 'N6'].includes((model || '').replace(/\s/g, '').toUpperCase()))}
              options={scheduleOptions}
              onChange={setScheduleOptions}
              dateFormat={settings?.date_format || 'system'}
              timeFormat={settings?.time_format || 'system'}
              canControlPrinter={hasPermission('printers:control')}
              canInsertAtTop={canInsertAtTop}
              showAutoOff={canAutoOffAfterPrint}
              hasGcodeSnippets={!!settings?.gcode_snippets}
            />

            {/* Quantity — create independent queue items. Hidden for multi-printer
                selection, and for multi-plate files where the per-plate steppers
                in PlateSelector own the number instead (#342). */}
            {mode !== 'edit-queue-item' && !usePerPlateQuantities
              && (assignmentMode === 'model' || selectedPrinters.length <= 1) && (
              <div className="flex items-center gap-3">
                <label htmlFor="printQuantity" className="text-sm text-bambu-gray whitespace-nowrap">
                  {t('queue.quantity', 'Quantity')}
                </label>
                <input
                  id="printQuantity"
                  type="number"
                  min={1}
                  max={999}
                  value={quantity}
                  onChange={(e) => setQuantity(Math.max(1, Math.min(999, parseInt(e.target.value) || 1)))}
                  className="w-20 px-2 py-1 text-sm bg-bambu-dark border border-bambu-dark-tertiary rounded text-white focus:outline-none focus:ring-1 focus:ring-bambu-green"
                />
                {quantity > 1 && (
                  <span className="text-xs text-bambu-gray">
                    {t('queue.quantityHint', 'Creates {{count}} queue items', { count: quantity })}
                  </span>
                )}
              </div>
            )}

            {/* Error message */}
            {updateQueueMutation.isError && (
              <div className="mb-4 p-3 bg-red-500/20 border border-red-500/50 rounded-lg text-sm text-red-400">
                {(updateQueueMutation.error as Error)?.message || 'Failed to complete operation'}
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3 pt-2">
              <Button type="button" variant="secondary" onClick={onClose} className="flex-1" disabled={isSubmitting}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!canSubmit}
                className="flex-1"
              >
                {isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {modalConfig.loadingText}
                  </>
                ) : (
                  <>
                    <SubmitIcon className="w-4 h-4" />
                    {modalConfig.submitText}
                  </>
                )}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {filamentWarningItems && filamentWarningItems.length > 0 && (
        <ConfirmModal
          title={t('printModal.insufficientFilamentTitle')}
          message={filamentWarningMessage}
          confirmText={t('printModal.printAnyway')}
          cancelText={t('common.cancel')}
          variant="warning"
          onConfirm={() => {
            setFilamentWarningItems(null);
            void handleSubmit(undefined, { skipFilamentCheck: true });
          }}
          onCancel={() => setFilamentWarningItems(null)}
        />
      )}
    </div>
  );
}

// Re-export types for convenience
export type { PrintModalMode, PrintModalProps } from './types';
