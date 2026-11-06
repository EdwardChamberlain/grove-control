import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { api } from '../api/client';
import { useToast } from '../contexts/ToastContext';

export type PauseResumeAction = 'pause' | 'resume';

/**
 * Stop, pause and resume for one printer, shared by the printer card and the
 * single-printer cockpit so both behave the same way.
 *
 * Also holds the pause/resume confirmation. The dialog closes when the
 * printer's state changes, so it can't send a pause or resume that no longer
 * applies (e.g. the print finished while the dialog was open).
 */
export function usePrintControls(printerId: number, printerState: string | undefined) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const invalidateStatus = () => queryClient.invalidateQueries({ queryKey: ['printerStatus', printerId] });

  const stopPrintMutation = useMutation({
    mutationFn: () => api.stopPrint(printerId),
    onSuccess: () => {
      showToast(t('printers.toast.printStopped'));
      invalidateStatus();
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToStopPrint'), 'error'),
  });

  const pausePrintMutation = useMutation({
    mutationFn: () => api.pausePrint(printerId),
    onSuccess: () => {
      showToast(t('printers.toast.printPaused'));
      invalidateStatus();
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToPausePrint'), 'error'),
  });

  const resumePrintMutation = useMutation({
    mutationFn: () => api.resumePrint(printerId),
    onSuccess: () => {
      showToast(t('printers.toast.printResumed'));
      invalidateStatus();
    },
    onError: (error: Error) => showToast(error.message || t('printers.toast.failedToResumePrint'), 'error'),
  });

  const [pauseResumeConfirm, setPauseResumeConfirm] = useState<PauseResumeAction | null>(null);
  // Close the confirmation when the printer's state changes (React's
  // "adjust state when a prop changes" pattern, no effect needed).
  const [confirmOpenedInState, setConfirmOpenedInState] = useState(printerState);
  if (printerState !== confirmOpenedInState) {
    setConfirmOpenedInState(printerState);
    setPauseResumeConfirm(null);
  }

  return {
    stopPrintMutation,
    pausePrintMutation,
    resumePrintMutation,
    isBusy: stopPrintMutation.isPending || pausePrintMutation.isPending || resumePrintMutation.isPending,
    pauseResumeConfirm,
    requestPauseResume: (action: PauseResumeAction) => setPauseResumeConfirm(action),
    closePauseResume: () => setPauseResumeConfirm(null),
    confirmPauseResume: () => {
      if (pauseResumeConfirm === 'resume') resumePrintMutation.mutate();
      else if (pauseResumeConfirm === 'pause') pausePrintMutation.mutate();
    },
  };
}
