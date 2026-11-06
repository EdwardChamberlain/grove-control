import { useTranslation } from 'react-i18next';
import { ConfirmModal } from '../ConfirmModal';
import type { PauseResumeAction } from '../../hooks/usePrintControls';

interface PrinterPauseResumeConfirmationProps {
  printerName: string;
  /** Which confirmation to show; null renders nothing. */
  action: PauseResumeAction | null;
  onConfirm: () => void;
  onClose: () => void;
}

export function PrinterPauseResumeConfirmation({
  printerName,
  action,
  onConfirm,
  onClose,
}: PrinterPauseResumeConfirmationProps) {
  const { t } = useTranslation();

  if (!action) return null;

  const isPause = action === 'pause';

  return (
    <ConfirmModal
      title={isPause ? t('printers.confirm.pauseTitle') : t('printers.confirm.resumeTitle')}
      message={
        isPause
          ? t('printers.confirm.pauseMessage', { name: printerName })
          : t('printers.confirm.resumeMessage', { name: printerName })
      }
      confirmText={isPause ? t('printers.confirm.pauseButton') : t('printers.confirm.resumeButton')}
      variant="default"
      onConfirm={() => {
        onConfirm();
        onClose();
      }}
      onCancel={onClose}
    />
  );
}
