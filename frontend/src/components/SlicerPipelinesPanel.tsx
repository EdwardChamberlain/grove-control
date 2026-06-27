import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Edit2, Loader2, Trash2, Workflow, X } from 'lucide-react';
import {
  api,
  type PresetRef,
  type PresetSource,
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

  const updateMutation = useMutation({
    mutationFn: ({ id, name, description }: { id: number; name?: string; description?: string | null }) =>
      api.updateSlicerPipeline(id, { name, description }),
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
                onRename={(name, description) => updateMutation.mutate({ id: p.id, name, description })}
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
  onRename,
  onDelete,
  saving,
  deleting,
}: {
  pipeline: SlicerPipeline;
  presets: UnifiedPresetsResponse | undefined;
  onRename: (name: string, description: string | null) => void;
  onDelete: () => void;
  saving: boolean;
  deleting: boolean;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(pipeline.name);
  const [draftDescription, setDraftDescription] = useState(pipeline.description ?? '');

  const printerName = resolveName(presets, 'printer', pipeline.printer_preset);
  const processName = resolveName(presets, 'process', pipeline.process_preset);
  const filamentResolutions = pipeline.filament_presets.map((f) => resolveName(presets, 'filament', f));
  const hasStaleRef =
    presets !== undefined &&
    (printerName === null || processName === null || filamentResolutions.some((n) => n === null));

  const handleSave = () => {
    const trimmedName = draftName.trim();
    if (!trimmedName) return;
    onRename(trimmedName, draftDescription.trim() || null);
    setEditing(false);
  };

  const handleCancel = () => {
    setDraftName(pipeline.name);
    setDraftDescription(pipeline.description ?? '');
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
