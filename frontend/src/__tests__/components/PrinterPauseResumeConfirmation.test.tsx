import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '../utils';
import { PrinterPauseResumeConfirmation } from '../../components/printer/PrinterPauseResumeConfirmation';

describe('PrinterPauseResumeConfirmation', () => {
  it('renders nothing without an action', () => {
    render(<PrinterPauseResumeConfirmation printerName="X1C" action={null} onConfirm={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it.each([
    ['pause', 'Pause Print'],
    ['resume', 'Resume Print'],
  ] as const)('confirms %s and closes', async (action, button) => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<PrinterPauseResumeConfirmation printerName="X1C" action={action} onConfirm={onConfirm} onClose={onClose} />);

    await userEvent.setup().click(screen.getByRole('button', { name: button }));

    expect(onConfirm).toHaveBeenCalledWith(action);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('cancels without confirming', async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<PrinterPauseResumeConfirmation printerName="X1C" action="pause" onConfirm={onConfirm} onClose={onClose} />);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
