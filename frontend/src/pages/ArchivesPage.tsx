import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useHistoryFilters } from '../hooks/useHistoryFilters';
import { HistoryFilterBar } from '../components/HistoryFilterBar';
import { HistoryLogTable } from '../components/HistoryLogTable';
import {
  exportIgnoredFilters, filterAndSortArchives, filterLogEntries, getActiveFilterChips, getExportParams,
  getServerFilterBounds, isSlicedFile, needsClientLogFilter, type ViewMode,
} from '../utils/historyFilters';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Download,
  Trash2,
  Clock,
  Package,
  Coins,
  Layers,
  Image,
  Box,
  Printer,
  Upload,
  ExternalLink,
  CheckSquare,
  Square,
  X,
  Globe,
  Pencil,
  Star,
  Tag,
  StickyNote,
  FolderInput,
  Save,
  FolderOpen,
  AlertCircle,
  Copy,
  Film,
  ScanSearch,
  QrCode,
  Camera,
  FileText,
  FileCode,
  MoreVertical,
  FileSpreadsheet,
  GitCompare,
  GitBranch,
  Loader2,
  FolderKanban,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  User,
  Zap,
  Cog,
  History,
} from 'lucide-react';
import { api } from '../api/client';
import { SliceModal } from '../components/SliceModal';
import { SaveArchiveToFilesModal } from '../components/SaveArchiveToFilesModal';
import { openInSlicer, type SlicerType } from '../utils/slicer';
import { formatDateTime, getLastPrintedAt, type TimeFormat, formatDuration } from '../utils/date';
import { getCurrencySymbol } from '../utils/currency';
import { getBedTypeInfo } from '../utils/bedType';
import type { Archive, PrintLogEntry, ProjectListItem } from '../api/client';
import { Card, CardContent } from '../components/Card';
import { Button } from '../components/Button';
import { ReactSelect } from '../components/ToolbarControls';
import { PrintModal } from '../components/PrintModal';
import { PurgeArchivesModal } from '../components/PurgeArchivesModal';
import { ConfirmModal } from '../components/ConfirmModal';
import { EditArchiveModal, FAILURE_REASON_KEYS } from '../components/EditArchiveModal';
import { PrintLogModal } from '../components/PrintLogModal';
import { ContextMenu, type ContextMenuItem } from '../components/ContextMenu';
import { BatchTagModal } from '../components/BatchTagModal';
import { BatchProjectModal } from '../components/BatchProjectModal';
import { CalendarView } from '../components/CalendarView';
import { QRCodeModal } from '../components/QRCodeModal';
import { PhotoGalleryModal } from '../components/PhotoGalleryModal';
import { ProjectPageModal } from '../components/ProjectPageModal';
import { TimelapseViewer } from '../components/TimelapseViewer';
import { CompareArchivesModal } from '../components/CompareArchivesModal';
import { PendingUploadsPanel } from '../components/PendingUploadsPanel';
import { TagManagementModal } from '../components/TagManagementModal';
import { PlatePickerModal } from '../components/PlatePickerModal';
import type { PlateMetadata } from '../types/plates';
import { useToast } from '../contexts/ToastContext';
import { useAuth } from '../contexts/AuthContext';
import { formatFileSize } from '../utils/file';

type TFunction = (key: string, options?: Record<string, unknown>) => string;

// formatDate imported from '../utils/date' - handles UTC conversion

/**
 * Open an archive file in the slicer.
 * Fetches a short-lived download token, then builds a token-authenticated URL
 * that bypasses auth middleware (slicer protocol handlers can't send auth headers).
 */
async function openInSlicerWithToken(
  archiveId: number,
  filename: string,
  resourceType: 'file' | 'source',
  slicer: SlicerType,
): Promise<void> {
  try {
    if (resourceType === 'source') {
      const { token } = await api.createSourceSlicerToken(archiveId);
      const path = api.getSourceSlicerDownloadUrl(archiveId, token, filename);
      openInSlicer(`${window.location.origin}${path}`, slicer);
    } else {
      const { token } = await api.createArchiveSlicerToken(archiveId);
      const path = api.getArchiveSlicerDownloadUrl(archiveId, token, filename);
      openInSlicer(`${window.location.origin}${path}`, slicer);
    }
  } catch {
    // Fallback to direct URL (works when auth is disabled)
    const path = resourceType === 'source'
      ? api.getSource3mfForSlicer(archiveId, filename)
      : api.getArchiveForSlicer(archiveId, filename);
    openInSlicer(`${window.location.origin}${path}`, slicer);
  }
}

function ArchiveCard({
  archive,
  printerName,
  isSelected,
  onSelect,
  selectionMode,
  projects,
  isHighlighted,
  timeFormat = 'system',
  preferredSlicer = 'bambu_studio',
  useSlicerApi = false,
  currency,
  t,
  onNavigateToArchive,
}: {
  archive: Archive;
  printerName: string;
  isSelected: boolean;
  onSelect: (id: number) => void;
  selectionMode: boolean;
  projects: ProjectListItem[] | undefined;
  isHighlighted?: boolean;
  timeFormat?: TimeFormat;
  preferredSlicer?: SlicerType;
  useSlicerApi?: boolean;
  currency: string;
  t: TFunction;
  onNavigateToArchive?: (archiveId: number) => void;
}) {
  // Debug: log when card is highlighted
  if (isHighlighted) {
    console.log('ArchiveCard isHighlighted=true for archive:', archive.id);
  }

  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { hasPermission, canModify, user } = useAuth();
  const canDownload = hasPermission('archives:read_all')
    || (hasPermission('archives:read_own') && user != null && archive.created_by_id === user.id);
  const navigate = useNavigate();
  const [showReprint, setShowReprint] = useState(false);
  const [showSliceModal, setShowSliceModal] = useState(false);
  const [showSaveToFiles, setShowSaveToFiles] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // #1343: when true, the delete also drops the row from Quick Stats. Default
  // off — soft delete preserves the archive's filament/time/cost contribution.
  const [deletePurgeStats, setDeletePurgeStats] = useState(false);
  // #1734: pre-flight count of related queue items so the confirm modal can
  // tell the user how many will be removed and disable the button if any are
  // currently printing (the server 409s in that case).
  const deleteImpactQuery = useQuery({
    queryKey: ['archive', archive.id, 'delete-impact'],
    queryFn: () => api.getArchiveDeleteImpact(archive.id),
    enabled: showDeleteConfirm,
    staleTime: 0,
  });
  const [showEdit, setShowEdit] = useState(false);
  const [showPrintLog, setShowPrintLog] = useState(false);
  const [showTimelapse, setShowTimelapse] = useState(false);
  const [showTimelapseSelect, setShowTimelapseSelect] = useState(false);
  const [availableTimelapses, setAvailableTimelapses] = useState<Array<{ name: string; path: string; size: number; mtime: string | null }>>([]);
  const [showQRCode, setShowQRCode] = useState(false);
  const [showPhotos, setShowPhotos] = useState(false);
  const [showProjectPage, setShowProjectPage] = useState(false);
  const [showDeleteSource3mfConfirm, setShowDeleteSource3mfConfirm] = useState(false);
  const [showDeleteF3dConfirm, setShowDeleteF3dConfirm] = useState(false);
  const [showDeleteTimelapseConfirm, setShowDeleteTimelapseConfirm] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const [currentPlateIndex, setCurrentPlateIndex] = useState<number | null>(null);
  const [showPlateNav, setShowPlateNav] = useState(false);
  const [platePickerPlates, setPlatePickerPlates] = useState<PlateMetadata[] | null>(null);
  const source3mfInputRef = useRef<HTMLInputElement>(null);
  const f3dInputRef = useRef<HTMLInputElement>(null);
  const timelapseInputRef = useRef<HTMLInputElement>(null);

  // Fetch plates data for multi-plate browsing (lazy - only when hovering)
  const { data: platesData } = useQuery({
    queryKey: ['archive-plates', archive.id],
    queryFn: () => api.getArchivePlates(archive.id),
    enabled: showPlateNav, // Only fetch when user hovers to see navigation
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  });

  // Use pre-computed duplicate sequence and original archive ID from list response
  const duplicateSequence = archive.duplicate_sequence ?? 0;
  const originalArchiveId = archive.original_archive_id ?? null;

  const plates = platesData?.plates ?? [];
  const isMultiPlate = platesData?.is_multi_plate ?? false;
  const displayPlateIndex = currentPlateIndex ?? 0;

  // 3D Preview click handler. Multi-plate archives show the plate picker
  // first; single-plate archives navigate straight into the viewer. Source-
  // only archives (no sliced gcode, e.g. pure project 3MFs from BambuStudio
  // that carry only plate PNG/JSON metadata) get a toast — there's nothing
  // the gcode viewer can render for them.
  const openGcodeViewer = async () => {
    try {
      const resp = await api.getArchivePlates(archive.id);
      if (resp.has_gcode === false) {
        showToast(t('archives.platePicker.noGcode'), 'info');
        return;
      }
      if (resp.is_multi_plate && resp.plates.length > 1) {
        setPlatePickerPlates(resp.plates);
        return;
      }
    } catch {
      // Swallow — fall through to the no-plate navigate below so the viewer
      // still opens on the first plate (the backend's default).
    }
    navigate(`/gcode-viewer?archive=${archive.id}`);
  };

  const timelapseDeleteMutation = useMutation({
    mutationFn: () => api.deleteArchiveTimelapse(archive.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['archives'] });
      showToast(t('archives.toast.timelapseRemoved'));
    },
    onError: (error: Error) => {
      showToast(error.message || t('archives.toast.failedRemoveTimelapse'), 'error');
    },
  });

  const timelapseUploadMutation = useMutation({
    mutationFn: (file: File) => api.uploadArchiveTimelapse(archive.id, file),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['archives'] });
      showToast(t('archives.toast.timelapseUploaded', { filename: data.filename }));
    },
    onError: (error: Error) => {
      showToast(error.message || t('archives.toast.failedUploadTimelapse'), 'error');
    },
  });

  const source3mfUploadMutation = useMutation({
    mutationFn: (file: File) => api.uploadSource3mf(archive.id, file),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['archives'] });
      showToast(t('archives.toast.source3mfAttached', { filename: data.filename }));
    },
    onError: (error: Error) => {
      showToast(error.message || t('archives.toast.failedUploadSource3mf'), 'error');
    },
  });

  const source3mfDeleteMutation = useMutation({
    mutationFn: () => api.deleteSource3mf(archive.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['archives'] });
      showToast(t('archives.toast.source3mfRemoved'));
    },
    onError: (error: Error) => {
      showToast(error.message || t('archives.toast.failedRemoveSource3mf'), 'error');
    },
  });

  const f3dUploadMutation = useMutation({
    mutationFn: (file: File) => api.uploadF3d(archive.id, file),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['archives'] });
      showToast(t('archives.toast.f3dAttached', { filename: data.filename }));
    },
    onError: (error: Error) => {
      showToast(error.message || t('archives.toast.failedUploadF3d'), 'error');
    },
  });

  const f3dDeleteMutation = useMutation({
    mutationFn: () => api.deleteF3d(archive.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['archives'] });
      showToast(t('archives.toast.f3dRemoved'));
    },
    onError: (error: Error) => {
      showToast(error.message || t('archives.toast.failedRemoveF3d'), 'error');
    },
  });

  const timelapseScanMutation = useMutation({
    mutationFn: () => api.scanArchiveTimelapse(archive.id),
    onSuccess: (data) => {
      if (data.status === 'attached') {
        queryClient.invalidateQueries({ queryKey: ['archives'] });
        showToast(t('archives.toast.timelapseAttached', { filename: data.filename }));
      } else if (data.status === 'exists') {
        showToast(t('archives.toast.timelapseAlreadyAttached'));
      } else if (data.status === 'not_found' && data.available_files && data.available_files.length > 0) {
        // Show selection dialog
        setAvailableTimelapses(data.available_files);
        setShowTimelapseSelect(true);
      } else {
        showToast(data.message || t('archives.toast.noMatchingTimelapse'), 'warning');
      }
    },
    onError: (error: Error) => {
      showToast(error.message || t('archives.toast.failedScanTimelapse'), 'error');
    },
  });

  const timelapseSelectMutation = useMutation({
    mutationFn: (filename: string) => api.selectArchiveTimelapse(archive.id, filename),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['archives'] });
      showToast(t('archives.toast.timelapseAttached', { filename: data.filename }));
      setShowTimelapseSelect(false);
      setAvailableTimelapses([]);
    },
    onError: (error: Error) => {
      showToast(error.message || t('archives.toast.failedAttachTimelapse'), 'error');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (purgeStats: boolean) => api.deleteArchive(archive.id, purgeStats),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['archives'] });
      showToast(t('archives.toast.archiveDeleted'));
    },
    onError: () => {
      showToast(t('archives.toast.failedDeleteArchive'), 'error');
    },
  });

  const favoriteMutation = useMutation({
    mutationFn: () => api.toggleFavorite(archive.id),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['archives'] });
      showToast(data.is_favorite ? t('archives.toast.addedToFavorites') : t('archives.toast.removedFromFavorites'));
    },
  });

  // Query for linked folders
  const { data: linkedFolders } = useQuery({
    queryKey: ['archive-folders', archive.id],
    queryFn: () => api.getLibraryFoldersByArchive(archive.id),
  });

  const assignProjectMutation = useMutation({
    mutationFn: (projectId: number | null) => api.updateArchive(archive.id, { project_id: projectId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['archives'] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      showToast(t('archives.toast.projectUpdated'));
    },
    onError: () => {
      showToast(t('archives.toast.failedUpdateProject'), 'error');
    },
  });

  const isGcodeFile = isSlicedFile(archive);

  const contextMenuItems: ContextMenuItem[] = [
    // For gcode files: show Print option
    // For source files: show Slice as the primary action
    ...(isGcodeFile ? [
      {
        label: t('archives.menu.print'),
        icon: <Printer className="w-4 h-4" />,
        onClick: () => setShowReprint(true),
        disabled: !archive.file_path || !hasPermission('queue:create') || !canModify('archives', 'reprint', archive.created_by_id),
        title: !archive.file_path
          ? t('archives.card.noFileForReprint')
          : !hasPermission('queue:create')
            ? t('archives.permission.noAddToQueue')
            : !canModify('archives', 'reprint', archive.created_by_id)
              ? t('archives.permission.noReprint')
              : undefined,
      },
    ] : [
      {
        label: t('archives.menu.slice'),
        icon: useSlicerApi ? <Cog className="w-4 h-4" /> : <ExternalLink className="w-4 h-4" />,
        onClick: () => {
          if (useSlicerApi) {
            setShowSliceModal(true);
          } else {
            const filename = archive.print_name || archive.filename || 'model';
            openInSlicerWithToken(archive.id, filename, 'file', preferredSlicer);
          }
        },
      },
    ]),
    ...(isGcodeFile || useSlicerApi ? [
      {
        label: t('archives.menu.openInBambuStudio'),
        icon: <ExternalLink className="w-4 h-4" />,
        onClick: () => {
          const filename = archive.print_name || archive.filename || 'model';
          openInSlicerWithToken(archive.id, filename, 'file', preferredSlicer);
        },
        disabled: !archive.file_path,
        title: !archive.file_path ? t('archives.card.noFileForReprint') : undefined,
      },
    ] : []),
    {
      label: archive.external_url ? t('archives.menu.externalLink') : t('archives.menu.viewOnMakerWorld'),
      icon: <Globe className="w-4 h-4" />,
      onClick: () => {
        const url = archive.external_url || archive.makerworld_url;
        if (url) window.open(url, '_blank');
      },
      disabled: !archive.external_url && !archive.makerworld_url,
    },
    { label: '', divider: true, onClick: () => {} },
    {
      label: t('archives.menu.preview3d'),
      icon: <Box className="w-4 h-4" />,
      onClick: () => { openGcodeViewer(); },
    },
    {
      label: t('archives.menu.viewTimelapse'),
      icon: <Film className="w-4 h-4" />,
      onClick: () => setShowTimelapse(true),
      disabled: !archive.timelapse_path,
    },
    {
      label: t('archives.menu.scanForTimelapse'),
      icon: <ScanSearch className="w-4 h-4" />,
      onClick: () => timelapseScanMutation.mutate(),
      disabled: !archive.printer_id || !!archive.timelapse_path || timelapseScanMutation.isPending || !canModify('archives', 'update', archive.created_by_id),
      title: !canModify('archives', 'update', archive.created_by_id) ? t('archives.permission.noUpdateArchives') : undefined,
    },
    {
      label: t('archives.menu.uploadTimelapse'),
      icon: <Upload className="w-4 h-4" />,
      onClick: () => timelapseInputRef.current?.click(),
      disabled: !!archive.timelapse_path || !canModify('archives', 'update', archive.created_by_id),
      title: !canModify('archives', 'update', archive.created_by_id) ? t('archives.permission.noUpdateArchives') : undefined,
    },
    ...(archive.timelapse_path ? [{
      label: t('archives.menu.removeTimelapse'),
      icon: <Trash2 className="w-4 h-4" />,
      onClick: () => setShowDeleteTimelapseConfirm(true),
      danger: true,
      disabled: !canModify('archives', 'update', archive.created_by_id),
      title: !canModify('archives', 'update', archive.created_by_id) ? t('archives.permission.noUpdateArchives') : undefined,
    }] : []),
    { label: '', divider: true, onClick: () => {} },
    ...(archive.source_3mf_path ? [{
      label: t('archives.card.openSource3mf'),
      icon: <FileCode className="w-4 h-4" />,
      onClick: () => {
        const sourceName = (archive.print_name || archive.filename || 'source').replace(/\.gcode\.3mf$/i, '') + '_source';
        openInSlicerWithToken(archive.id, sourceName, 'source', preferredSlicer);
      },
    }] : []),
    {
      label: archive.source_3mf_path ? t('archives.menu.downloadSource3mf') : t('archives.menu.uploadSource3mf'),
      icon: <FileCode className="w-4 h-4" />,
      onClick: () => {
        if (archive.source_3mf_path) {
          api.downloadSource3mf(archive.id).catch((err) => {
            console.error('Source 3MF download failed:', err);
          });
        } else {
          source3mfInputRef.current?.click();
        }
      },
      disabled: !archive.source_3mf_path && !canModify('archives', 'update', archive.created_by_id),
      title: !archive.source_3mf_path && !canModify('archives', 'update', archive.created_by_id) ? t('archives.permission.noUploadFiles') : undefined,
    },
    ...(archive.source_3mf_path ? [{
      label: t('archives.menu.replaceSource3mf'),
      icon: <Upload className="w-4 h-4" />,
      onClick: () => source3mfInputRef.current?.click(),
      disabled: !canModify('archives', 'update', archive.created_by_id),
      title: !canModify('archives', 'update', archive.created_by_id) ? t('archives.permission.noUpdateArchives') : undefined,
    },
    {
      label: t('archives.menu.removeSource3mf'),
      icon: <Trash2 className="w-4 h-4" />,
      onClick: () => setShowDeleteSource3mfConfirm(true),
      danger: true,
      disabled: !canModify('archives', 'update', archive.created_by_id),
      title: !canModify('archives', 'update', archive.created_by_id) ? t('archives.permission.noUpdateArchives') : undefined,
    }] : []),
    {
      label: archive.f3d_path ? t('archives.menu.replaceF3d') : t('archives.menu.uploadF3d'),
      icon: <Box className="w-4 h-4" />,
      onClick: () => f3dInputRef.current?.click(),
      disabled: !canModify('archives', 'update', archive.created_by_id),
      title: !canModify('archives', 'update', archive.created_by_id) ? t('archives.permission.noUpdateArchives') : undefined,
    },
    ...(archive.f3d_path ? [{
      label: t('archives.menu.downloadF3d'),
      icon: <Download className="w-4 h-4" />,
      onClick: () => {
        api.downloadF3d(archive.id).catch((err) => {
          console.error('F3D download failed:', err);
        });
      },
    },
    {
      label: t('archives.menu.removeF3d'),
      icon: <Trash2 className="w-4 h-4" />,
      onClick: () => setShowDeleteF3dConfirm(true),
      danger: true,
      disabled: !canModify('archives', 'update', archive.created_by_id),
      title: !canModify('archives', 'update', archive.created_by_id) ? t('archives.permission.noUpdateArchives') : undefined,
    }] : []),
    { label: '', divider: true, onClick: () => {} },
    // Entries without a 3MF (fallback rows for prints started outside Grove) have nothing to copy.
    ...(archive.file_path ? [{
      label: t('archives.menu.saveToFiles'),
      icon: <FolderInput className="w-4 h-4" />,
      onClick: () => setShowSaveToFiles(true),
      disabled: !hasPermission('library:upload'),
      title: !hasPermission('library:upload') ? t('archives.permission.noSaveToFiles') : undefined,
    }] : []),
    {
      label: t('archives.menu.download'),
      icon: <Download className="w-4 h-4" />,
      onClick: () => {
        api.downloadArchive(archive.id, `${archive.print_name || archive.filename}.3mf`).catch((err) => {
          console.error('Archive download failed:', err);
        });
      },
      disabled: !canDownload,
      title: !canDownload ? t('archives.permission.noDownload') : undefined,
    },
    {
      label: t('archives.menu.copyDownloadLink'),
      icon: <Copy className="w-4 h-4" />,
      onClick: () => {
        const url = `${window.location.origin}${api.getArchiveDownload(archive.id)}`;
        navigator.clipboard.writeText(url).then(() => {
          showToast(t('archives.toast.linkCopied'));
        }).catch(() => {
          showToast(t('archives.toast.failedCopyLink'), 'error');
        });
      },
      disabled: !canDownload,
      title: !canDownload ? t('archives.permission.noCopyLink') : undefined,
    },
    {
      label: t('archives.menu.qrCode'),
      icon: <QrCode className="w-4 h-4" />,
      onClick: () => setShowQRCode(true),
    },
    {
      label: archive.photos?.length ? t('archives.menu.viewPhotosCount', { count: archive.photos.length }) : t('archives.menu.viewPhotos'),
      icon: <Camera className="w-4 h-4" />,
      onClick: () => setShowPhotos(true),
      disabled: !archive.photos?.length,
    },
    {
      label: t('archives.menu.projectPage'),
      icon: <FileText className="w-4 h-4" />,
      onClick: () => setShowProjectPage(true),
    },
    { label: '', divider: true, onClick: () => {} },
    {
      label: archive.is_favorite ? t('archives.menu.removeFromFavorites') : t('archives.menu.addToFavorites'),
      icon: <Star className={`w-4 h-4 ${archive.is_favorite ? 'fill-yellow-400 text-yellow-400' : ''}`} />,
      onClick: () => favoriteMutation.mutate(),
      disabled: !canModify('archives', 'update', archive.created_by_id),
      title: !canModify('archives', 'update', archive.created_by_id) ? t('archives.permission.noUpdateArchives') : undefined,
    },
    {
      label: t('archives.menu.edit'),
      icon: <Pencil className="w-4 h-4" />,
      onClick: () => setShowEdit(true),
      disabled: !canModify('archives', 'update', archive.created_by_id),
      title: !canModify('archives', 'update', archive.created_by_id) ? t('archives.permission.noUpdateArchives') : undefined,
    },
    {
      label: t('archives.menu.printLog'),
      icon: <History className="w-4 h-4" />,
      onClick: () => setShowPrintLog(true),
    },
    ...(archive.project_id && archive.project_name ? [{
      label: t('archives.menu.goToProject', { name: archive.project_name }),
      icon: <FolderKanban className="w-4 h-4 text-bambu-green" />,
      onClick: () => window.location.href = '/projects',
    }] : []),
    {
      label: t('archives.menu.addToProject'),
      icon: <FolderKanban className="w-4 h-4" />,
      onClick: () => {},
      disabled: !canModify('archives', 'update', archive.created_by_id),
      title: !canModify('archives', 'update', archive.created_by_id) ? t('archives.permission.noUpdateArchives') : undefined,
      submenuSearchPlaceholder: (projects?.filter(p => p.status === 'active').length ?? 0) > 5
        ? t('archives.menu.searchProjects')
        : undefined,
      submenu: (() => {
        const items: ContextMenuItem[] = [];

        // Add "Remove from Project" if archive is in a project
        if (archive.project_id) {
          items.push({
            label: t('archives.menu.removeFromProject'),
            icon: <X className="w-4 h-4" />,
            onClick: () => assignProjectMutation.mutate(null),
            disabled: !canModify('archives', 'update', archive.created_by_id),
          });
        }

        // Add project options
        if (!projects) {
          items.push({
            label: t('archives.menu.loading'),
            icon: <Loader2 className="w-4 h-4 animate-spin" />,
            onClick: () => {},
            disabled: true,
          });
        } else {
          const activeProjects = projects
            .filter(p => p.status === 'active')
            .sort((a, b) => a.name.localeCompare(b.name));
          if (activeProjects.length === 0) {
            items.push({
              label: t('archives.menu.noProjectsAvailable'),
              icon: <FolderKanban className="w-4 h-4 opacity-50" />,
              onClick: () => {},
              disabled: true,
            });
          } else {
            activeProjects.forEach(p => {
              items.push({
                label: p.name,
                icon: <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: p.color || '#888' }} />,
                onClick: () => assignProjectMutation.mutate(p.id),
                disabled: archive.project_id === p.id || !canModify('archives', 'update', archive.created_by_id),
              });
            });
          }
        }

        return items;
      })(),
    },
    {
      label: isSelected ? t('archives.menu.deselect') : t('archives.menu.select'),
      icon: isSelected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />,
      onClick: () => onSelect(archive.id),
    },
    { label: '', divider: true, onClick: () => {} },
    {
      label: t('archives.menu.delete'),
      icon: <Trash2 className="w-4 h-4" />,
      onClick: () => setShowDeleteConfirm(true),
      danger: true,
      disabled: !canModify('archives', 'delete', archive.created_by_id),
      title: !canModify('archives', 'delete', archive.created_by_id) ? t('archives.permission.noDelete') : undefined,
    },
  ];

  return (
    <Card
      data-archive-id={archive.id}
      className={`relative flex flex-col group ${isSelected ? 'ring-2 ring-bambu-green' : ''} ${selectionMode ? 'cursor-pointer' : ''}`}
      style={isHighlighted ? { outline: '4px solid #facc15', outlineOffset: '2px' } : undefined}
      onClick={selectionMode ? () => onSelect(archive.id) : undefined}
    >
      {/* Selection checkbox */}
      {selectionMode && (
        <button
          className="absolute top-2 left-2 z-10 p-1 rounded bg-black/50 hover:bg-black/70 transition-colors"
          onClick={(e) => { e.stopPropagation(); onSelect(archive.id); }}
        >
          {isSelected ? (
            <CheckSquare className="w-5 h-5 text-bambu-green" />
          ) : (
            <Square className="w-5 h-5 text-white" />
          )}
        </button>
      )}

      {/* Thumbnail with plate navigation */}
      <div
        className="aspect-video bg-bambu-dark relative flex-shrink-0 overflow-hidden rounded-t-xl"
        onMouseEnter={() => setShowPlateNav(true)}
        onMouseLeave={() => setShowPlateNav(false)}
      >
        {archive.thumbnail_path ? (
          <img
            src={
              currentPlateIndex !== null && plates.length > 0
                ? api.getArchivePlateThumbnail(archive.id, plates[displayPlateIndex]?.index ?? 0)
                : api.getArchiveThumbnail(archive.id)
            }
            alt={archive.print_name || archive.filename}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Image className="w-12 h-12 text-bambu-dark-tertiary" />
          </div>
        )}
        {/* Plate navigation - only show for multi-plate archives */}
        {isMultiPlate && plates.length > 1 && (
          <>
            {/* Left arrow */}
            <button
              className="absolute left-1 top-1/2 -translate-y-1/2 p-1 rounded-full bg-black/60 hover:bg-black/80 transition-all can-hover:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                setCurrentPlateIndex((prev) => {
                  const current = prev ?? 0;
                  return current > 0 ? current - 1 : plates.length - 1;
                });
              }}
              title={t('archives.card.previousPlate')}
            >
              <ChevronLeft className="w-4 h-4 text-white" />
            </button>
            {/* Right arrow */}
            <button
              className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded-full bg-black/60 hover:bg-black/80 transition-all can-hover:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                setCurrentPlateIndex((prev) => {
                  const current = prev ?? 0;
                  return current < plates.length - 1 ? current + 1 : 0;
                });
              }}
              title={t('archives.card.nextPlate')}
            >
              <ChevronRight className="w-4 h-4 text-white" />
            </button>
            {/* Dots indicator */}
            <div
              className="absolute bottom-1 left-1/2 -translate-x-1/2 flex gap-1 px-2 py-1 rounded-full bg-black/50 transition-all can-hover:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
            >
              {plates.map((plate, idx) => (
                <button
                  key={plate.index}
                  className={`w-2 h-2 rounded-full transition-colors ${
                    idx === displayPlateIndex ? 'bg-bambu-green' : 'bg-white/50 hover:bg-white/80'
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setCurrentPlateIndex(idx);
                  }}
                  title={plate.name || t('archives.card.plateNumber', { index: plate.index })}
                />
              ))}
            </div>
          </>
        )}
        {/* Context menu button - always available without a hover-capable pointer */}
        <button
          className={`absolute top-2 left-2 p-1.5 rounded bg-black/50 hover:bg-black/70 transition-all ${selectionMode ? 'left-10' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            setContextMenu({ x: rect.left, y: rect.bottom + 4 });
          }}
          ref={menuTriggerRef}
          aria-label={t('archives.card.moreOptions')}
          aria-haspopup="menu"
          aria-expanded={contextMenu !== null}
          title={t('archives.card.moreOptions')}
        >
          <MoreVertical className="w-5 h-5 text-white" />
        </button>
        {/* Favorite star */}
        <button
          className={`absolute top-2 right-2 p-1 rounded transition-colors ${
            canModify('archives', 'update', archive.created_by_id)
              ? 'bg-black/50 hover:bg-black/70'
              : 'bg-black/30 cursor-not-allowed'
          }`}
          onClick={(e) => {
            e.stopPropagation();
            if (canModify('archives', 'update', archive.created_by_id)) {
              favoriteMutation.mutate();
            }
          }}
          disabled={!canModify('archives', 'update', archive.created_by_id)}
          title={!canModify('archives', 'update', archive.created_by_id) ? t('archives.permission.noUpdateArchives') : (archive.is_favorite ? t('archives.card.removeFromFavorites') : t('archives.card.addToFavorites'))}
        >
          <Star
            className={`w-5 h-5 ${archive.is_favorite ? 'text-yellow-400 fill-yellow-400' : 'text-white'} ${!canModify('archives', 'update', archive.created_by_id) ? 'opacity-50' : ''}`}
          />
        </button>
        {(archive.status === 'failed' || archive.status === 'aborted') && (
          <div className="absolute top-2 left-12 px-2 py-1 rounded text-xs bg-status-error/80 text-white">
            {archive.status === 'aborted' ? t('archives.card.cancelled') : t('archives.card.failed')}
          </div>
        )}
        {/* Duplicate badge */}
        {archive.duplicate_count > 0 && duplicateSequence > 0 && originalArchiveId && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onNavigateToArchive?.(originalArchiveId);
            }}
            className="absolute top-2 right-12 px-2 py-1 rounded text-xs bg-purple-500/80 hover:bg-purple-600/90 text-white flex items-center gap-1 transition-colors cursor-pointer"
            title={t('archives.viewOriginalPrint', { id: originalArchiveId })}
          >
            <Copy className="w-3 h-3" />
            #{duplicateSequence}
          </button>
        )}
        {archive.duplicate_count > 0 && duplicateSequence === 0 && (
          <span
            className="absolute top-2 right-12 px-2 py-1 rounded text-xs bg-purple-500/80 text-white flex items-center gap-1"
            title={`${archive.duplicate_count} reprint${archive.duplicate_count === 1 ? '' : 's'}`}
          >
            <GitBranch className="w-3 h-3" />
            +{archive.duplicate_count}
          </span>
        )}
        {/* 3D preview badge */}
        <button
          className="absolute bottom-2 right-2 p-1.5 rounded bg-black/60 hover:bg-black/80 transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            openGcodeViewer();
          }}
          title={t('archives.card.preview3d')}
        >
          <Layers className="w-4 h-4 text-white" />
        </button>
        {/* Timelapse badge */}
        {archive.timelapse_path && (
          <button
            className="absolute bottom-2 right-12 p-1.5 rounded bg-black/60 hover:bg-black/80 transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              setShowTimelapse(true);
            }}
            title={t('archives.card.viewTimelapse')}
          >
            <Film className="w-4 h-4 text-bambu-green" />
          </button>
        )}
        {/* Photos badge */}
        {archive.photos && archive.photos.length > 0 && (
          <button
            className={`absolute bottom-2 ${archive.timelapse_path ? 'right-[5.5rem]' : 'right-12'} p-1.5 rounded bg-black/60 hover:bg-black/80 transition-colors`}
            onClick={(e) => {
              e.stopPropagation();
              setShowPhotos(true);
            }}
            title={archive.photos.length === 1 ? t('archives.card.viewPhoto') : t('archives.card.viewPhotos', { count: archive.photos.length })}
          >
            <Camera className="w-4 h-4 text-blue-400" />
            {archive.photos.length > 1 && (
              <span className="absolute -top-1 -right-1 w-4 h-4 bg-blue-500 rounded-full text-[10px] text-white flex items-center justify-center">
                {archive.photos.length}
              </span>
            )}
          </button>
        )}
        {/* Linked folder badge */}
        {linkedFolders && linkedFolders.length > 0 && (
          <Link
            to={`/files?folder=${linkedFolders[0].id}`}
            className="absolute bottom-2 p-1.5 rounded bg-black/60 hover:bg-black/80 transition-colors"
            onClick={(e) => e.stopPropagation()}
            title={t('archives.card.openFolder', { name: linkedFolders[0].name })}
            style={{ left: archive.source_3mf_path ? (archive.f3d_path ? '5.5rem' : '3rem') : (archive.f3d_path ? '3rem' : '0.5rem') }}
          >
            <FolderOpen className="w-4 h-4 text-yellow-400" />
          </Link>
        )}
      </div>

      <CardContent className="p-4 flex-1 flex flex-col">
        {/* Archive ID */}
        <p className="text-[10px] text-bambu-gray/70 mb-1">#{archive.id}</p>

        {/* Title */}
        <div className="flex items-center justify-between gap-2 mb-1">
          <h3 className="min-w-0 font-medium text-white truncate">
            {archive.print_name || archive.filename}
          </h3>
          <Button
            variant="ghost"
            size="sm"
            className="p-1 sm:p-1.5 shrink-0"
            onClick={() => setShowEdit(true)}
            disabled={!canModify('archives', 'update', archive.created_by_id)}
            title={!canModify('archives', 'update', archive.created_by_id) ? t('archives.card.noPermissionEdit') : t('archives.card.edit')}
          >
            <Pencil className="w-3 h-3 sm:w-4 sm:h-4" />
          </Button>
        </div>
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <p className="text-xs text-bambu-gray">{printerName}</p>
          {(() => {
            const bed = getBedTypeInfo(archive.bed_type);
            return bed ? (
              <img src={bed.icon} alt={bed.label} title={bed.label} className="w-4 h-4 flex-shrink-0" />
            ) : null;
          })()}
          {/* File type badge */}
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
              isSlicedFile(archive)
                ? 'bg-bambu-green/20 text-bambu-green'
                : 'bg-orange-500/20 text-orange-400'
            }`}
            title={
              isSlicedFile(archive)
                ? t('archives.card.slicedFile')
                : t('archives.card.sourceFile')
            }
          >
            {isSlicedFile(archive) ? t('archives.card.gcode') : t('archives.card.source')}
          </span>
          {/* File hash badge */}
          {archive.content_hash && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-bambu-dark-tertiary/50 text-bambu-gray-light opacity-0 transition-opacity duration-150 group-hover:opacity-100"
              title={`SHA256: ${archive.content_hash}`}
            >
              {archive.content_hash.slice(0, 8).toUpperCase()}
            </span>
          )}
          {archive.project_name && (
            <span
              className="text-xs px-1.5 py-0.5 rounded-full truncate max-w-[120px]"
              style={{
                backgroundColor: `${projects?.find(p => p.id === archive.project_id)?.color || '#6b7280'}20`,
                color: projects?.find(p => p.id === archive.project_id)?.color || '#6b7280'
              }}
              title={t('archives.card.project', { name: archive.project_name })}
            >
              {archive.project_name}
            </span>
          )}
          {archive.run_count > 1 && (
            <button
              className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-bambu-orange/20 text-bambu-orange hover:bg-bambu-orange/30 transition-colors cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                setShowPrintLog(true);
              }}
              title={t('archives.card.runsBadgeTitle', {
                count: archive.run_count,
                successful: archive.successful_run_count,
                failed: archive.failed_run_count,
              })}
            >
              {t('archives.card.runsBadge', { count: archive.run_count })}
            </button>
          )}
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-2 text-xs mb-4 min-h-[48px]">
          {(archive.print_time_seconds || archive.actual_time_seconds) && (
            <div className="flex items-center gap-1.5 text-bambu-gray" title={
              archive.time_accuracy
                ? `Estimated: ${formatDuration(archive.print_time_seconds || 0)}\nActual: ${formatDuration(archive.actual_time_seconds || 0)}\nAccuracy: ${archive.time_accuracy.toFixed(0)}%`
                : archive.actual_time_seconds
                  ? `Actual: ${formatDuration(archive.actual_time_seconds)}`
                  : `Estimated: ${formatDuration(archive.print_time_seconds || 0)}`
            }>
              <Clock className="w-3 h-3" />
              {formatDuration(archive.actual_time_seconds || archive.print_time_seconds || 0)}
              {archive.time_accuracy && (
                <span className={`text-[10px] px-1 rounded ${
                  archive.time_accuracy >= 95 && archive.time_accuracy <= 105
                    ? 'bg-bambu-green/20 text-bambu-green'
                    : archive.time_accuracy > 105
                      ? 'bg-blue-500/20 text-blue-400'
                      : 'bg-orange-500/20 text-orange-400'
                }`}>
                  {archive.time_accuracy > 100 ? '+' : ''}{(archive.time_accuracy - 100).toFixed(0)}%
                </span>
              )}
            </div>
          )}
          {archive.filament_used_grams && (
            <div className="flex items-center gap-1.5 text-bambu-gray">
              <Package className="w-3 h-3" />
              {archive.filament_used_grams.toFixed(1)}g
            </div>
          )}
          {(archive.cost != null || archive.energy_cost != null) && (
            <div className="flex items-center gap-3 text-bambu-gray">
              {archive.cost != null && (
                <div className="flex items-center gap-1.5">
                  <Coins className="w-3 h-3" />
                  {currency}{archive.cost.toFixed(2)}
                </div>
              )}
                {archive.energy_cost != null && (
                  <div className="flex items-center gap-1.5" title={`${t('stats.energyUsed')}: ${archive.energy_kwh?.toFixed(3) || 'N/A'} kWh`}>
                    <Zap className="w-3 h-3" />
                    {currency}{archive.energy_cost.toFixed(2)}
                  </div>
                )}
            </div>
          )}
          {(archive.layer_height || archive.total_layers) && (
            <div className="flex items-center gap-1.5 text-bambu-gray">
              <Layers className="w-3 h-3" />
              {archive.total_layers && <span>{archive.total_layers === 1 ? t('archives.card.layer', { count: archive.total_layers }) : t('archives.card.layers', { count: archive.total_layers })}</span>}
              {archive.total_layers && archive.layer_height && <span className="text-bambu-gray/50">·</span>}
              {archive.layer_height && <span>{archive.layer_height}mm</span>}
            </div>
          )}
          {archive.object_count != null && archive.object_count > 0 && (
            <div className="flex items-center gap-1.5 text-bambu-gray" title={archive.object_count === 1 ? t('archives.card.object', { count: archive.object_count }) : t('archives.card.objects', { count: archive.object_count })}>
              <Box className="w-3 h-3" />
              {archive.object_count === 1 ? t('archives.card.object', { count: archive.object_count }) : t('archives.card.objects', { count: archive.object_count })}
            </div>
          )}
          {archive.sliced_for_model && (
            <div className="flex items-center gap-1.5 text-bambu-gray" title={t('archives.card.slicedFor', { model: archive.sliced_for_model })}>
              <Printer className="w-3 h-3" />
              {archive.sliced_for_model}
            </div>
          )}
          {archive.filament_type && (
            <div className="flex items-center gap-1.5 col-span-2">
              <span className="text-bambu-gray text-xs">{archive.filament_type}</span>
              {archive.filament_color && (
                <div className="flex items-center gap-0.5 flex-wrap">
                  {archive.filament_color.split(',').map((color, i) => (
                    <div
                      key={i}
                      className="w-3 h-3 rounded-full border border-black/20"
                      style={{ backgroundColor: color }}
                      title={color}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Tags & Notes */}
        {(archive.tags || archive.notes) && (
          <div className="flex flex-wrap items-center gap-1.5 mb-3">
            {archive.notes && (
              <div
                className="flex items-center gap-1 px-1.5 py-0.5 bg-blue-500/20 text-blue-400 rounded text-xs"
                title={archive.notes}
              >
                <StickyNote className="w-3 h-3" />
              </div>
            )}
            {archive.tags?.split(',').map((tag, i) => (
              <span
                key={i}
                className="px-1.5 py-0.5 bg-bambu-dark-tertiary text-bambu-gray-light rounded text-xs"
              >
                {tag.trim()}
              </span>
            ))}
          </div>
        )}

        {/* Spacer to push content to bottom */}
        <div className="flex-1" />

        {/* Date, Size & Creator */}
        <div className="flex items-center justify-between text-xs text-bambu-gray border-t border-bambu-dark-tertiary pt-3">
          <span title={`${t('archives.uploaded')}: ${formatDateTime(archive.created_at, timeFormat)}`}>
            {archive.last_run_at || archive.started_at || archive.status !== 'archived' ? formatDateTime(getLastPrintedAt(archive), timeFormat) : t('archives.notYetPrinted')}
          </span>
          <div className="flex items-center gap-2">
            {archive.created_by_username && (
              <span className="flex items-center gap-1" title={t('archives.card.uploadedBy', { name: archive.created_by_username })}>
                <User className="w-3 h-3" />
                {archive.created_by_username}
              </span>
            )}
            <span>{formatFileSize(archive.file_size)}</span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-1 mt-3">
          {isSlicedFile(archive) ? (
            // Sliced file - can print directly
              <Button
                variant="primary"
                size="sm"
                className="flex-1 min-w-0 overflow-hidden"
                onClick={() => setShowReprint(true)}
                aria-label={t('archives.menu.print')}
                disabled={!archive.file_path || !hasPermission('queue:create') || !canModify('archives', 'reprint', archive.created_by_id)}
                title={!archive.file_path ? t('archives.card.noFileForReprint') : !hasPermission('queue:create') ? t('archives.permission.noAddToQueue') : !canModify('archives', 'reprint', archive.created_by_id) ? t('archives.card.noPermissionReprint') : undefined}
              >
                <Printer className="w-3 h-3 flex-shrink-0" />
                <span className="hidden xl:inline truncate">{t('archives.menu.print')}</span>
              </Button>
          ) : (
            // Source file only - "Slice" action
            <Button
              variant="primary"
              size="sm"
              className="flex-1 min-w-0 overflow-hidden"
              onClick={() => {
                if (useSlicerApi) {
                  setShowSliceModal(true);
                } else {
                  const filename = archive.print_name || archive.filename || 'model';
                  openInSlicerWithToken(archive.id, filename, 'file', preferredSlicer);
                }
              }}
              title={useSlicerApi ? t('slice.title') : t('archives.card.openInBambuStudioToSlice')}
            >
              {useSlicerApi ? (
                <Cog className="w-3 h-3 flex-shrink-0" />
              ) : (
                <ExternalLink className="w-3 h-3 flex-shrink-0" />
              )}
              <span className="hidden xl:inline truncate">{t('archives.card.slice')}</span>
            </Button>
          )}
          {archive.file_path && (
            <Button
              variant="secondary"
              size="sm"
              className="min-w-0 p-1 sm:p-1.5"
              onClick={(event) => {
                event.stopPropagation();
                setShowSaveToFiles(true);
              }}
              disabled={!hasPermission('library:upload')}
              title={!hasPermission('library:upload') ? t('archives.permission.noSaveToFiles') : t('archives.menu.saveToFiles')}
              aria-label={t('archives.menu.saveToFiles')}
            >
              <Save className="w-3 h-3 sm:w-4 sm:h-4" />
            </Button>
          )}
        </div>
      </CardContent>

      {/* Edit Modal */}
      {showEdit && (
        <EditArchiveModal
          archive={archive}
          onClose={() => setShowEdit(false)}
        />
      )}

      {/* Print Log Modal — opened from the "N prints" badge or context menu (#1378) */}
      {showPrintLog && (
        <PrintLogModal
          archiveId={archive.id}
          archiveName={archive.print_name || archive.filename}
          onClose={() => setShowPrintLog(false)}
        />
      )}

      {/* Plate picker — shown only for multi-plate archives on 3D Preview click */}
      {platePickerPlates && (
        <PlatePickerModal
          plates={platePickerPlates}
          onSelect={(plateIndex) => {
            setPlatePickerPlates(null);
            navigate(`/gcode-viewer?archive=${archive.id}&plate=${plateIndex}`);
          }}
          onClose={() => setPlatePickerPlates(null)}
        />
      )}

      {/* Reprint Modal */}
      {showReprint && (
        <PrintModal
          mode="create"
          archiveId={archive.id}
          archiveName={archive.print_name || archive.filename}
          onClose={() => setShowReprint(false)}
        />
      )}

      {/* Save to Files */}
      {showSaveToFiles && (
        <SaveArchiveToFilesModal archive={archive} onClose={() => setShowSaveToFiles(false)} />
      )}

      {/* Slice Modal */}
      {showSliceModal && (
        <SliceModal
          source={{ kind: 'archive', id: archive.id, filename: archive.print_name || archive.filename || 'model' }}
          onClose={() => setShowSliceModal(false)}
        />
      )}

      {/* Delete Confirmation */}
      {showDeleteConfirm && (
        <ConfirmModal
          title={t('archives.modal.deleteArchive')}
          message={t('archives.modal.deleteConfirm', { name: archive.print_name || archive.filename })}
          confirmText={t('archives.modal.deleteButton')}
          variant="danger"
          confirmDisabled={(deleteImpactQuery.data?.currently_printing ?? 0) > 0}
          onConfirm={() => {
            deleteMutation.mutate(deletePurgeStats);
            setShowDeleteConfirm(false);
            setDeletePurgeStats(false);
          }}
          onCancel={() => {
            setShowDeleteConfirm(false);
            setDeletePurgeStats(false);
          }}
        >
          {/* #1734: warn the user when related queue items will also be removed,
              and block the action entirely if any are currently printing. */}
          {(deleteImpactQuery.data?.related_queue_items ?? 0) > 0 && (
            <div
              className={
                (deleteImpactQuery.data?.currently_printing ?? 0) > 0
                  ? 'text-sm text-red-400 mb-2'
                  : 'text-sm text-amber-400 mb-2'
              }
            >
              {(deleteImpactQuery.data?.currently_printing ?? 0) > 0
                ? t('archives.modal.deleteBlockedByPrinting', {
                    count: deleteImpactQuery.data!.currently_printing,
                  })
                : t('archives.modal.deleteQueueItemsWarning', {
                    count: deleteImpactQuery.data!.related_queue_items,
                  })}
            </div>
          )}
          {/* #1343: opt-in checkbox — by default the archive is soft-deleted,
              so its filament / time / cost contribution stays in Quick Stats. */}
          <label className="flex items-start gap-2 cursor-pointer text-sm text-bambu-gray">
            <input
              type="checkbox"
              className="mt-0.5 accent-red-500"
              checked={deletePurgeStats}
              onChange={(e) => setDeletePurgeStats(e.target.checked)}
            />
            <span>{t('archives.modal.deletePurgeStats')}</span>
          </label>
        </ConfirmModal>
      )}

      {/* Delete Source 3MF Confirmation */}
      {showDeleteSource3mfConfirm && (
        <ConfirmModal
          title={t('archives.modal.removeSource3mf')}
          message={t('archives.modal.removeSource3mfConfirm', { name: archive.print_name || archive.filename })}
          confirmText={t('archives.modal.removeButton')}
          variant="danger"
          onConfirm={() => {
            source3mfDeleteMutation.mutate();
            setShowDeleteSource3mfConfirm(false);
          }}
          onCancel={() => setShowDeleteSource3mfConfirm(false)}
        />
      )}

      {/* Delete F3D Confirmation */}
      {showDeleteF3dConfirm && (
        <ConfirmModal
          title={t('archives.modal.removeF3d')}
          message={t('archives.modal.removeF3dConfirm', { name: archive.print_name || archive.filename })}
          confirmText={t('archives.modal.removeButton')}
          variant="danger"
          onConfirm={() => {
            f3dDeleteMutation.mutate();
            setShowDeleteF3dConfirm(false);
          }}
          onCancel={() => setShowDeleteF3dConfirm(false)}
        />
      )}

      {/* Delete Timelapse Confirmation */}
      {showDeleteTimelapseConfirm && (
        <ConfirmModal
          title={t('archives.modal.removeTimelapse')}
          message={t('archives.modal.removeTimelapseConfirm', { name: archive.print_name || archive.filename })}
          confirmText={t('archives.modal.removeButton')}
          variant="danger"
          onConfirm={() => {
            timelapseDeleteMutation.mutate();
            setShowDeleteTimelapseConfirm(false);
          }}
          onCancel={() => setShowDeleteTimelapseConfirm(false)}
        />
      )}

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={() => { setContextMenu(null); menuTriggerRef.current?.focus(); }}
        />
      )}

      {/* Timelapse Viewer Modal */}
      {showTimelapse && archive.timelapse_path && (
        <TimelapseViewer
          src={api.getArchiveTimelapse(archive.id)}
          title={t('archives.modal.timelapse', { name: archive.print_name || archive.filename })}
          downloadFilename={`${archive.print_name || archive.filename}_timelapse.mp4`}
          archiveId={archive.id}
          onClose={() => setShowTimelapse(false)}
          onEdit={() => {
            queryClient.invalidateQueries({ queryKey: ['archives'] });
            setShowTimelapse(false);  // Close viewer to reload fresh video
          }}
        />
      )}

      {/* Timelapse Selection Modal */}
      {showTimelapseSelect && availableTimelapses.length > 0 && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-card-dark rounded-lg max-w-lg w-full max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-gray-700">
              <div>
                <h3 className="text-lg font-semibold text-white">{t('archives.modal.selectTimelapse')}</h3>
                <p className="text-sm text-gray-400 mt-1">
                  {t('archives.modal.selectTimelapseDesc')}
                </p>
              </div>
              <button
                onClick={() => {
                  setShowTimelapseSelect(false);
                  setAvailableTimelapses([]);
                }}
                className="text-gray-400 hover:text-white p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="overflow-y-auto flex-1 p-2">
              {availableTimelapses.map((file) => (
                <button
                  key={file.name}
                  onClick={() => timelapseSelectMutation.mutate(file.name)}
                  disabled={timelapseSelectMutation.isPending}
                  className="w-full text-left p-3 rounded-lg hover:bg-gray-700 transition-colors flex items-center gap-3 disabled:opacity-50"
                >
                  <Film className="w-8 h-8 text-bambu-green flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-white font-medium truncate">{file.name}</p>
                    <p className="text-sm text-gray-400">
                      {formatFileSize(file.size)}
                      {file.mtime && ` • ${formatDateTime(file.mtime, timeFormat)}`}
                    </p>
                  </div>
                </button>
              ))}
            </div>
            <div className="p-4 border-t border-gray-700">
              <Button
                variant="secondary"
                onClick={() => {
                  setShowTimelapseSelect(false);
                  setAvailableTimelapses([]);
                }}
                className="w-full"
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* QR Code Modal */}
      {showQRCode && (
        <QRCodeModal
          archiveId={archive.id}
          archiveName={archive.print_name || archive.filename}
          onClose={() => setShowQRCode(false)}
        />
      )}

      {/* Photo Gallery Modal */}
      {showPhotos && archive.photos && archive.photos.length > 0 && (
        <PhotoGalleryModal
          archiveId={archive.id}
          archiveName={archive.print_name || archive.filename}
          photos={archive.photos}
          onClose={() => setShowPhotos(false)}
          onDelete={async (filename) => {
            try {
              await api.deleteArchivePhoto(archive.id, filename);
              queryClient.invalidateQueries({ queryKey: ['archives'] });
              showToast(t('archives.toast.photoDeleted'));
            } catch {
              showToast(t('archives.toast.failedDeletePhoto'), 'error');
            }
          }}
        />
      )}

      {/* Project Page Modal */}
      {showProjectPage && (
        <ProjectPageModal
          archiveId={archive.id}
          archiveName={archive.print_name || archive.filename}
          onClose={() => setShowProjectPage(false)}
        />
      )}

      {/* Hidden file input for source 3MF upload */}
      <input
        ref={source3mfInputRef}
        type="file"
        accept=".3mf"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            source3mfUploadMutation.mutate(file);
          }
          e.target.value = '';
        }}
      />
      {/* Hidden file input for F3D upload */}
      <input
        ref={f3dInputRef}
        type="file"
        accept=".f3d"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            f3dUploadMutation.mutate(file);
          }
          e.target.value = '';
        }}
      />
      {/* Hidden file input for timelapse upload */}
      <input
        ref={timelapseInputRef}
        type="file"
        accept=".mp4,.avi,.mkv"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            timelapseUploadMutation.mutate(file);
          }
          e.target.value = '';
        }}
      />
    </Card>
  );
}

export function ArchivesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { hasPermission, hasAnyPermission } = useAuth();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const filters = useHistoryFilters();
  const { values, sortBy, setSearch } = filters;
  const { search, filterPrinter, filterUser, collection } = values;
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  // Install-step-4 nudge — covers the slicer-side variant of "Store sent files
  // on external storage" that the connection diagnostic can't detect (printer
  // never hears about it). Symptom: archive created via no-3MF fallback. Once
  // dismissed, never shown again — fixing step 4 stops new fallbacks anyway.
  const [no3MFWarningDismissed, setNo3MFWarningDismissed] = useState(
    () => localStorage.getItem('archiveNo3MFWarningDismissed') === 'true',
  );
  const { data: no3MFWarning } = useQuery({
    queryKey: ['archives', 'no-3mf-warning'],
    queryFn: api.getNo3MFWarning,
    staleTime: 5 * 60 * 1000,
    enabled: !no3MFWarningDismissed,
  });
  const dismissNo3MFWarning = () => {
    localStorage.setItem('archiveNo3MFWarningDismissed', 'true');
    setNo3MFWarningDismissed(true);
  };
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [showBatchTag, setShowBatchTag] = useState(false);
  const [showBatchProject, setShowBatchProject] = useState(false);
  // The old per-file list view was folded into the print log (one row per print).
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = localStorage.getItem('archiveViewMode');
    if (saved === 'list') return 'log';
    return saved === 'calendar' || saved === 'log' ? saved : 'grid';
  });
  // Pagination state
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState<number>(() => {
    try {
      const stored = localStorage.getItem('archivePageSize');
      return stored ? Number(stored) : 50;
    } catch { return 50; }
  });

  const [showExportMenu, setShowExportMenu] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [showCompareModal, setShowCompareModal] = useState(false);
  const [showTagManagement, setShowTagManagement] = useState(false);
  const [showPurgeModal, setShowPurgeModal] = useState(false);
  const [highlightedArchiveId, setHighlightedArchiveId] = useState<number | null>(null);
  const [pendingNavigationArchiveId, setPendingNavigationArchiveId] = useState<number | null>(null);

  // Log view state
  const [logOffset, setLogOffset] = useState(0);
  const [showClearLogConfirm, setShowClearLogConfirm] = useState(false);
  const [pendingDeleteEntryId, setPendingDeleteEntryId] = useState<number | null>(null);
  // Per-row classification editor for Print Log entries (#1687 part 4).
  // Holds the entry being edited; null = modal closed.
  const [editingLogEntry, setEditingLogEntry] = useState<PrintLogEntry | null>(null);
  const [editingLogFailureReason, setEditingLogFailureReason] = useState('');
  const [editingLogStatus, setEditingLogStatus] = useState('');
  const [logPageSize, setLogPageSize] = useState(() => {
    const saved = localStorage.getItem('logPageSize');
    return saved ? Number(saved) : 25;
  });

  const handleNavigateToArchive = useCallback((archiveId: number) => {
    setPendingNavigationArchiveId(archiveId);
    setHighlightedArchiveId(archiveId);
  }, []);

  // Deep links from other pages: /archives?search=<text> and /archives?highlight=<id>.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const linkedSearch = searchParams.get('search');
    const linkedHighlight = Number(searchParams.get('highlight'));
    if (!linkedSearch && !linkedHighlight) return;
    if (linkedSearch) setSearch(linkedSearch);
    if (linkedHighlight) {
      setSearch('');
      setViewMode('grid');
      handleNavigateToArchive(linkedHighlight);
    }
    setSearchParams({}, { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  // The print log filters by the printer each run used, but an archive only remembers its
  // latest printer. So in the log the archive lookup must not be narrowed by the printer
  // filter, or reprinted models would lose their row actions.
  const archivePrinter = viewMode === 'log' ? undefined : filterPrinter || undefined;
  const { data: archives, isLoading } = useQuery({
    queryKey: ['archives', archivePrinter],
    queryFn: () => api.getArchives(archivePrinter),
  });

  const { data: printers } = useQuery({
    queryKey: ['printers'],
    queryFn: api.getPrinters,
  });

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.getProjects(),
  });

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: api.getSettings,
  });

  const { data: users } = useQuery({
    queryKey: ['users'],
    queryFn: api.getUsers,
  });

  // Filters the print log can't apply on the server (they depend on the linked
  // archive, or on fields the log API doesn't expose) switch it to a larger
  // fetch that is filtered and paged here.
  const logNeedsClientFilter = needsClientLogFilter(values);
  const LOG_CLIENT_FETCH_LIMIT = 500;
  // Status filter and collection that exclude each other can't match anything.
  const logCanMatch = useMemo(() => {
    const { statuses } = getServerFilterBounds(values);
    return !statuses || statuses.length > 0;
  }, [values]);

  // The key names the filters (not the instants they resolve to) and the bounds are worked out at
  // fetch time, so a refetch of "Last 24 hours" slides the window instead of reusing the one that
  // was computed when the filter was chosen.
  const { data: printLogData, isLoading: isLogLoading } = useQuery({
    queryKey: [
      'print-log', filterPrinter, filterUser, values.filterStatus, values.collection, values.filterDateFrom,
      values.filterDateTo, search, logNeedsClientFilter ? 'all' : logOffset, logNeedsClientFilter ? 'all' : logPageSize,
    ],
    queryFn: () => {
      const bounds = getServerFilterBounds(values);
      return api.getPrintLog({
        search: search || undefined,
        printerId: filterPrinter || undefined,
        username: filterUser || undefined,
        status: bounds.statuses?.join(',') || undefined,
        dateFrom: bounds.from?.toISOString(),
        dateTo: bounds.to?.toISOString(),
        limit: logNeedsClientFilter ? LOG_CLIENT_FETCH_LIMIT : logPageSize,
        offset: logNeedsClientFilter ? 0 : logOffset,
      });
    },
    enabled: viewMode === 'log' && logCanMatch,
  });

  const timeFormat: TimeFormat = settings?.time_format || 'system';
  // Desktop "Open in Slicer" target — falls back to preferred_slicer when the
  // user hasn't explicitly chosen a different desktop slicer (#1329). This is
  // ONLY the URI-handoff target; the in-app SliceModal still uses
  // preferred_slicer for the sidecar.
  const preferredSlicer: SlicerType = settings?.open_in_slicer || settings?.preferred_slicer || 'bambu_studio';
  const useSlicerApi = settings?.use_slicer_api ?? false;
  const currency = getCurrencySymbol(settings?.currency || 'USD');

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      await Promise.all(ids.map((id) => api.deleteArchive(id)));
      return ids.length;
    },
    onSuccess: (count) => {
      queryClient.invalidateQueries({ queryKey: ['archives'] });
      setSelectedIds(new Set());
      showToast(`${count} archive${count !== 1 ? 's' : ''} deleted`);
    },
    onError: () => {
      showToast(t('archives.toast.failedDeleteArchives'), 'error');
    },
  });

  const clearLogMutation = useMutation({
    mutationFn: () => api.clearPrintLog(),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['print-log'] });
      setLogOffset(0);
      showToast(t('archives.log.cleared', { count: data.deleted }));
    },
    onError: () => {
      showToast(t('archives.log.clearFailed'), 'error');
    },
  });

  const deleteLogEntryMutation = useMutation({
    mutationFn: (id: number) => api.deletePrintLogEntry(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['print-log'] });
      queryClient.invalidateQueries({ queryKey: ['archives-stats'] });
      showToast(t('archives.log.entryDeleted'));
    },
    onError: () => {
      showToast(t('archives.log.entryDeleteFailed'), 'error');
    },
  });

  // Log rows act on the archive they were printed from.
  const [logReprintArchive, setLogReprintArchive] = useState<Archive | null>(null);
  const logFavouriteMutation = useMutation({
    mutationFn: (id: number) => api.toggleFavorite(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['archives'] }),
    onError: () => showToast(t('archives.toast.failedUpdateFavorites'), 'error'),
  });
  const downloadLogArchive = async (archive: Archive) => {
    try {
      await api.downloadArchive(archive.id, archive.filename);
    } catch {
      showToast(t('archives.log.downloadFailed'), 'error');
    }
  };
  // Export honours the filters the server understands: printer, status, user, search
  // and the last-printed range (including the time-based collections). Filters that
  // depend on archive details (material, tags, colours...) are listed in the menu
  // instead of being silently ignored.
  const runExport = async (format: 'csv' | 'xlsx') => {
    setShowExportMenu(false);
    setIsExporting(true);
    try {
      const { blob, filename } = await api.exportArchives({ format, ...getExportParams(values) });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      showToast(t('archives.toast.exportDownloaded'));
    } catch {
      showToast(t('archives.toast.exportFailed'), 'error');
    } finally {
      setIsExporting(false);
    }
  };
  const openArchiveInGrid = (archiveId: number) => {
    setSearch('');
    setViewMode('grid');
    handleNavigateToArchive(archiveId);
  };

  const updateLogEntryMutation = useMutation({
    mutationFn: ({ id, body }: { id: number; body: { failure_reason?: string | null; status?: string } }) =>
      api.updatePrintLogEntry(id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['print-log'] });
      // Also invalidate /archives/stats — the Failure Analysis widget there
      // groups by PrintLogEntry.failure_reason, so a re-classification needs
      // to flow through (#1687 part 4).
      queryClient.invalidateQueries({ queryKey: ['archives-stats'] });
      setEditingLogEntry(null);
      showToast(t('archives.log.entryUpdated'));
    },
    onError: () => {
      showToast(t('archives.log.entryUpdateFailed'), 'error');
    },
  });

  // Back to the first page whenever a filter or the sort changes (`values` only changes identity then).
  useEffect(() => {
    setLogOffset(0);
  }, [values]);

  useEffect(() => {
    setPageIndex(0);
  }, [values, sortBy]);

  useEffect(() => {
    try { localStorage.setItem('archivePageSize', String(pageSize)); } catch { /* ignore */ }
  }, [pageSize]);

  useEffect(() => {
    localStorage.setItem('archiveViewMode', viewMode);
  }, [viewMode]);

  useEffect(() => {
    localStorage.setItem('logPageSize', logPageSize.toString());
  }, [logPageSize]);

  const printerMap = useMemo(() => new Map(printers?.map((p) => [p.id, p.name]) || []), [printers]);

  // Options for the filter menus, from the archives on hand.
  const { uniqueMaterials, uniqueColors, uniqueTags } = useMemo(() => ({
    uniqueMaterials: [...new Set(archives?.flatMap((a) => a.filament_type?.split(', ') || []).filter(Boolean) || [])].sort(),
    uniqueColors: [...new Set(archives?.flatMap((a) => a.filament_color?.split(',') || []).filter(Boolean) || [])],
    uniqueTags: [...new Set(archives?.flatMap((a) => a.tags?.split(',').map((t) => t.trim()) || []).filter(Boolean) || [])].sort(),
  }), [archives]);

  const filteredArchives = useMemo(
    () => (archives ? filterAndSortArchives(archives, values, sortBy) : undefined),
    [archives, values, sortBy],
  );

  // Pagination
  const totalFiltered = filteredArchives?.length || 0;
  const showAll = pageSize === -1;
  const effectivePageSize = showAll ? totalFiltered || 1 : pageSize;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / effectivePageSize));
  useEffect(() => {
    if (pageIndex >= totalPages) setPageIndex(Math.max(0, totalPages - 1));
  }, [pageIndex, totalPages]);
  const paginatedArchives = showAll
    ? filteredArchives
    : filteredArchives?.slice(pageIndex * effectivePageSize, (pageIndex + 1) * effectivePageSize);

  // Print log rows: one per print. Archive-level filters are applied through the linked archive.
  const archiveById = useMemo(() => new Map((archives ?? []).map((a) => [a.id, a])), [archives]);
  const logEntriesFiltered = useMemo(
    () => (logNeedsClientFilter ? filterLogEntries(printLogData?.items ?? [], archiveById, values) : printLogData?.items ?? []),
    [logNeedsClientFilter, printLogData, archiveById, values],
  );
  const logTotal = logNeedsClientFilter ? logEntriesFiltered.length : printLogData?.total ?? 0;
  const logRows = logNeedsClientFilter
    ? logEntriesFiltered.slice(logOffset, logOffset + logPageSize)
    : logEntriesFiltered;
  // If rows disappear from under the current page (e.g. un-favouriting the last one under a
  // favourites filter), step back to the last page that still has rows.
  useEffect(() => {
    if (printLogData && logOffset > 0 && logOffset >= logTotal) {
      setLogOffset(Math.max(0, Math.floor((logTotal - 1) / logPageSize) * logPageSize));
    }
  }, [printLogData, logOffset, logTotal, logPageSize]);
  // Client-side filters only see the newest LOG_CLIENT_FETCH_LIMIT entries.
  const logTruncated = logNeedsClientFilter && (printLogData?.total ?? 0) > LOG_CLIENT_FETCH_LIMIT;

  // Jump to the page containing the highlighted archive
  useEffect(() => {
    if (highlightedArchiveId && filteredArchives && !showAll) {
      const idx = filteredArchives.findIndex(a => a.id === highlightedArchiveId);
      if (idx >= 0) {
        const targetPage = Math.floor(idx / effectivePageSize);
        if (targetPage !== pageIndex) setPageIndex(targetPage);
      }
    }
  // Re-run once the archives arrive so a deep link on a cold load still finds its page.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightedArchiveId, isLoading]);

  // Clear highlight after 5 seconds and scroll to highlighted element
  useEffect(() => {
    // Wait for the archives to load: a deep link opened on a cold page would
    // otherwise look for an element that does not exist yet.
    if (highlightedArchiveId && !isLoading) {
      // Scroll to highlighted element after a short delay (to let the view render)
      const scrollTimer = setTimeout(() => {
        const element = document.querySelector(`[data-archive-id="${highlightedArchiveId}"]`);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else if (pendingNavigationArchiveId === highlightedArchiveId) {
          showToast(t('archives.originalPrintNotVisible'), 'warning');
        }
        if (pendingNavigationArchiveId === highlightedArchiveId) {
          setPendingNavigationArchiveId(null);
        }
      }, 100);

      // Clear highlight after 5 seconds
      const clearTimer = setTimeout(() => setHighlightedArchiveId(null), 5000);
      return () => {
        clearTimeout(scrollTimer);
        clearTimeout(clearTimer);
      };
    }
  }, [highlightedArchiveId, pendingNavigationArchiveId, isLoading, showToast, t]);

  // The log and the grid list different things, so a selection made in one means nothing in the other.
  const inLogView = viewMode === 'log';
  useEffect(() => {
    setSelectedIds(new Set());
  }, [inLogView]);

  const selectionMode = isSelectionMode || selectedIds.size > 0;

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectAll = () => {
    if (viewMode === 'log') {
      // Only the archives behind the rows on screen, never ones the log doesn't show.
      setSelectedIds(new Set(logRows.flatMap((e) => (e.archive_id != null && archiveById.has(e.archive_id) ? [e.archive_id] : []))));
      return;
    }
    if (filteredArchives) {
      setSelectedIds(new Set(filteredArchives.map((a) => a.id)));
    }
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
    setIsSelectionMode(false);
  };

  const activeChips = useMemo(
    () => getActiveFilterChips(values, t, filterPrinter ? printerMap.get(filterPrinter) : undefined),
    [values, t, filterPrinter, printerMap],
  );
  const exportIgnored = exportIgnoredFilters(activeChips, collection);
  const shownCount = viewMode === 'log' ? logTotal : filteredArchives?.length || 0;

  // Keyboard shortcuts
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    // Ignore if typing in an input/textarea
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
      if (e.key === 'Escape') {
        target.blur();
      }
      return;
    }

    switch (e.key) {
      case '/':
        e.preventDefault();
        searchInputRef.current?.focus();
        break;
      case 'Escape':
        if (selectionMode) {
          clearSelection();
        }
        break;
    }
  }, [selectionMode]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div className="p-4 md:p-8 relative">
      {/* Selection Toolbar */}
      {selectionMode && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg shadow-xl px-4 py-3 flex items-center gap-4">
          <Button variant="secondary" size="sm" onClick={clearSelection}>
            <X className="w-4 h-4" />
            Close
          </Button>
          <div className="w-px h-6 bg-bambu-dark-tertiary" />
          <span className="text-white font-medium">
            {selectedIds.size} selected
          </span>
          <div className="w-px h-6 bg-bambu-dark-tertiary" />
          <Button variant="secondary" size="sm" onClick={selectAll}>
            Select All
          </Button>
          <div className="w-px h-6 bg-bambu-dark-tertiary" />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowBatchTag(true)}
            disabled={!hasAnyPermission('archives:update_own', 'archives:update_all')}
            title={!hasAnyPermission('archives:update_own', 'archives:update_all') ? t('archives.permission.noUpdateArchives') : undefined}
          >
            <Tag className="w-4 h-4" />
            Tags
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowBatchProject(true)}
            disabled={!hasAnyPermission('archives:update_own', 'archives:update_all')}
            title={!hasAnyPermission('archives:update_own', 'archives:update_all') ? t('archives.permission.noUpdateArchives') : undefined}
          >
            <FolderKanban className="w-4 h-4" />
            Project
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={!hasAnyPermission('archives:update_own', 'archives:update_all')}
            title={!hasAnyPermission('archives:update_own', 'archives:update_all') ? t('archives.permission.noUpdateArchives') : undefined}
            onClick={() => {
              const ids = Array.from(selectedIds);
              Promise.all(ids.map(id => api.toggleFavorite(id)))
                .then(() => {
                  queryClient.invalidateQueries({ queryKey: ['archives'] });
                  showToast(`Toggled favorites for ${ids.length} archive${ids.length !== 1 ? 's' : ''}`);
                })
                .catch(() => {
                  showToast(t('archives.toast.failedUpdateFavorites'), 'error');
                });
            }}
          >
            <Star className="w-4 h-4" />
            Favorite
          </Button>
          <Button
            size="sm"
            className="bg-red-500 hover:bg-red-600"
            onClick={() => setShowBulkDeleteConfirm(true)}
            disabled={!hasAnyPermission('archives:delete_own', 'archives:delete_all')}
            title={!hasAnyPermission('archives:delete_own', 'archives:delete_all') ? t('archives.permission.noDelete') : undefined}
          >
            <Trash2 className="w-4 h-4" />
            Delete
          </Button>
        </div>
      )}

      {no3MFWarning?.has_fallback && !no3MFWarningDismissed && (
        <div className="mb-6 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-amber-200">
              {t('archives.no3mfBanner.title')}
            </div>
            <div className="text-xs text-amber-200/80 mt-1">
              {t('archives.no3mfBanner.body')}
            </div>
          </div>
          <button
            onClick={dismissNo3MFWarning}
            className="text-amber-200/60 hover:text-amber-200 flex-shrink-0 p-1 -m-1"
            title={t('archives.no3mfBanner.dismissLabel')}
            aria-label={t('archives.no3mfBanner.dismissLabel')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
        <div>
          <div className="flex items-start gap-3">
            <div>
              <h1 className="text-2xl font-bold text-white flex items-center gap-3">
                <History className="w-7 h-7 text-bambu-green" />
                {t('nav.archives')}
              </h1>
              <p className="text-bambu-gray mt-1">
                {viewMode === 'log' ? logTotal : filteredArchives?.length || 0} of {viewMode === 'log' ? (printLogData?.total ?? 0) : archives?.length || 0} prints
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
          {/* Export dropdown */}
          <div className="relative">
            <Button
              variant="secondary"
              onClick={() => setShowExportMenu(!showExportMenu)}
              disabled={isExporting || shownCount === 0}
            >
              {isExporting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <FileSpreadsheet className="w-4 h-4" />
              )}
              {t('archives.filters.export')}
            </Button>
            {showExportMenu && (
              <div className="absolute right-0 top-full mt-1 w-56 bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg shadow-xl z-20">
                <button
                  className="w-full px-4 py-2 text-left text-white hover:bg-bambu-dark-tertiary transition-colors flex items-center gap-2 rounded-t-lg"
                  onClick={() => runExport('csv')}
                >
                  <FileText className="w-4 h-4" />
                  {t('archives.filters.exportCsv')}
                </button>
                <button
                  className="w-full px-4 py-2 text-left text-white hover:bg-bambu-dark-tertiary transition-colors flex items-center gap-2 rounded-b-lg"
                  onClick={() => runExport('xlsx')}
                >
                  <FileSpreadsheet className="w-4 h-4" />
                  {t('archives.filters.exportExcel')}
                </button>
                {viewMode === 'log' && (
                  <p className="border-t border-bambu-dark-tertiary px-4 py-2 text-xs text-bambu-gray">
                    {t('archives.filters.exportLogNote')}
                  </p>
                )}
                {exportIgnored.length > 0 && (
                  <p className="border-t border-bambu-dark-tertiary px-4 py-2 text-xs text-bambu-gray">
                    {t('archives.filters.exportNote', { filters: exportIgnored.join(', ') })}
                  </p>
                )}
              </div>
            )}
          </div>
          {/* Compare button (only when 2-5 items selected) */}
          {selectedIds.size >= 2 && selectedIds.size <= 5 && (
            <Button
              variant="secondary"
              onClick={() => setShowCompareModal(true)}
            >
              <GitCompare className="w-4 h-4" />
              {t('archives.filters.compare')} ({selectedIds.size})
            </Button>
          )}
          {!selectionMode && (
            <Button variant="secondary" onClick={() => setIsSelectionMode(true)}>
              <CheckSquare className="w-4 h-4" />
              {t('archives.filters.select')}
            </Button>
          )}
          {hasPermission('archives:purge') && (
            <Button
              variant="secondary"
              onClick={() => setShowPurgeModal(true)}
              title={t('archivePurge.headerTooltip')}
            >
              <Trash2 className="w-4 h-4 mr-2" />
              {t('archivePurge.headerButton')}
            </Button>
          )}
        </div>
      </div>

      <HistoryFilterBar
        filters={filters}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        chips={activeChips}
        printers={printers}
        users={users}
        uniqueMaterials={uniqueMaterials}
        uniqueColors={uniqueColors}
        uniqueTags={uniqueTags}
        shownCount={shownCount}
        searchInputRef={searchInputRef}
        onManageTags={() => setShowTagManagement(true)}
      />

      {/* Pending Uploads Panel (visible when in queue mode with pending files) */}
      <PendingUploadsPanel />

      {/* Archives */}
      {isLoading ? (
        <div className="text-center py-12 text-bambu-gray">{t('archives.loadingArchives')}</div>
      ) : viewMode !== 'log' && filteredArchives?.length === 0 ? (
        <Card>
          <CardContent className="text-center py-12">
            <p className="text-bambu-gray">
              {filters.hasActive ? t('archives.noArchivesSearch') : t('archives.noArchivesYet')}
            </p>
            {filters.hasActive ? (
              <Button variant="ghost" size="sm" className="mt-3" onClick={filters.clearAll}>
                <X className="w-4 h-4" />
                {t('archives.resetFilters')}
              </Button>
            ) : (
              <p className="text-sm text-bambu-gray mt-2">
                {t('archives.createdAutomatically')}
              </p>
            )}
          </CardContent>
        </Card>
      ) : viewMode === 'calendar' ? (
        <Card className="p-6">
          <CalendarView
            archives={filteredArchives || []}
            onArchiveClick={(archive) => {
              // Switch to grid view and highlight the archive
              setSearch(''); // Clear search to show all archives
              setViewMode('grid');
              setHighlightedArchiveId(archive.id);
            }}
            highlightedArchiveId={highlightedArchiveId}
          />
        </Card>
      ) : viewMode === 'grid' ? (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {paginatedArchives?.map((archive) => (
              <ArchiveCard
                key={archive.id}
                archive={archive}
                printerName={archive.printer_id ? printerMap.get(archive.printer_id) || 'Unknown' : (archive.sliced_for_model || 'No Printer')}
                isSelected={selectedIds.has(archive.id)}
                onSelect={toggleSelect}
                selectionMode={selectionMode}
                projects={projects}
                isHighlighted={archive.id === highlightedArchiveId}
                timeFormat={timeFormat}
                preferredSlicer={preferredSlicer}
                useSlicerApi={useSlicerApi}
                currency={currency}
                t={t}
                onNavigateToArchive={handleNavigateToArchive}
              />
            ))}
          </div>
          <ArchivePaginationBar
            pageIndex={pageIndex}
            pageSize={pageSize}
            totalRows={totalFiltered}
            totalPages={totalPages}
            onPageChange={setPageIndex}
            onPageSizeChange={(size) => { setPageSize(size); setPageIndex(0); }}
            t={t}
          />
        </>
      ) : viewMode === 'log' ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            {logTruncated ? (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                {t('archives.log.truncatedNote', { limit: LOG_CLIENT_FETCH_LIMIT, total: printLogData?.total ?? 0 })}
              </p>
            ) : <span />}
            <Button
              variant="danger"
              size="sm"
              onClick={() => setShowClearLogConfirm(true)}
              disabled={!hasPermission('archives:delete_all') || clearLogMutation.isPending}
            >
              <Trash2 className="w-4 h-4" />
              {t('archives.log.clearLog')}
            </Button>
          </div>

          <HistoryLogTable
            rows={logRows}
            isLoading={isLogLoading}
            total={logTotal}
            offset={logOffset}
            pageSize={logPageSize}
            onOffsetChange={setLogOffset}
            onPageSizeChange={setLogPageSize}
            archiveById={archiveById}
            selectionMode={selectionMode}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
            timeFormat={timeFormat}
            currency={currency}
            hasActiveFilters={filters.hasActive}
            onResetFilters={filters.clearAll}
            onReprint={setLogReprintArchive}
            onToggleFavourite={(id) => logFavouriteMutation.mutate(id)}
            onDownload={downloadLogArchive}
            onShowInGrid={openArchiveInGrid}
            onEdit={(entry) => {
              setEditingLogEntry(entry);
              setEditingLogFailureReason(entry.failure_reason || '');
              setEditingLogStatus(entry.status);
            }}
            onDelete={setPendingDeleteEntryId}
            busy={{ editing: updateLogEntryMutation.isPending, deleting: deleteLogEntryMutation.isPending }}
          />

        </div>
      ) : null}

      {/* Archive bulk-purge modal (#1008 follow-up) */}
      {showPurgeModal && (
        <PurgeArchivesModal onClose={() => setShowPurgeModal(false)} />
      )}

      {/* Bulk Delete Confirmation */}
      {showBulkDeleteConfirm && (
        <ConfirmModal
          title={t('archives.modal.deleteArchives')}
          message={t('archives.modal.deleteArchivesConfirm', { count: selectedIds.size })}
          confirmText={t('archives.modal.deleteCount', { count: selectedIds.size })}
          variant="danger"
          onConfirm={() => {
            bulkDeleteMutation.mutate(Array.from(selectedIds));
            setShowBulkDeleteConfirm(false);
          }}
          onCancel={() => setShowBulkDeleteConfirm(false)}
        />
      )}

      {/* Batch Tag Modal */}
      {showBatchTag && (
        <BatchTagModal
          selectedIds={Array.from(selectedIds)}
          existingTags={uniqueTags}
          onClose={() => setShowBatchTag(false)}
        />
      )}

      {/* Batch Project Modal */}
      {showBatchProject && (
        <BatchProjectModal
          selectedIds={Array.from(selectedIds)}
          onClose={() => setShowBatchProject(false)}
        />
      )}

      {/* Compare Archives Modal */}
      {showCompareModal && selectedIds.size >= 2 && selectedIds.size <= 5 && (
        <CompareArchivesModal
          archiveIds={Array.from(selectedIds)}
          onClose={() => {
            setShowCompareModal(false);
            setSelectedIds(new Set());
            setIsSelectionMode(false);
          }}
        />
      )}

      {/* Tag Management Modal */}
      {showTagManagement && (
        <TagManagementModal onClose={() => setShowTagManagement(false)} />
      )}

      {/* Clear Log Confirmation */}
      {logReprintArchive && (
        <PrintModal
          mode="create"
          archiveId={logReprintArchive.id}
          archiveName={logReprintArchive.print_name || logReprintArchive.filename}
          onClose={() => setLogReprintArchive(null)}
        />
      )}

      {showClearLogConfirm && (
        <ConfirmModal
          title={t('archives.log.clearLogTitle')}
          message={t('archives.log.clearLogConfirm')}
          confirmText={t('archives.log.clearLogButton')}
          variant="danger"
          onConfirm={() => {
            clearLogMutation.mutate();
            setShowClearLogConfirm(false);
          }}
          onCancel={() => setShowClearLogConfirm(false)}
        />
      )}

      {/* Per-row Print Log entry delete confirmation (#1687) */}
      {pendingDeleteEntryId !== null && (
        <ConfirmModal
          title={t('archives.log.deleteEntryTitle')}
          message={t('archives.log.deleteEntryConfirm')}
          confirmText={t('common.delete')}
          variant="danger"
          onConfirm={() => {
            deleteLogEntryMutation.mutate(pendingDeleteEntryId);
            setPendingDeleteEntryId(null);
          }}
          onCancel={() => setPendingDeleteEntryId(null)}
        />
      )}

      {/* Per-row Print Log classification editor (#1687 part 4).
          Reuses editArchive.failureReasons.* and archives.log.statuses.*
          vocabularies so the dropdown stays in lockstep with the
          Archive Edit modal — backend validates against the same list. */}
      {editingLogEntry !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setEditingLogEntry(null)}
        >
          <div
            className="bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg w-full max-w-md mx-4 p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-white mb-4">
              {t('archives.log.editEntryTitle')}
            </h3>
            <p className="text-xs text-bambu-gray mb-4">
              {t('archives.log.editEntryDescription')}
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm text-bambu-gray mb-1">
                  {t('editArchive.status')}
                </label>
                <ReactSelect
                  value={editingLogStatus}
                  onChange={(e) => setEditingLogStatus(e.target.value)}
                  className="w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded text-white text-sm focus:border-bambu-green focus:outline-none"
                >
                  <option value="completed">{t('archives.log.statuses.completed', { defaultValue: 'completed' })}</option>
                  <option value="failed">{t('archives.log.statuses.failed', { defaultValue: 'failed' })}</option>
                  <option value="stopped">{t('archives.log.statuses.stopped', { defaultValue: 'stopped' })}</option>
                  <option value="cancelled">{t('archives.log.statuses.cancelled', { defaultValue: 'cancelled' })}</option>
                  <option value="skipped">{t('archives.log.statuses.skipped', { defaultValue: 'skipped' })}</option>
                </ReactSelect>
              </div>

              <div>
                <label className="block text-sm text-bambu-gray mb-1">
                  {t('editArchive.failureReason')}
                </label>
                <ReactSelect
                  value={editingLogFailureReason}
                  onChange={(e) => setEditingLogFailureReason(e.target.value)}
                  className="w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded text-white text-sm focus:border-bambu-green focus:outline-none"
                >
                  <option value="">{t('editArchive.selectReason')}</option>
                  {FAILURE_REASON_KEYS.map((key) => (
                    <option key={key} value={key}>
                      {t(`editArchive.failureReasons.${key}`)}
                    </option>
                  ))}
                </ReactSelect>
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <Button
                variant="secondary"
                onClick={() => setEditingLogEntry(null)}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  const body: { failure_reason?: string | null; status?: string } = {};
                  // Send failure_reason only if it changed — empty string
                  // clears the classification (backend stores it as NULL).
                  if (editingLogFailureReason !== (editingLogEntry.failure_reason || '')) {
                    body.failure_reason = editingLogFailureReason || null;
                  }
                  if (editingLogStatus !== editingLogEntry.status) {
                    body.status = editingLogStatus;
                  }
                  if (Object.keys(body).length === 0) {
                    setEditingLogEntry(null);
                    return;
                  }
                  updateLogEntryMutation.mutate({ id: editingLogEntry.id, body });
                }}
                disabled={updateLogEntryMutation.isPending}
              >
                {updateLogEntryMutation.isPending ? t('editArchive.saving') : t('common.save')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* Pagination bar for archives grid/list views */
function ArchivePaginationBar({
  pageIndex, pageSize, totalRows, totalPages, onPageChange, onPageSizeChange, t,
}: {
  pageIndex: number;
  pageSize: number;
  totalRows: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  t: (key: string) => string;
}) {
  const isShowAll = pageSize === -1;
  if (totalPages <= 1 && !isShowAll) return null;
  const effectiveSize = isShowAll ? totalRows || 1 : pageSize;
  return (
    <div className="flex items-center justify-between pt-2 text-sm">
      <span className="text-bambu-gray">
        {isShowAll
          ? `${totalRows} ${t('archives.prints')}`
          : <>{t('archives.pagination.showing')} {pageIndex * effectiveSize + 1} {t('archives.pagination.to')}{' '}
              {Math.min((pageIndex + 1) * effectiveSize, totalRows)}{' '}
              {t('archives.pagination.of')} {totalRows} {t('archives.prints')}</>
        }
      </span>
      <div className="flex items-center gap-2">
        <span className="text-bambu-gray">{t('archives.pagination.show')}</span>
        <ReactSelect
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          className="px-2 py-1 bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded text-white text-sm focus:outline-none focus:border-bambu-green"
        >
          {[25, 50, 100, 200].map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
          <option value={-1}>{t('archives.pagination.all')}</option>
        </ReactSelect>
        {!isShowAll && (
          <>
            <button
              onClick={() => onPageChange(0)}
              disabled={pageIndex === 0}
              className="p-1.5 rounded text-bambu-gray hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronsLeft className="w-4 h-4" />
            </button>
            <button
              onClick={() => onPageChange(Math.max(0, pageIndex - 1))}
              disabled={pageIndex === 0}
              className="p-1.5 rounded text-bambu-gray hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-bambu-gray px-2 whitespace-nowrap">
              {t('archives.pagination.page')} {pageIndex + 1} {t('archives.pagination.of')} {totalPages}
            </span>
            <button
              onClick={() => onPageChange(Math.min(totalPages - 1, pageIndex + 1))}
              disabled={pageIndex >= totalPages - 1}
              className="p-1.5 rounded text-bambu-gray hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            <button
              onClick={() => onPageChange(totalPages - 1)}
              disabled={pageIndex >= totalPages - 1}
              className="p-1.5 rounded text-bambu-gray hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronsRight className="w-4 h-4" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
