import { useTranslation } from 'react-i18next';
import { ConfirmModal } from '../ConfirmModal';

interface PrinterStopPrintConfirmationProps {
  printerName: string;
  isOpen: boolean;
  onStop: () => void;
  onClose: () => void;
}

export function PrinterStopPrintConfirmation({
  printerName,
  isOpen,
  onStop,
  onClose,
}: PrinterStopPrintConfirmationProps) {
  const { t } = useTranslation();

  if (!isOpen) return null;

  return (
    <ConfirmModal
      title={t('printers.confirm.stopTitle')}
      message={t('printers.confirm.stopMessage', { name: printerName })}
      confirmText={t('printers.confirm.stopButton')}
      variant="danger"
      onConfirm={() => {
        onStop();
        onClose();
      }}
      onCancel={onClose}
    />
  );
}
