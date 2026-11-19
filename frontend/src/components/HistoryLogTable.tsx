import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Download, ExternalLink, Loader2, Pencil, Printer, Star, Trash2, X } from 'lucide-react';
import { api } from '../api/client';
import type { Archive, PrintLogEntry } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { formatDateTime, formatDuration, type TimeFormat } from '../utils/date';
import { isSlicedFile } from '../utils/historyFilters';
import { Button } from './Button';
import { Card } from './Card';
import { ReactSelect } from './ToolbarControls';

interface HistoryLogTableProps {
  rows: PrintLogEntry[];
  isLoading: boolean;
  /** Rows matching the filters, across all pages. */
  total: number;
  offset: number;
  pageSize: number;
  onOffsetChange: (offset: number) => void;
  onPageSizeChange: (size: number) => void;
  /** The archive behind each entry, by id, for the row actions and selection. */
  archiveById: Map<number, Archive>;
  selectionMode: boolean;
  selectedIds: Set<number>;
  onToggleSelect: (archiveId: number) => void;
  timeFormat: TimeFormat;
  currency: string;
  hasActiveFilters: boolean;
  onResetFilters: () => void;
  onReprint: (archive: Archive) => void;
  onToggleFavourite: (archiveId: number) => void;
  onDownload: (archive: Archive) => void;
  onShowInGrid: (archiveId: number) => void;
  onEdit: (entry: PrintLogEntry) => void;
  onDelete: (entryId: number) => void;
  /** Row mutations in flight, to disable their buttons. */
  busy: { editing: boolean; deleting: boolean };
}

/** The print log: one row per print, with the actions that apply to the archive it came from. */
export function HistoryLogTable({
  rows, isLoading, total, offset, pageSize, onOffsetChange, onPageSizeChange, archiveById, selectionMode,
  selectedIds, onToggleSelect, timeFormat, currency, hasActiveFilters, onResetFilters, onReprint,
  onToggleFavourite, onDownload, onShowInGrid, onEdit, onDelete, busy,
}: HistoryLogTableProps) {
  const { t } = useTranslation();
  const { hasPermission, canModify } = useAuth();

  return (
    <Card>
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-bambu-green" />
        </div>
      ) : !rows.length ? (
        <div className="text-center py-12 text-bambu-gray">
          <p>{t('archives.log.noEntries')}</p>
          {hasActiveFilters && (
            <Button variant="ghost" size="sm" className="mt-3" onClick={onResetFilters}>
              <X className="w-4 h-4" />
              {t('archives.resetFilters')}
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-bambu-dark-tertiary text-bambu-gray text-left">
                  {selectionMode && <th className="px-4 py-3 w-8" />}
                  <th className="px-4 py-3 font-medium">{t('archives.log.date')}</th>
                  <th className="px-4 py-3 font-medium">{t('archives.log.printName')}</th>
                  <th className="px-4 py-3 font-medium">{t('archives.log.printer')}</th>
                  <th className="px-4 py-3 font-medium">{t('archives.log.user')}</th>
                  <th className="px-4 py-3 font-medium">{t('archives.log.status')}</th>
                  <th className="px-4 py-3 font-medium">{t('archives.log.duration')}</th>
                  <th className="px-4 py-3 font-medium">{t('archives.log.filament')}</th>
                  <th className="px-4 py-3 font-medium">{t('archives.log.cost')}</th>
                  <th className="px-4 py-3 font-medium w-10" aria-label={t('common.actions')} />
                </tr>
              </thead>
              <tbody className="divide-y divide-bambu-dark-tertiary">
                {rows.map((entry) => {
                  const linked = entry.archive_id != null ? archiveById.get(entry.archive_id) : undefined;
                  return (
                  <tr key={entry.id} className="hover:bg-bambu-dark-secondary/50" data-archive-id={entry.archive_id ?? undefined}>
                    {selectionMode && (
                      <td className="px-4 py-3 w-8">
                        {linked && (
                          <input
                            type="checkbox"
                            aria-label={t('archives.log.selectRow')}
                            checked={selectedIds.has(linked.id)}
                            onChange={() => onToggleSelect(linked.id)}
                          />
                        )}
                      </td>
                    )}
                    <td className="px-4 py-3 text-white whitespace-nowrap">
                      {formatDateTime(entry.started_at || entry.created_at, timeFormat)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {entry.thumbnail_path && (
                          <img
                            src={api.getPrintLogThumbnail(entry.id)}
                            alt=""
                            className="w-8 h-8 rounded object-cover flex-shrink-0"
                            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                          />
                        )}
                        <span className="text-white break-words" title={entry.print_name || ''}>
                          {entry.print_name || '—'}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-bambu-gray-light">{entry.printer_name || '—'}</td>
                    <td className="px-4 py-3 text-bambu-gray-light">{entry.created_by_username || '—'}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                        entry.status === 'completed' ? 'bg-green-500/20 text-green-400' :
                        entry.status === 'failed' ? 'bg-red-500/20 text-red-400' :
                        entry.status === 'stopped' ? 'bg-yellow-500/20 text-yellow-400' :
                        entry.status === 'cancelled' ? 'bg-orange-500/20 text-orange-400' :
                        entry.status === 'skipped' ? 'bg-blue-500/20 text-blue-400' :
                        'bg-gray-500/20 text-gray-400'
                      }`}>
                        {entry.status}
                      </span>
                      {entry.failure_reason && (
                        <span className="block text-[10px] text-bambu-gray mt-0.5">
                          {t(`editArchive.failureReasons.${entry.failure_reason}`, { defaultValue: entry.failure_reason })}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-bambu-gray-light whitespace-nowrap">
                      {entry.duration_seconds ? formatDuration(entry.duration_seconds) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        {entry.filament_color && (
                          <div className="flex items-center gap-0.5 flex-wrap">
                            {entry.filament_color.split(',').map((color, i) => {
                              const trimmed = color.trim();
                              return (
                                <span
                                  key={i}
                                  className="w-3 h-3 rounded-full border border-black/20 flex-shrink-0"
                                  style={{ backgroundColor: trimmed.startsWith('#') ? trimmed : undefined }}
                                  title={trimmed}
                                />
                              );
                            })}
                          </div>
                        )}
                        <span className="text-bambu-gray-light text-xs">
                          {entry.filament_type || '—'}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-bambu-gray-light whitespace-nowrap">
                      {entry.cost != null ? `${currency}${entry.cost.toFixed(2)}` : '—'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-2">
                        {linked && (
                          <>
                            {isSlicedFile(linked) && (
                              <button
                                type="button"
                                onClick={() => onReprint(linked)}
                                disabled={!linked.file_path || !hasPermission('queue:create') || !canModify('archives', 'reprint', linked.created_by_id)}
                                title={t('archives.menu.print')}
                                aria-label={t('archives.menu.print')}
                                className="text-bambu-gray hover:text-bambu-green disabled:opacity-40 disabled:hover:text-bambu-gray transition-colors"
                              >
                                <Printer className="w-4 h-4" />
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => onToggleFavourite(linked.id)}
                              disabled={!canModify('archives', 'update', linked.created_by_id)}
                              title={
                                !canModify('archives', 'update', linked.created_by_id)
                                  ? t('archives.permission.noUpdateArchives')
                                  : linked.is_favorite ? t('archives.menu.removeFromFavorites') : t('archives.menu.addToFavorites')
                              }
                              aria-label={linked.is_favorite ? t('archives.menu.removeFromFavorites') : t('archives.menu.addToFavorites')}
                              className="text-bambu-gray hover:text-yellow-400 disabled:opacity-40 disabled:hover:text-bambu-gray transition-colors"
                            >
                              <Star className={`w-4 h-4 ${linked.is_favorite ? 'fill-yellow-400 text-yellow-400' : ''}`} />
                            </button>
                            <button
                              type="button"
                              onClick={() => onDownload(linked)}
                              disabled={!linked.file_path}
                              title={t('archives.menu.download')}
                              aria-label={t('archives.menu.download')}
                              className="text-bambu-gray hover:text-white disabled:opacity-40 transition-colors"
                            >
                              <Download className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => onShowInGrid(linked.id)}
                              title={t('archives.log.openInGrid')}
                              aria-label={t('archives.log.openInGrid')}
                              className="text-bambu-gray hover:text-white transition-colors"
                            >
                              <ExternalLink className="w-4 h-4" />
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          onClick={() => onEdit(entry)}
                          disabled={
                            busy.editing ||
                            !(hasPermission('archives:update_all') || hasPermission('archives:update_own'))
                          }
                          title={
                            hasPermission('archives:update_all') || hasPermission('archives:update_own')
                              ? t('archives.log.editEntryTitle')
                              : t('archives.permission.noEdit')
                          }
                          className="text-bambu-gray hover:text-bambu-blue disabled:opacity-40 disabled:hover:text-bambu-gray transition-colors"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onDelete(entry.id)}
                          disabled={
                            busy.deleting ||
                            !(hasPermission('archives:delete_all') || hasPermission('archives:delete_own'))
                          }
                          title={
                            hasPermission('archives:delete_all') || hasPermission('archives:delete_own')
                              ? t('archives.log.deleteEntryTitle')
                              : t('archives.permission.noDelete')
                          }
                          className="text-bambu-gray hover:text-red-400 disabled:opacity-40 disabled:hover:text-bambu-gray transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {/* Pagination */}
          <div className="flex items-center justify-between px-4 py-3 border-t border-bambu-dark-tertiary flex-wrap gap-2">
            <div className="flex items-center gap-3">
              <span className="text-sm text-bambu-gray">
                {t('archives.log.showing', { count: Math.min(offset + pageSize, total), total: total })}
              </span>
              <div className="flex items-center gap-1.5">
                <label className="text-xs text-bambu-gray">{t('archives.log.rowsPerPage')}</label>
                <ReactSelect
                  className="px-2 py-1 bg-bambu-dark border border-bambu-dark-tertiary rounded text-white text-xs focus:border-bambu-green focus:outline-none"
                  value={pageSize}
                  onChange={(e) => { onPageSizeChange(Number(e.target.value)); onOffsetChange(0); }}
                >
                  <option value={10}>10</option>
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </ReactSelect>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-bambu-gray">
                {t('archives.log.page')} {Math.floor(offset / pageSize) + 1} / {Math.max(1, Math.ceil(total / pageSize))}
              </span>
              <Button variant="secondary" size="sm" onClick={() => onOffsetChange(Math.max(0, offset - pageSize))} disabled={offset === 0}>
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <Button variant="secondary" size="sm" onClick={() => onOffsetChange(offset + pageSize)} disabled={offset + pageSize >= total}>
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}
