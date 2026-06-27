import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  RotateCcw,
  Workflow,
  X,
} from 'lucide-react';
import { api, type PipelineRun, type SlicerPipeline } from '../api/client';
import { useToast } from '../contexts/ToastContext';

const STATUSES = [
  '',
  'queued',
  'slicing',
  'dispatching',
  'in_progress',
  'completed',
  'partial_failure',
  'failed',
  'cancelled',
] as const;

const PAGE_LIMIT = 25;

// Dashboard for Slicer Pipeline runs (#1425 PR C).
// Lists every run across every pipeline with status + pipeline filters and
// pagination. Each row expands to show per-copy status; in-flight runs get a
// Cancel button, partial-failure runs get a Retry-failed button.
export function PipelineRunsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [statusFilter, setStatusFilter] = useState<string>('');
  const [pipelineFilter, setPipelineFilter] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const { data: pipelines } = useQuery({
    queryKey: ['slicer-pipelines'],
    queryFn: () => api.listSlicerPipelines(),
  });

  const { data: runsList, isLoading } = useQuery({
    queryKey: ['pipeline-runs-all', statusFilter, pipelineFilter, offset],
    queryFn: () =>
      api.listAllPipelineRuns({
        limit: PAGE_LIMIT,
        offset,
        pipelineId: pipelineFilter ?? undefined,
        status: statusFilter || undefined,
      }),
    refetchInterval: 15_000,
  });

  const cancelMutation = useMutation({
    mutationFn: (runId: number) => api.cancelPipelineRun(runId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pipeline-runs-all'] });
      showToast(t('pipelineRuns.toast.cancelled', 'Run cancelled'), 'success');
    },
    onError: (err: Error) =>
      showToast(err.message || t('pipelineRuns.toast.cancelFailed', 'Cancel failed'), 'error'),
  });

  const retryMutation = useMutation({
    mutationFn: (runId: number) => api.retryFailedPipelineRun(runId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pipeline-runs-all'] });
      showToast(t('pipelineRuns.toast.retryStarted', 'Retry started'), 'success');
    },
    onError: (err: Error) =>
      showToast(err.message || t('pipelineRuns.toast.retryFailed', 'Retry failed'), 'error'),
  });

  const runs = runsList?.runs ?? [];
  const total = runsList?.total ?? 0;
  const pipelinesById: Record<number, SlicerPipeline> = (pipelines?.pipelines ?? []).reduce(
    (acc, p) => {
      acc[p.id] = p;
      return acc;
    },
    {} as Record<number, SlicerPipeline>,
  );

  const toggle = (runId: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  };

  return (
    <div className="px-4 py-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          <Workflow className="w-5 h-5 text-bambu-green" />
          {t('pipelineRuns.title', 'Pipeline Runs')}
        </h1>
        <button
          type="button"
          onClick={() => queryClient.invalidateQueries({ queryKey: ['pipeline-runs-all'] })}
          aria-label={t('common.refresh', 'Refresh')}
          className="p-2 text-bambu-gray hover:text-white"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4 text-sm">
        <label className="text-bambu-gray">
          {t('pipelineRuns.filter.pipeline', 'Pipeline')}:{' '}
          <select
            value={pipelineFilter ?? ''}
            onChange={(e) => {
              setOffset(0);
              setPipelineFilter(e.target.value ? parseInt(e.target.value, 10) : null);
            }}
            aria-label={t('pipelineRuns.filter.pipeline', 'Pipeline')}
            className="ml-1 px-2 py-1 bg-bambu-dark border border-bambu-dark-tertiary rounded text-white text-xs"
          >
            <option value="">{t('pipelineRuns.filter.all', 'All')}</option>
            {(pipelines?.pipelines ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-bambu-gray">
          {t('pipelineRuns.filter.status', 'Status')}:{' '}
          <select
            value={statusFilter}
            onChange={(e) => {
              setOffset(0);
              setStatusFilter(e.target.value);
            }}
            aria-label={t('pipelineRuns.filter.status', 'Status')}
            className="ml-1 px-2 py-1 bg-bambu-dark border border-bambu-dark-tertiary rounded text-white text-xs"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s === '' ? t('pipelineRuns.filter.all', 'All') : t(`settings.pipelines.runs.status.${s}`, s)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-bambu-gray">
          <Loader2 className="w-4 h-4 animate-spin" />
          {t('pipelineRuns.loading', 'Loading…')}
        </div>
      )}
      {!isLoading && runs.length === 0 && (
        <p className="text-sm text-bambu-gray">{t('pipelineRuns.empty', 'No pipeline runs yet.')}</p>
      )}

      {!isLoading && runs.length > 0 && (
        <div className="space-y-2">
          {runs.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              pipeline={run.pipeline_id ? pipelinesById[run.pipeline_id] : undefined}
              expanded={expanded.has(run.id)}
              onToggle={() => toggle(run.id)}
              onCancel={() => cancelMutation.mutate(run.id)}
              onRetry={() => retryMutation.mutate(run.id)}
              cancelling={cancelMutation.isPending}
              retrying={retryMutation.isPending}
            />
          ))}
        </div>
      )}

      {!isLoading && total > PAGE_LIMIT && (
        <div className="flex items-center justify-between mt-4 text-sm">
          <button
            type="button"
            onClick={() => setOffset(Math.max(0, offset - PAGE_LIMIT))}
            disabled={offset === 0}
            className="px-3 py-1.5 rounded border border-bambu-dark-tertiary disabled:opacity-50 text-bambu-gray hover:text-white"
          >
            {t('common.previous', 'Previous')}
          </button>
          <span className="text-bambu-gray text-xs">
            {t('pipelineRuns.pagination', '{{start}}–{{end}} of {{total}}', {
              start: offset + 1,
              end: Math.min(offset + PAGE_LIMIT, total),
              total,
            })}
          </span>
          <button
            type="button"
            onClick={() => setOffset(offset + PAGE_LIMIT)}
            disabled={offset + PAGE_LIMIT >= total}
            className="px-3 py-1.5 rounded border border-bambu-dark-tertiary disabled:opacity-50 text-bambu-gray hover:text-white"
          >
            {t('common.next', 'Next')}
          </button>
        </div>
      )}
    </div>
  );
}

function RunRow({
  run,
  pipeline,
  expanded,
  onToggle,
  onCancel,
  onRetry,
  cancelling,
  retrying,
}: {
  run: PipelineRun;
  pipeline: SlicerPipeline | undefined;
  expanded: boolean;
  onToggle: () => void;
  onCancel: () => void;
  onRetry: () => void;
  cancelling: boolean;
  retrying: boolean;
}) {
  const { t } = useTranslation();
  const inFlight = ['queued', 'slicing', 'dispatching', 'in_progress'].includes(run.status);
  const partial = run.status === 'partial_failure' || run.status === 'failed';

  return (
    <div className="rounded-md border border-bambu-dark-tertiary bg-bambu-dark/40">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={onToggle}
          aria-label={expanded ? t('common.collapse', 'Collapse') : t('common.expand', 'Expand')}
          aria-expanded={expanded}
          className="text-bambu-gray hover:text-white"
        >
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium text-white truncate">
              #{run.id} · {pipeline?.name ?? run.pipeline_name ?? '—'}
            </span>
            <RunStatusChip status={run.status} />
            {run.parent_run_id && (
              <span className="text-xs text-bambu-gray/60">
                ({t('pipelineRuns.retryOf', 'retry of #{{n}}', { n: run.parent_run_id })})
              </span>
            )}
          </div>
          <div className="text-xs text-bambu-gray mt-0.5">
            {run.source_filename ?? '—'} · {new Date(run.created_at).toLocaleString()}
            {run.copies > 1 && (
              <>
                {' '}· {t('pipelineRuns.copies', '{{n}} copies', { n: run.copies })}
              </>
            )}
            {(run.copies_completed > 0 || run.copies_failed > 0) && (
              <>
                {' '}·{' '}
                <span className="text-bambu-green">
                  {run.copies_completed}
                </span>
                /{run.copies}
                {run.copies_failed > 0 && (
                  <>
                    {' '}·{' '}
                    <span className="text-red-400">
                      {t('pipelineRuns.failedCount', '{{n}} failed', { n: run.copies_failed })}
                    </span>
                  </>
                )}
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {inFlight && (
            <button
              type="button"
              onClick={onCancel}
              disabled={cancelling}
              aria-label={t('common.cancel', 'Cancel')}
              className="text-xs px-2 py-1 text-red-400 hover:bg-bambu-dark-tertiary rounded disabled:opacity-50 flex items-center gap-1"
            >
              <X className="w-3 h-3" />
              {t('common.cancel', 'Cancel')}
            </button>
          )}
          {partial && (
            <button
              type="button"
              onClick={onRetry}
              disabled={retrying}
              aria-label={t('pipelineRuns.retryFailed', 'Retry failed')}
              className="text-xs px-2 py-1 text-bambu-green hover:bg-bambu-dark-tertiary rounded disabled:opacity-50 flex items-center gap-1"
            >
              <RotateCcw className="w-3 h-3" />
              {t('pipelineRuns.retryFailed', 'Retry failed')}
            </button>
          )}
        </div>
      </div>
      {expanded && (
        <div className="border-t border-bambu-dark-tertiary px-3 py-2 space-y-1">
          {run.jobs.map((job) => (
            <div key={job.id} className="flex items-center gap-2 text-xs text-bambu-gray">
              <span className="text-bambu-gray/60 w-12">
                {t('pipelineRuns.copyN', 'Copy {{n}}', { n: job.copy_index + 1 })}
              </span>
              <JobStatusChip status={job.status} />
              {job.assigned_printer_name && (
                <span className="text-white">{job.assigned_printer_name}</span>
              )}
              {job.error_message && (
                <span className="text-red-400 truncate">{job.error_message}</span>
              )}
            </div>
          ))}
          {run.error_message && (
            <div className="text-xs text-red-400 mt-1">
              {run.error_message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RunStatusChip({ status }: { status: PipelineRun['status'] }) {
  const { t } = useTranslation();
  const colours: Record<PipelineRun['status'], string> = {
    queued: 'bg-bambu-gray/20 text-bambu-gray',
    slicing: 'bg-blue-500/20 text-blue-300',
    dispatching: 'bg-blue-500/20 text-blue-300',
    in_progress: 'bg-bambu-green/20 text-bambu-green',
    completed: 'bg-bambu-green/20 text-bambu-green',
    failed: 'bg-red-500/20 text-red-300',
    partial_failure: 'bg-amber-500/20 text-amber-300',
    cancelled: 'bg-bambu-gray/20 text-bambu-gray',
  };
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase ${colours[status]}`}>
      {t(`settings.pipelines.runs.status.${status}`, status)}
    </span>
  );
}

function JobStatusChip({ status }: { status: PipelineRun['jobs'][number]['status'] }) {
  const { t } = useTranslation();
  const colours: Record<PipelineRun['jobs'][number]['status'], string> = {
    pending: 'text-bambu-gray',
    awaiting_printer: 'text-blue-300',
    queued: 'text-blue-300',
    printing: 'text-bambu-green',
    completed: 'text-bambu-green',
    failed: 'text-red-400',
    cancelled: 'text-bambu-gray',
  };
  return (
    <span className={colours[status]}>
      {t(`pipelineRuns.jobStatus.${status}`, status)}
    </span>
  );
}
