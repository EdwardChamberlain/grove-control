import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { FolderOpen, Loader2 } from 'lucide-react';
import { api, type LibraryFolderTree } from '../api/client';
import { Button } from './Button';

interface FolderPickerModalProps {
  title: string;
  confirmLabel: string;
  isLoading?: boolean;
  /** The folder the item already lives in (`null` = root); it can't be chosen. */
  currentFolderId?: number | null;
  /** `null` is the Files root. */
  onConfirm: (folderId: number | null) => void;
  onClose: () => void;
}

interface FlatFolder {
  id: number | null;
  name: string;
  depth: number;
  readOnly: boolean;
}

function flattenFolders(items: LibraryFolderTree[], depth = 0): FlatFolder[] {
  return items.flatMap((item) => [
    { id: item.id, name: item.name, depth, readOnly: item.is_external && item.external_readonly },
    ...flattenFolders(item.children, depth + 1),
  ]);
}

/**
 * Pick a destination in Files: the root or any folder that accepts new files.
 * Nothing happens until the user confirms; closing leaves everything untouched.
 */
export function FolderPickerModal({
  title,
  confirmLabel,
  isLoading = false,
  currentFolderId,
  onConfirm,
  onClose,
}: FolderPickerModalProps) {
  const { t } = useTranslation();
  const [target, setTarget] = useState<number | null>(null);
  const { data: folders } = useQuery({
    queryKey: ['library-folders'],
    queryFn: () => api.getLibraryFolders(),
  });

  const options: FlatFolder[] = [
    { id: null, name: t('fileManager.rootNoFolder'), depth: 0, readOnly: false },
    // System folders (e.g. the temporary one) aren't somewhere to file things.
    ...flattenFolders((folders ?? []).filter((f) => !f.is_system)),
  ];

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div
        role="dialog"
        aria-label={title}
        className="bg-bambu-dark-secondary rounded-lg w-full max-w-sm border border-bambu-dark-tertiary"
      >
        <div className="p-4 border-b border-bambu-dark-tertiary">
          <h2 className="text-lg font-semibold text-white">{title}</h2>
        </div>
        <div className="p-4 space-y-4">
          <div className="max-h-64 overflow-y-auto space-y-1">
            {options.map((folder) => {
              const isCurrent = currentFolderId !== undefined && folder.id === currentFolderId;
              const disabled = folder.readOnly || isCurrent;
              return (
              <button
                key={folder.id ?? 'root'}
                type="button"
                aria-pressed={target === folder.id}
                onClick={() => setTarget(folder.id)}
                disabled={disabled}
                title={folder.readOnly ? t('fileManager.readOnlyFolder', 'Read-only folder') : undefined}
                className={`w-full text-left px-3 py-2 rounded transition-colors flex items-center gap-2 ${
                  target === folder.id
                    ? 'bg-bambu-green/20 text-bambu-green'
                    : disabled
                    ? 'opacity-50 cursor-not-allowed text-bambu-gray'
                    : 'hover:bg-bambu-dark text-white'
                }`}
                style={{ paddingLeft: `${12 + folder.depth * 16}px` }}
              >
                <FolderOpen className="w-4 h-4" />
                {folder.name}
                {isCurrent && <span className="text-xs text-bambu-gray ml-auto">({t('fileManager.current')})</span>}
              </button>
              );
            })}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="button" onClick={() => onConfirm(target)} disabled={isLoading}>
              {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : confirmLabel}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
