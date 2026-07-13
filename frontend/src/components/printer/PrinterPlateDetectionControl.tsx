import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, Loader2, Pencil, ScanSearch, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, type PlateDetectionResult, type PlateDetectionROI, type Printer, type PrinterStatus } from '../../api/client';
import { Button } from '../Button';
import { useToast } from '../../contexts/ToastContext';
import { parseUTCDate } from '../../utils/date';

interface PlateReference {
  index: number;
  label: string;
  timestamp?: string | null;
}

interface PlateReferences {
  references: PlateReference[];
  max_references: number;
}

interface PrinterPlateDetectionControlProps {
  printer: Printer;
  status?: PrinterStatus | null;
  enabled: boolean;
  connected?: boolean;
  canUpdate: boolean;
  togglePending?: boolean;
  iconControlClass: string;
  activeClassName?: string;
  inactiveClassName?: string;
  dividerClassName?: string;
  iconClassName?: string;
  onToggle: () => void;
}

const defaultRoi: PlateDetectionROI = { x: 0.15, y: 0.35, w: 0.70, h: 0.55 };

export function PrinterPlateDetectionControl({
  printer,
  status,
  enabled,
  connected = false,
  canUpdate,
  togglePending = false,
  iconControlClass,
  activeClassName = 'bg-green-500/10 text-green-400 hover:bg-green-500/20',
  inactiveClassName = 'bg-bambu-dark text-bambu-gray/50 hover:bg-bambu-dark-tertiary hover:text-white',
  dividerClassName = 'border-l border-bambu-dark-tertiary',
  iconClassName = 'h-4 w-4',
  onToggle,
}: PrinterPlateDetectionControlProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [isCheckingPlate, setIsCheckingPlate] = useState(false);
  const [plateCheckResult, setPlateCheckResult] = useState<PlateDetectionResult | null>(null);
  const [plateCheckLightWasOff, setPlateCheckLightWasOff] = useState(false);
  const [plateReferences, setPlateReferences] = useState<PlateReferences | null>(null);
  const [editingRefLabel, setEditingRefLabel] = useState<{ index: number; label: string } | null>(null);
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [editingRoi, setEditingRoi] = useState<PlateDetectionROI | null>(null);
  const [isSavingRoi, setIsSavingRoi] = useState(false);

  const fetchPlateReferences = useCallback(async () => {
    try {
      const refs = await api.getPlateReferences(printer.id);
      setPlateReferences(refs);
    } catch {
      // References are supplementary to the check result.
    }
  }, [printer.id]);

  const closePlateCheckModal = useCallback(async () => {
    setPlateCheckResult(null);
    setEditingRoi(null);
    setEditingRefLabel(null);
    if (plateCheckLightWasOff) {
      await api.setChamberLight(printer.id, false);
      setPlateCheckLightWasOff(false);
    }
  }, [plateCheckLightWasOff, printer.id]);

  const handleOpenPlateManagement = async () => {
    setIsCheckingPlate(true);
    setPlateCheckResult(null);

    const lightWasOff = status?.chamber_light === false;
    setPlateCheckLightWasOff(lightWasOff);
    if (lightWasOff) {
      await api.setChamberLight(printer.id, true);
      await new Promise(resolve => setTimeout(resolve, 2500));
    }

    try {
      const result = await api.checkPlateEmpty(printer.id, { includeDebugImage: true });
      setPlateCheckResult(result);
      fetchPlateReferences();
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('printers.toast.failedToCheckPlate'), 'error');
      if (lightWasOff) {
        await api.setChamberLight(printer.id, false);
        setPlateCheckLightWasOff(false);
      }
    } finally {
      setIsCheckingPlate(false);
    }
  };

  const handleCalibratePlate = async (label?: string) => {
    setIsCalibrating(true);
    try {
      const result = await api.calibratePlateDetection(printer.id, { label });
      if (result.success) {
        showToast(result.message || t('printers.toast.calibrationSaved'), 'success');
        fetchPlateReferences();
        const checkResult = await api.checkPlateEmpty(printer.id, { includeDebugImage: true });
        setPlateCheckResult(checkResult);
      } else {
        showToast(result.message || t('printers.toast.calibrationFailed'), 'error');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('printers.toast.calibrationFailed'), 'error');
    } finally {
      setIsCalibrating(false);
    }
  };

  const handleUpdateRefLabel = async (index: number, label: string) => {
    try {
      await api.updatePlateReferenceLabel(printer.id, index, label);
      setEditingRefLabel(null);
      fetchPlateReferences();
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('printers.toast.failedToUpdateLabel'), 'error');
    }
  };

  const handleDeleteRef = async (index: number) => {
    try {
      await api.deletePlateReference(printer.id, index);
      showToast(t('printers.toast.referenceDeleted'), 'success');
      fetchPlateReferences();
      const checkResult = await api.checkPlateEmpty(printer.id, { includeDebugImage: true });
      setPlateCheckResult(checkResult);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('printers.toast.failedToDeleteReference'), 'error');
    }
  };

  const handleSaveRoi = async () => {
    if (!editingRoi) return;
    setIsSavingRoi(true);
    try {
      await api.updatePrinter(printer.id, { plate_detection_roi: editingRoi });
      showToast(t('printers.toast.detectionAreaSaved'), 'success');
      setEditingRoi(null);
      const checkResult = await api.checkPlateEmpty(printer.id, { includeDebugImage: true });
      setPlateCheckResult(checkResult);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('printers.toast.failedToSaveDetectionArea'), 'error');
    } finally {
      setIsSavingRoi(false);
    }
  };

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && plateCheckResult) {
        closePlateCheckModal();
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [plateCheckResult, closePlateCheckModal]);

  const buttonStateClass = enabled ? activeClassName : inactiveClassName;
  const noPermissionTitle = t('printers.plateDetection.noPermission');

  return (
    <>
      <div className={`inline-flex rounded-lg ${enabled ? 'ring-1 ring-green-500' : ''}`}>
        <button
          type="button"
          onClick={onToggle}
          disabled={!connected || togglePending || !canUpdate}
          className={`${iconControlClass} rounded-r-none ${buttonStateClass}`}
          title={!canUpdate ? noPermissionTitle : (enabled ? t('printers.plateDetection.enabledClick') : t('printers.plateDetection.disabledClick'))}
          aria-label={!canUpdate ? noPermissionTitle : (enabled ? t('printers.plateDetection.enabledClick') : t('printers.plateDetection.disabledClick'))}
        >
          {togglePending ? (
            <Loader2 className={`${iconClassName} animate-spin`} />
          ) : (
            <ScanSearch className={iconClassName} />
          )}
        </button>
        <button
          type="button"
          onClick={handleOpenPlateManagement}
          disabled={!connected || isCheckingPlate || !canUpdate}
          className={`${iconControlClass} rounded-l-none ${dividerClassName} ${buttonStateClass}`}
          title={!canUpdate ? noPermissionTitle : t('printers.plateDetection.manageCalibration')}
          aria-label={!canUpdate ? noPermissionTitle : t('printers.plateDetection.manageCalibration')}
        >
          {isCheckingPlate ? (
            <Loader2 className={`${iconClassName} animate-spin`} />
          ) : (
            <ChevronDown className={iconClassName} />
          )}
        </button>
      </div>

      {plateCheckResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={closePlateCheckModal}>
          <div className="max-h-[90vh] w-full max-w-3xl overflow-hidden rounded-lg bg-bambu-dark-secondary shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-bambu-dark-tertiary p-4">
              <div>
                <h3 className="text-lg font-semibold text-white">
                  {plateCheckResult.needs_calibration
                    ? t('printers.plateDetection.calibration')
                    : plateCheckResult.is_empty
                      ? t('printers.plateDetection.plateEmpty')
                      : t('printers.plateDetection.objectsDetected')}
                </h3>
                {plateCheckResult.reference_count !== undefined && plateCheckResult.max_references && (
                  <p className="mt-1 text-xs text-bambu-gray">
                    {plateCheckResult.reference_count}/{plateCheckResult.max_references} refs
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={closePlateCheckModal}
                className="rounded p-1 text-bambu-gray transition-colors hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="max-h-[calc(90vh-9rem)] space-y-4 overflow-y-auto p-4">
              {plateCheckResult.needs_calibration ? (
                <>
                  <div className="rounded-lg border border-blue-500/50 bg-blue-500/20 p-3">
                    <p className="font-medium text-blue-400">
                      {t('printers.plateDetection.calibrationRequired')}
                    </p>
                    <p className="mt-1 text-sm text-bambu-gray" dangerouslySetInnerHTML={{ __html: t('printers.plateDetection.calibrationInstructions') }} />
                  </div>
                  <div className="space-y-2 text-sm text-bambu-gray">
                    <p>{t('printers.plateDetection.calibrationDescription')}</p>
                    <p dangerouslySetInnerHTML={{ __html: t('printers.plateDetection.calibrationTip') }} />
                  </div>
                </>
              ) : (
                <>
                  <div className={`rounded-lg border p-3 ${plateCheckResult.is_empty ? 'border-green-500/50 bg-green-500/20' : 'border-yellow-500/50 bg-yellow-500/20'}`}>
                    <p className={`font-medium ${plateCheckResult.is_empty ? 'text-green-400' : 'text-yellow-400'}`}>
                      {plateCheckResult.is_empty ? t('printers.plateDetection.plateEmpty') : t('printers.plateDetection.objectsDetected')}
                    </p>
                    <p className="mt-1 text-sm text-bambu-gray">
                      {t('printers.plateDetection.confidence')}: {Math.round(plateCheckResult.confidence * 100)}% | {t('printers.plateDetection.difference')}: {plateCheckResult.difference_percent.toFixed(1)}%
                    </p>
                  </div>
                  {plateCheckResult.debug_image_url && (
                    <div>
                      <p className="mb-2 text-sm text-bambu-gray">{t('printers.plateDetection.analysisPreview')}</p>
                      <img
                        src={plateCheckResult.debug_image_url}
                        alt={t('printers.plateDetection.analysisPreview')}
                        className="w-full rounded-lg border border-bambu-dark-tertiary"
                      />
                      <p className="mt-2 text-xs text-bambu-gray">
                        {t('printers.plateDetection.analysisLegend')}
                      </p>
                    </div>
                  )}
                  <p className="text-xs text-bambu-gray">
                    {plateCheckResult.message}
                  </p>
                </>
              )}

              {plateReferences && plateReferences.references.length > 0 && (
                <div className="mt-4">
                  <div className="mb-2 flex items-center gap-2">
                    <p className="shrink-0 text-sm font-medium text-white">
                      {t('printers.plateDetection.savedReferences', { count: plateReferences.references.length, max: plateReferences.max_references })}
                    </p>
                    <div className="h-[2px] flex-1 bg-bambu-dark-tertiary" />
                  </div>
                  <div className="grid grid-cols-5 gap-2">
                    {plateReferences.references.map((ref) => (
                      <div key={ref.index} className="group relative">
                        <img
                          src={api.getPlateReferenceThumbnailUrl(printer.id, ref.index)}
                          alt={ref.label || `Reference ${ref.index + 1}`}
                          className="aspect-video w-full rounded border border-bambu-dark-tertiary object-cover"
                        />
                        <button
                          type="button"
                          onClick={() => handleDeleteRef(ref.index)}
                          className="absolute right-1 top-1 rounded bg-red-500/80 p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                          title={t('printers.plateDetection.deleteReference')}
                        >
                          <X className="h-3 w-3 text-white" />
                        </button>
                        {editingRefLabel?.index === ref.index ? (
                          <input
                            type="text"
                            value={editingRefLabel.label}
                            onChange={(e) => setEditingRefLabel({ ...editingRefLabel, label: e.target.value })}
                            onBlur={() => handleUpdateRefLabel(ref.index, editingRefLabel.label)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleUpdateRefLabel(ref.index, editingRefLabel.label);
                              if (e.key === 'Escape') setEditingRefLabel(null);
                            }}
                            className="mt-1 w-full rounded border border-bambu-green bg-bambu-dark-tertiary px-1 py-0.5 text-xs text-white"
                            autoFocus
                            placeholder={t('printers.plateDetection.labelPlaceholder')}
                          />
                        ) : (
                          <p
                            className="mt-1 cursor-pointer truncate text-xs text-bambu-gray hover:text-white"
                            onClick={() => setEditingRefLabel({ index: ref.index, label: ref.label })}
                            title={ref.label ? t('printers.plateDetection.clickToEdit', { label: ref.label }) : t('printers.plateDetection.clickToAddLabel')}
                          >
                            {ref.label || <span className="italic opacity-50">{t('printers.noLabel')}</span>}
                          </p>
                        )}
                        <p className="text-[10px] text-bambu-gray/60">
                          {ref.timestamp ? parseUTCDate(ref.timestamp)?.toLocaleDateString() ?? '' : ''}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {!plateCheckResult.needs_calibration && (
                <div className="mt-4">
                  <div className="mb-2 flex items-center justify-between">
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <p className="shrink-0 text-sm font-medium text-white">{t('printers.roi.title')}</p>
                      <div className="h-[2px] flex-1 bg-bambu-dark-tertiary" />
                    </div>
                    {!editingRoi ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditingRoi(plateCheckResult.roi || defaultRoi)}
                      >
                        <Pencil className="mr-1 h-3 w-3" />
                        {t('common.edit')}
                      </Button>
                    ) : (
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditingRoi(null)}
                          disabled={isSavingRoi}
                        >
                          {t('common.cancel')}
                        </Button>
                        <Button
                          size="sm"
                          onClick={handleSaveRoi}
                          disabled={isSavingRoi}
                        >
                          {isSavingRoi ? <Loader2 className="h-3 w-3 animate-spin" /> : t('common.save')}
                        </Button>
                      </div>
                    )}
                  </div>
                  {editingRoi ? (
                    <div className="space-y-3 rounded-lg bg-bambu-dark-tertiary/50 p-3">
                      <div className="grid grid-cols-2 gap-3">
                        {([
                          ['x', t('printers.roi.xStart'), 0, 0.9],
                          ['y', t('printers.roi.yStart'), 0, 0.9],
                          ['w', t('printers.width'), 0.1, 1],
                          ['h', t('printers.height'), 0.1, 1],
                        ] as const).map(([key, label, min, max]) => (
                          <div key={key}>
                            <label className="text-xs text-bambu-gray">{label}</label>
                            <input
                              type="range"
                              min={min}
                              max={max}
                              step="0.01"
                              value={editingRoi[key]}
                              onChange={(e) => setEditingRoi({ ...editingRoi, [key]: parseFloat(e.target.value) })}
                              className="h-1.5 w-full cursor-pointer rounded-lg bg-bambu-dark-tertiary accent-green-500"
                            />
                            <span className="text-xs text-bambu-gray">{Math.round(editingRoi[key] * 100)}%</span>
                          </div>
                        ))}
                      </div>
                      <p className="text-xs text-bambu-gray">
                        {t('printers.roi.instruction')}
                      </p>
                    </div>
                  ) : (
                    <p className="text-xs text-bambu-gray">
                      Current: X={Math.round((plateCheckResult.roi?.x || defaultRoi.x) * 100)}%, Y={Math.round((plateCheckResult.roi?.y || defaultRoi.y) * 100)}%,
                      W={Math.round((plateCheckResult.roi?.w || defaultRoi.w) * 100)}%, H={Math.round((plateCheckResult.roi?.h || defaultRoi.h) * 100)}%
                    </p>
                  )}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 p-4">
              {plateCheckResult.needs_calibration ? (
                <>
                  <Button variant="ghost" onClick={() => closePlateCheckModal()}>
                    {t('common.cancel')}
                  </Button>
                  <Button
                    onClick={() => handleCalibratePlate()}
                    disabled={isCalibrating}
                  >
                    {isCalibrating ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Calibrating...
                      </>
                    ) : (
                      'Calibrate Empty Plate'
                    )}
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="ghost" onClick={() => handleCalibratePlate()} disabled={isCalibrating}>
                    {isCalibrating ? 'Adding...' : `Add Reference (${plateReferences?.references.length || 0}/${plateReferences?.max_references || 5})`}
                  </Button>
                  <Button onClick={() => closePlateCheckModal()}>
                    Close
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
