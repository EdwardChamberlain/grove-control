import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Edit2, Loader2, Printer as PrinterIcon, Trash2, Workflow, X } from 'lucide-react';
import {
  api,
  type PipelineRun,
  type PresetRef,
  type PresetSource,
  type Printer as PrinterType,
  type SlicerPipeline,
  type UnifiedPresetsResponse,
} from '../api/client';
import { Card, CardContent, CardHeader } from './Card';
import { useToast } from '../contexts/ToastContext';

// Resolve a PresetRef back to its pretty name via the unified-presets listing.
// Returns null when the ref no longer points at a known preset — render a
// "deleted" badge in that case so users can see what to fix.
function resolveName(presets: UnifiedPresetsResponse | undefined, slot: 'printer' | 'process' | 'filament', ref: PresetRef): string | null {
  if (!presets) return null;
  const list = presets[ref.source]?.[slot] ?? [];
  const hit = list.find((p) => p.id === ref.id);
  return hit ? hit.name : null;
}

const SOURCE_LABEL: Record<PresetSource, string> = {
  orca_cloud: 'Orca Cloud',
  cloud: 'Bambu Cloud',
  local: 'Imported',
  standard: 'Standard',
};

export function SlicerPipelinesPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const { data: list, isLoading, error } = useQuery({
    queryKey: ['slicer-pipelines'],
    queryFn: () => api.listSlicerPipelines(),
  });

  // The unified presets endpoint is the source of pretty names for each
  // PresetRef. Same listing the SliceModal pulls — reused here to avoid a
  // second round-trip to the slicer registry.
  const { data: presets } = useQuery({
    queryKey: ['slicer-presets'],
    queryFn: () => api.getSlicerPresets(),
  });

  // Printers list for the target picker (PR B).
  const { data: printers } = useQuery({
    queryKey: ['printers'],
    queryFn: () => api.getPrinters(),
  });

  const updateMutation = useMutation({
    mutationFn: ({
      id,
      name,
      description,
      target_printer_id,
      target_kind,
    }: {
      id: number;
      name?: string;
      description?: string | null;
      target_printer_id?: number | null;
      target_kind?: 'specific_printer' | 'printer_class';
    }) =>
      api.updateSlicerPipeline(id, { name, description, target_printer_id, target_kind }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['slicer-pipelines'] });
      showToast(t('settings.pipelines.toast.saved', 'Pipeline saved'), 'success');
    },
    onError: (err: Error) => {
      showToast(err.message || t('settings.pipelines.toast.saveFailed', 'Save failed'), 'error');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteSlicerPipeline(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['slicer-pipelines'] });
      showToast(t('settings.pipelines.toast.deleted', 'Pipeline deleted'), 'success');
    },
    onError: (err: Error) => {
      showToast(err.message || t('settings.pipelines.toast.deleteFailed', 'Delete failed'), 'error');
    },
  });

  const pipelines = list?.pipelines ?? [];

  return (
    <Card>
      <CardHeader>
        <h3 className="text-base font-semibold text-white flex items-center gap-2">
          <Workflow className="w-4 h-4 text-bambu-green" />
          {t('settings.pipelines.title', 'Slicer Pipelines')}
        </h3>
        <p className="text-xs text-bambu-gray mt-1">
          {t(
            'settings.pipelines.subtitle',
            'Reusable preset bundles (printer + process + filaments + bed type). Save one from the Slice dialog and apply it with a single click on the next file.',
          )}
        </p>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-bambu-gray">
            <Loader2 className="w-4 h-4 animate-spin" />
            {t('settings.pipelines.loading', 'Loading pipelines…')}
          </div>
        )}
        {error && (
          <div className="text-sm text-red-400">
            {t('settings.pipelines.loadError', 'Could not load pipelines.')}
          </div>
        )}
        {!isLoading && !error && pipelines.length === 0 && (
          <div className="text-sm text-bambu-gray space-y-2">
            <p>{t('settings.pipelines.empty.title', 'No pipelines yet.')}</p>
            <p>
              {t(
                'settings.pipelines.empty.howto',
                'Open the Slice dialog for any file, pick your printer / process / filaments / bed type, then click "Save as pipeline". Your saved pipelines will appear here.',
              )}
            </p>
          </div>
        )}
        {!isLoading && !error && pipelines.length > 0 && (
          <div className="space-y-2">
            {pipelines.map((p) => (
              <PipelineRow
                key={p.id}
                pipeline={p}
                presets={presets}
                printers={printers ?? []}
                onSave={(payload) => updateMutation.mutate({ id: p.id, ...payload })}
                onDelete={() => {
                  if (confirm(t('settings.pipelines.confirmDelete', 'Delete this pipeline? This cannot be undone.'))) {
                    deleteMutation.mutate(p.id);
                  }
                }}
                saving={updateMutation.isPending}
                deleting={deleteMutation.isPending}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PipelineRow({
  pipeline,
  presets,
  printers,
  onSave,
  onDelete,
  saving,
  deleting,
}: {
  pipeline: SlicerPipeline;
  presets: UnifiedPresetsResponse | undefined;
  printers: PrinterType[];
  onSave: (payload: {
    name?: string;
    description?: string | null;
    target_printer_id?: number | null;
    target_kind?: 'specific_printer' | 'printer_class';
    target_model_class?: string | null;
    fanout_strategy?: 'max_parallel' | 'fill_one_first' | 'round_robin';
  }) => void;
  onDelete: () => void;
  saving: boolean;
  deleting: boolean;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(pipeline.name);
  const [draftDescription, setDraftDescription] = useState(pipeline.description ?? '');
  const [draftTargetPrinterId, setDraftTargetPrinterId] = useState<number | null>(
    pipeline.target_printer_id,
  );
  // PR C: target kind, model class, and fanout strategy.
  const [draftTargetKind, setDraftTargetKind] = useState<'specific_printer' | 'printer_class'>(
    pipeline.target_kind === 'printer_class' ? 'printer_class' : 'specific_printer',
  );
  const [draftTargetModelClass, setDraftTargetModelClass] = useState<string>(
    pipeline.target_model_class ?? '',
  );
  const [draftFanout, setDraftFanout] = useState<'max_parallel' | 'fill_one_first' | 'round_robin'>(
    pipeline.fanout_strategy ?? 'max_parallel',
  );
  // Installed model classes — derived from the loaded printers list so the
  // dropdown only offers models the user actually has. Same data the row
  // header uses, no second fetch.
  const installedModels = Array.from(
    new Set(printers.map((p) => p.model).filter((m): m is string => !!m)),
  ).sort();

  // Recent runs for the inline last-run summary. ``enabled: editing === false``
  // avoids re-querying every keystroke while the editor is open.
  const { data: runsList } = useQuery({
    queryKey: ['pipeline-runs', pipeline.id],
    queryFn: () => api.listPipelineRuns(pipeline.id, 1),
    enabled: !editing,
    refetchInterval: 15_000,
  });
  const lastRun: PipelineRun | undefined = runsList?.runs?.[0];

  const printerName = resolveName(presets, 'printer', pipeline.printer_preset);
  const processName = resolveName(presets, 'process', pipeline.process_preset);
  const filamentResolutions = pipeline.filament_presets.map((f) => resolveName(presets, 'filament', f));
  const hasStaleRef =
    presets !== undefined &&
    (printerName === null || processName === null || filamentResolutions.some((n) => n === null));
  const targetPrinter = pipeline.target_printer_id
    ? printers.find((p) => p.id === pipeline.target_printer_id)
    : undefined;
  const isClassTargeting = pipeline.target_kind === 'printer_class';
  const needsTarget = isClassTargeting
    ? !pipeline.target_model_class
    : pipeline.target_printer_id === null;

  const handleSave = () => {
    const trimmedName = draftName.trim();
    if (!trimmedName) return;
    onSave({
      name: trimmedName,
      description: draftDescription.trim() || null,
      target_kind: draftTargetKind,
      // Backend treats 0 as "clear"; null in TS maps to that intent.
      target_printer_id:
        draftTargetKind === 'specific_printer' ? (draftTargetPrinterId ?? 0) : 0,
      target_model_class:
        draftTargetKind === 'printer_class' ? (draftTargetModelClass || null) : null,
      fanout_strategy: draftFanout,
    });
    setEditing(false);
  };

  const handleCancel = () => {
    setDraftName(pipeline.name);
    setDraftDescription(pipeline.description ?? '');
    setDraftTargetPrinterId(pipeline.target_printer_id);
    setDraftTargetKind(pipeline.target_kind === 'printer_class' ? 'printer_class' : 'specific_printer');
    setDraftTargetModelClass(pipeline.target_model_class ?? '');
    setDraftFanout(pipeline.fanout_strategy ?? 'max_parallel');
    setEditing(false);
  };

  return (
    <div className="rounded-md border border-bambu-dark-tertiary bg-bambu-dark/40 px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="space-y-2">
              <input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                aria-label={t('settings.pipelines.field.name', 'Pipeline name')}
                placeholder={t('settings.pipelines.field.name', 'Pipeline name')}
                className="w-full px-2 py-1 text-sm bg-bambu-dark border border-bambu-dark-tertiary rounded text-white"
              />
              <textarea
                value={draftDescription}
                onChange={(e) => setDraftDescription(e.target.value)}
                aria-label={t('settings.pipelines.field.description', 'Description')}
                placeholder={t('settings.pipelines.field.description', 'Description')}
                rows={2}
                className="w-full px-2 py-1 text-xs bg-bambu-dark border border-bambu-dark-tertiary rounded text-white"
              />
              {/* PR C — target-kind radio (Specific printer / Printer class)
                  drives whether the printer dropdown or the class picker is
                  active. Both fields are kept on state so toggling back and
                  forth doesn't lose the user's previous pick. */}
              <div>
                <label className="text-xs text-bambu-gray block mb-1">
                  {t('settings.pipelines.field.targetKind', 'Target type')}
                </label>
                <div className="flex gap-3 text-xs">
                  <label className="flex items-center gap-1 text-white">
                    <input
                      type="radio"
                      name={`target-kind-${pipeline.id}`}
                      value="specific_printer"
                      checked={draftTargetKind === 'specific_printer'}
                      onChange={() => setDraftTargetKind('specific_printer')}
                      aria-label={t('settings.pipelines.field.targetKindSpecific', 'Specific printer')}
                    />
                    {t('settings.pipelines.field.targetKindSpecific', 'Specific printer')}
                  </label>
                  <label className="flex items-center gap-1 text-white">
                    <input
                      type="radio"
                      name={`target-kind-${pipeline.id}`}
                      value="printer_class"
                      checked={draftTargetKind === 'printer_class'}
                      onChange={() => setDraftTargetKind('printer_class')}
                      aria-label={t('settings.pipelines.field.targetKindClass', 'Printer class')}
                    />
                    {t('settings.pipelines.field.targetKindClass', 'Printer class')}
                  </label>
                </div>
              </div>

              {draftTargetKind === 'specific_printer' ? (
                <div>
                  <label className="text-xs text-bambu-gray block mb-1">
                    {t('settings.pipelines.field.targetPrinter', 'Target printer')}
                  </label>
                  <select
                    value={draftTargetPrinterId ?? ''}
                    onChange={(e) =>
                      setDraftTargetPrinterId(e.target.value ? parseInt(e.target.value, 10) : null)
                    }
                    aria-label={t('settings.pipelines.field.targetPrinter', 'Target printer')}
                    className="w-full px-2 py-1 text-xs bg-bambu-dark border border-bambu-dark-tertiary rounded text-white"
                  >
                    <option value="">
                      {t('settings.pipelines.field.noTarget', '— No target —')}
                    </option>
                    {printers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="space-y-2">
                  <div>
                    <label className="text-xs text-bambu-gray block mb-1">
                      {t('settings.pipelines.field.targetModelClass', 'Printer model')}
                    </label>
                    <select
                      value={draftTargetModelClass}
                      onChange={(e) => setDraftTargetModelClass(e.target.value)}
                      aria-label={t('settings.pipelines.field.targetModelClass', 'Printer model')}
                      className="w-full px-2 py-1 text-xs bg-bambu-dark border border-bambu-dark-tertiary rounded text-white"
                    >
                      <option value="">
                        {t('settings.pipelines.field.noTarget', '— No target —')}
                      </option>
                      {installedModels.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-bambu-gray block mb-1">
                      {t('settings.pipelines.field.fanoutStrategy', 'Fanout strategy')}
                    </label>
                    <select
                      value={draftFanout}
                      onChange={(e) =>
                        setDraftFanout(e.target.value as 'max_parallel' | 'fill_one_first' | 'round_robin')
                      }
                      aria-label={t('settings.pipelines.field.fanoutStrategy', 'Fanout strategy')}
                      className="w-full px-2 py-1 text-xs bg-bambu-dark border border-bambu-dark-tertiary rounded text-white"
                    >
                      <option value="max_parallel">
                        {t('settings.pipelines.field.fanout.max_parallel', 'Max parallel — distribute across any idle matching printer')}
                      </option>
                      <option value="round_robin">
                        {t('settings.pipelines.field.fanout.round_robin', 'Round robin — cycle through eligible printers')}
                      </option>
                      <option value="fill_one_first">
                        {t('settings.pipelines.field.fanout.fill_one_first', 'Fill one first — pin all copies to one printer')}
                      </option>
                    </select>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
              <h4 className="text-sm font-medium text-white truncate">{pipeline.name}</h4>
              {pipeline.description && (
                <p className="text-xs text-bambu-gray mt-0.5">{pipeline.description}</p>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {editing ? (
            <>
              <button
                onClick={handleSave}
                disabled={saving || !draftName.trim()}
                aria-label={t('settings.pipelines.action.save', 'Save')}
                className="p-1.5 text-bambu-green hover:bg-bambu-dark-tertiary rounded disabled:opacity-50"
              >
                <Check className="w-4 h-4" />
              </button>
              <button
                onClick={handleCancel}
                aria-label={t('settings.pipelines.action.cancel', 'Cancel')}
                className="p-1.5 text-bambu-gray hover:bg-bambu-dark-tertiary rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setEditing(true)}
                aria-label={t('settings.pipelines.action.rename', 'Rename')}
                className="p-1.5 text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary rounded"
              >
                <Edit2 className="w-4 h-4" />
              </button>
              <button
                onClick={onDelete}
                disabled={deleting}
                aria-label={t('settings.pipelines.action.delete', 'Delete')}
                className="p-1.5 text-bambu-gray hover:text-red-400 hover:bg-bambu-dark-tertiary rounded disabled:opacity-50"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      </div>

      {!editing && (
        <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <PresetLine
            label={t('settings.pipelines.slot.printer', 'Printer')}
            ref={pipeline.printer_preset}
            name={printerName}
          />
          <PresetLine
            label={t('settings.pipelines.slot.process', 'Process')}
            ref={pipeline.process_preset}
            name={processName}
          />
          {pipeline.filament_presets.map((f, i) => (
            <PresetLine
              key={i}
              label={
                pipeline.filament_presets.length > 1
                  ? t('settings.pipelines.slot.filamentN', 'Filament {{n}}', { n: i + 1 })
                  : t('settings.pipelines.slot.filament', 'Filament')
              }
              ref={f}
              name={filamentResolutions[i]}
            />
          ))}
          {pipeline.bed_type && (
            <div className="text-bambu-gray">
              <span className="font-medium text-bambu-gray/80">
                {t('settings.pipelines.slot.bed', 'Bed')}:
              </span>{' '}
              <span className="text-white">{pipeline.bed_type}</span>
            </div>
          )}
          <div className="text-bambu-gray flex items-center gap-1">
            <PrinterIcon className="w-3 h-3" />
            <span className="font-medium text-bambu-gray/80">
              {isClassTargeting
                ? t('settings.pipelines.field.targetModelClass', 'Printer model')
                : t('settings.pipelines.field.targetPrinter', 'Target printer')}
              :
            </span>{' '}
            {isClassTargeting && pipeline.target_model_class ? (
              <span className="text-white">
                {pipeline.target_model_class}
                {pipeline.fanout_strategy && (
                  <span className="text-bambu-gray/60">
                    {' '}· {t(`settings.pipelines.field.fanout.${pipeline.fanout_strategy}`, pipeline.fanout_strategy)}
                  </span>
                )}
              </span>
            ) : targetPrinter ? (
              <span className="text-white">{targetPrinter.name}</span>
            ) : (
              <span className="text-amber-400">
                {t('settings.pipelines.noTargetHint', 'Set a target printer to run this')}
              </span>
            )}
          </div>
        </div>
      )}

      {!editing && lastRun && (
        <div className="mt-1.5 text-xs text-bambu-gray flex items-center gap-1">
          <span className="font-medium text-bambu-gray/80">
            {t('settings.pipelines.runs.lastRun', 'Last run')}:
          </span>{' '}
          <RunStatusBadge status={lastRun.status} />
          {lastRun.created_at && (
            <span className="text-bambu-gray/60">
              · {new Date(lastRun.created_at).toLocaleString()}
            </span>
          )}
        </div>
      )}

      {needsTarget && !editing && (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-amber-400">
          <AlertTriangle className="w-3.5 h-3.5" />
          {t(
            'settings.pipelines.noTargetWarning',
            'Set a target printer before running this pipeline.',
          )}
        </div>
      )}

      {hasStaleRef && !editing && (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-amber-400">
          <AlertTriangle className="w-3.5 h-3.5" />
          {t(
            'settings.pipelines.staleWarning',
            'One or more referenced presets no longer exist. Re-save this pipeline from the Slice dialog to fix.',
          )}
        </div>
      )}
    </div>
  );
}

function RunStatusBadge({ status }: { status: PipelineRun['status'] }) {
  const { t } = useTranslation();
  const colourClass: Record<PipelineRun['status'], string> = {
    queued: 'text-bambu-gray',
    slicing: 'text-blue-400',
    dispatching: 'text-blue-400',
    in_progress: 'text-bambu-green',
    completed: 'text-bambu-green',
    failed: 'text-red-400',
    partial_failure: 'text-amber-400',
    cancelled: 'text-bambu-gray',
  };
  return (
    <span className={colourClass[status]}>
      {t(`settings.pipelines.runs.status.${status}`, status)}
    </span>
  );
}

function PresetLine({
  label,
  ref,
  name,
}: {
  label: string;
  ref: PresetRef;
  name: string | null;
}) {
  return (
    <div className="text-bambu-gray truncate">
      <span className="font-medium text-bambu-gray/80">{label}:</span>{' '}
      {name ? (
        <span className="text-white">{name}</span>
      ) : (
        <span className="text-amber-400">[{SOURCE_LABEL[ref.source]} #{ref.id}]</span>
      )}
    </div>
  );
}
