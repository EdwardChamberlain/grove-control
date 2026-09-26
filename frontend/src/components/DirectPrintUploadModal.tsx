import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import type { LibraryFileUploadResponse } from '../api/client';
import { isDirectPrintFile } from '../utils/directPrint';
import { FileUploadModal } from './FileUploadModal';

interface DirectPrintUploadModalProps {
  onClose: () => void;
  onFileUploaded: (file: LibraryFileUploadResponse) => string | void;
  beforeDropZone?: ReactNode;
}

/** Shared single-file upload step for printer-card Print and queue Add Job. */
export function DirectPrintUploadModal({ onClose, onFileUploaded, beforeDropZone }: DirectPrintUploadModalProps) {
  const { t } = useTranslation();
  const printableFileHint = t('printers.dropNotPrintable', 'Only .gcode and .gcode.3mf files can be printed');

  return (
    <FileUploadModal
      folderId={null}
      onClose={onClose}
      onUploadComplete={() => {}}
      onFileUploaded={onFileUploaded}
      uploadFile={api.uploadQueueSource}
      beforeDropZone={beforeDropZone}
      autoUpload
      singleFile
      accept=".gcode,.3mf"
      dropZoneHint={(
        <>
          <span>{printableFileHint}</span>
          <span className="mt-1 block">{t('printers.directUploadLibraryNote', 'This upload is added to Queue and is not saved in Files.')}</span>
        </>
      )}
      validateFile={(file) => (isDirectPrintFile(file) ? undefined : printableFileHint)}
    />
  );
}
