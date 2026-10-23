import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, type Archive } from '../api/client';
import { useToast } from '../contexts/ToastContext';
import { FolderPickerModal } from './FolderPickerModal';

interface SaveArchiveToFilesModalProps {
  archive: Pick<Archive, 'id' | 'print_name' | 'filename'>;
  onClose: () => void;
}

/**
 * Folder picker + save for the "Save to Files" Archive action. Copies the
 * Archive entry's 3MF into Files; the Archive entry itself is unchanged.
 */
export function SaveArchiveToFilesModal({ archive, onClose }: SaveArchiveToFilesModalProps) {
  const { t } = useTranslation();
  const { showToast, showPersistentToast, dismissToast } = useToast();
  const queryClient = useQueryClient();

  const saveMutation = useMutation({
    mutationFn: (folderId: number | null) => api.saveArchiveToFiles(archive.id, folderId),
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ['library-files'] });
      queryClient.invalidateQueries({ queryKey: ['library-folders'] });
      const name = archive.print_name || archive.filename;
      const toastId = `archive-save-to-files-${archive.id}-${saved.id}`;
      showPersistentToast(
        toastId,
        saved.duplicate_of != null
          ? t('archives.saveToFiles.savedDuplicate', { name })
          : t('archives.saveToFiles.saved', { name }),
        saved.duplicate_of != null ? 'warning' : 'success',
        { action: { label: t('archives.saveToFiles.viewInFiles'), href: '/files' } },
      );
      setTimeout(() => dismissToast(toastId), 10000);
      onClose();
    },
    onError: (error: Error) => {
      showToast(error.message || t('archives.saveToFiles.failed'), 'error');
    },
  });

  return (
    <FolderPickerModal
      title={t('archives.saveToFiles.title')}
      confirmLabel={t('archives.saveToFiles.confirm')}
      isLoading={saveMutation.isPending}
      onConfirm={(folderId) => saveMutation.mutate(folderId)}
      onClose={onClose}
    />
  );
}
