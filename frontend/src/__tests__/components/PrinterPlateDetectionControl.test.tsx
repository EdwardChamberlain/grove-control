import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { api, type PlateDetectionResult, type Printer, type PrinterStatus } from '../../api/client';
import { PrinterPlateDetectionControl } from '../../components/printer/PrinterPlateDetectionControl';

const printer = { id: 17, name: 'Test printer' } as Printer;

const checkResult: PlateDetectionResult = {
  is_empty: true,
  confidence: 0.94,
  difference_percent: 1.2,
  message: 'Plate is clear',
  needs_calibration: false,
  reference_count: 1,
  max_references: 5,
  roi: { x: 0.1, y: 0.2, w: 0.7, h: 0.6 },
};

function renderControl(overrides: Partial<React.ComponentProps<typeof PrinterPlateDetectionControl>> = {}) {
  const onToggle = vi.fn();
  render(
    <PrinterPlateDetectionControl
      printer={printer}
      status={{ chamber_light: true } as PrinterStatus}
      enabled={false}
      connected
      canUpdate
      iconControlClass="test-control"
      onToggle={onToggle}
      {...overrides}
    />,
  );
  return { onToggle };
}

describe('PrinterPlateDetectionControl', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getPlateReferences').mockResolvedValue({
      references: [{ index: 0, label: 'Smooth PEI', timestamp: '2025-01-01T00:00:00Z' }],
      max_references: 5,
    });
    vi.spyOn(api, 'getPlateReferenceThumbnailUrl').mockReturnValue('/reference-thumbnail');
  });

  it('keeps the state toggle separate from the management action and respects permissions', async () => {
    const user = userEvent.setup();
    const { onToggle } = renderControl({ canUpdate: false });

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toBeDisabled();
    expect(buttons[1]).toBeDisabled();

    await user.click(buttons[0]);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('shows the plate check result and restores the light when the dialog closes', async () => {
    const user = userEvent.setup();
    const checkPlateEmpty = vi.spyOn(api, 'checkPlateEmpty').mockResolvedValue(checkResult);
    const setChamberLight = vi.spyOn(api, 'setChamberLight').mockResolvedValue({ success: true });

    renderControl({ status: { chamber_light: false } as PrinterStatus });
    await user.click(screen.getAllByRole('button')[1]);

    await waitFor(() => expect(setChamberLight).toHaveBeenCalledWith(printer.id, true));
    await waitFor(() => expect(checkPlateEmpty).toHaveBeenCalledWith(printer.id, { includeDebugImage: true }), { timeout: 3500 });
    expect(await screen.findByText('Plate is clear')).toBeInTheDocument();
    expect(screen.getByText('Smooth PEI')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(setChamberLight).toHaveBeenLastCalledWith(printer.id, false));
  }, 6000);

  it('calibrates an empty plate and refreshes the displayed result', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'checkPlateEmpty')
      .mockResolvedValueOnce({ ...checkResult, needs_calibration: true })
      .mockResolvedValueOnce(checkResult);
    const calibrate = vi.spyOn(api, 'calibratePlateDetection').mockResolvedValue({ success: true, message: 'Saved', index: 1 });

    renderControl();
    await user.click(screen.getAllByRole('button')[1]);
    expect(await screen.findByText(/calibration required/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Calibrate Empty Plate' }));
    await waitFor(() => expect(calibrate).toHaveBeenCalledWith(printer.id, { label: undefined }));
    expect(await screen.findByText('Plate is clear')).toBeInTheDocument();
  });

  it('updates and deletes saved references', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'checkPlateEmpty').mockResolvedValue(checkResult);
    const updateLabel = vi.spyOn(api, 'updatePlateReferenceLabel').mockResolvedValue({ success: true, index: 0, label: 'Textured PEI' });
    const deleteReference = vi.spyOn(api, 'deletePlateReference').mockResolvedValue({ success: true, message: 'Deleted' });

    renderControl();
    await user.click(screen.getAllByRole('button')[1]);
    const label = await screen.findByText('Smooth PEI');
    await user.click(label);
    const input = screen.getByDisplayValue('Smooth PEI');
    await user.clear(input);
    await user.type(input, 'Textured PEI');
    fireEvent.blur(input);
    await waitFor(() => expect(updateLabel).toHaveBeenCalledWith(printer.id, 0, 'Textured PEI'));

    await user.click(screen.getByTitle('Delete reference'));
    await waitFor(() => expect(deleteReference).toHaveBeenCalledWith(printer.id, 0));
  });

  it('saves an edited detection area and refreshes the check result', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'checkPlateEmpty').mockResolvedValue(checkResult);
    const updatePrinter = vi.spyOn(api, 'updatePrinter').mockResolvedValue(printer);

    renderControl();
    await user.click(screen.getAllByRole('button')[1]);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const sliders = screen.getAllByRole('slider');
    fireEvent.change(sliders[0], { target: { value: '0.25' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updatePrinter).toHaveBeenCalledWith(printer.id, {
      plate_detection_roi: { x: 0.25, y: 0.2, w: 0.7, h: 0.6 },
    }));
  });

  it('returns the chamber light to its prior state when a check fails', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'checkPlateEmpty').mockRejectedValue(new Error('Camera unavailable'));
    const setChamberLight = vi.spyOn(api, 'setChamberLight').mockResolvedValue({ success: true });

    renderControl({ status: { chamber_light: false } as PrinterStatus });
    await user.click(screen.getAllByRole('button')[1]);

    await waitFor(() => expect(setChamberLight).toHaveBeenCalledWith(printer.id, true));
    await waitFor(() => expect(setChamberLight).toHaveBeenLastCalledWith(printer.id, false), { timeout: 3500 });
    expect(await screen.findByText('Camera unavailable')).toBeInTheDocument();
  }, 6000);
});
