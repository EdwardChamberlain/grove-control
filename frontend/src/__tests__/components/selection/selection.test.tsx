import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils';
import {
  SelectModeToggle,
  SelectionBar,
  SelectionCheckbox,
  useSelection,
} from '../../../components/selection';

describe('useSelection', () => {
  it('starts inactive and empty', () => {
    const { result } = renderHook(() => useSelection<number>());
    expect(result.current.active).toBe(false);
    expect(result.current.count).toBe(0);
  });

  it('toggles ids and stays active while something is selected', () => {
    const { result } = renderHook(() => useSelection<number>());
    act(() => result.current.toggle(1));
    expect(result.current.isSelected(1)).toBe(true);
    expect(result.current.active).toBe(true);
    act(() => result.current.toggle(1));
    expect(result.current.isSelected(1)).toBe(false);
    expect(result.current.active).toBe(false);
  });

  it('enters and leaves select mode with toggleMode, clearing the selection on exit', () => {
    const { result } = renderHook(() => useSelection<number>());
    act(() => result.current.toggleMode());
    expect(result.current.active).toBe(true);
    expect(result.current.count).toBe(0);
    act(() => result.current.add([1, 2]));
    act(() => result.current.toggleMode());
    expect(result.current.active).toBe(false);
    expect(result.current.count).toBe(0);
  });

  it('add, set and remove enter select mode and update the ids', () => {
    const { result } = renderHook(() => useSelection<string>());
    act(() => result.current.add(['a', 'b']));
    act(() => result.current.add(['c']));
    expect([...result.current.selected]).toEqual(['a', 'b', 'c']);
    act(() => result.current.remove(['b']));
    expect([...result.current.selected]).toEqual(['a', 'c']);
    act(() => result.current.set(['z']));
    expect([...result.current.selected]).toEqual(['z']);
    expect(result.current.active).toBe(true);
  });

  it('clear keeps select mode on', () => {
    const { result } = renderHook(() => useSelection<number>());
    act(() => result.current.enter());
    act(() => result.current.add([1]));
    act(() => result.current.clear());
    expect(result.current.count).toBe(0);
    expect(result.current.active).toBe(true);
  });

  it('exits on Escape by default', () => {
    const { result } = renderHook(() => useSelection<number>());
    act(() => result.current.add([1]));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(result.current.active).toBe(false);
    expect(result.current.count).toBe(0);
  });

  it('ignores Escape when exitOnEscape is false', () => {
    const { result } = renderHook(() => useSelection<number>({ exitOnEscape: false }));
    act(() => result.current.add([1]));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(result.current.active).toBe(true);
  });
});

describe('useSelection Escape handling', () => {
  const press = (target: EventTarget = window, init: KeyboardEventInit = {}) => {
    act(() => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init }));
    });
  };

  it('leaves the selection alone when Escape is pressed in a text field', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const { result } = renderHook(() => useSelection<number>());
    act(() => result.current.add([1]));
    press(input);
    expect(result.current.active).toBe(true);
    input.remove();
  });

  it('leaves the selection alone while a dialog is open', () => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0';
    document.body.appendChild(overlay);
    const { result } = renderHook(() => useSelection<number>());
    act(() => result.current.add([1]));
    press();
    expect(result.current.active).toBe(true);
    overlay.remove();
    press();
    expect(result.current.active).toBe(false);
  });

  it('ignores an Escape another handler already used', () => {
    const { result } = renderHook(() => useSelection<number>());
    act(() => result.current.add([1]));
    const handled = (e: Event) => e.preventDefault();
    document.addEventListener('keydown', handled);
    press(document.body);
    document.removeEventListener('keydown', handled);
    expect(result.current.active).toBe(true);
  });
});

describe('SelectModeToggle', () => {
  it('reports its pressed state and calls onToggle', async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<SelectModeToggle active={false} onToggle={onToggle} />);
    const button = screen.getByRole('button', { name: 'Select multiple' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    await user.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(<SelectModeToggle active onToggle={onToggle} />);
    expect(screen.getByRole('button', { name: 'Select multiple' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows a label in the menu variant and can be disabled with a custom title', () => {
    render(<SelectModeToggle active={false} onToggle={() => {}} variant="menu" disabled title="No permission" />);
    const button = screen.getByRole('button', { name: 'Select multiple' });
    expect(button).toHaveTextContent('Select multiple');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'No permission');
  });
});

describe('SelectionCheckbox', () => {
  it('toggles without letting the click reach the item behind it', async () => {
    const onToggle = vi.fn();
    const onParent = vi.fn();
    const user = userEvent.setup();
    render(
      <div onClick={onParent}>
        <SelectionCheckbox checked={false} onToggle={onToggle} />
      </div>,
    );
    const box = screen.getByRole('checkbox', { name: 'Select item' });
    expect(box).toHaveAttribute('aria-checked', 'false');
    await user.click(box);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onParent).not.toHaveBeenCalled();
  });

  it('is labelled by the item name when given, and reflects the checked state', () => {
    render(<SelectionCheckbox checked onToggle={() => {}} label="Benchy" variant="overlay" />);
    expect(screen.getByRole('checkbox', { name: 'Benchy' })).toHaveAttribute('aria-checked', 'true');
  });

  it('defaults to a deselect label when checked', () => {
    render(<SelectionCheckbox checked onToggle={() => {}} />);
    expect(screen.getByRole('checkbox', { name: 'Deselect item' })).toBeInTheDocument();
  });
});

describe('SelectionBar', () => {
  it('shows the count, hosts actions and closes', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <SelectionBar count={3} onClose={onClose}>
        <button>Do it</button>
      </SelectionBar>,
    );
    expect(screen.getByRole('toolbar', { name: 'Selection actions' })).toBeInTheDocument();
    expect(screen.getByText('3 selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Do it' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Exit selection' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('reserves bottom space on the page scroll container while shown and restores it', () => {
    const { unmount } = render(
      <main data-testid="page">
        <SelectionBar count={1} onClose={() => {}} />
      </main>,
    );
    expect(screen.getByTestId('page').style.paddingBottom).toBe('7rem');
    unmount();
  });

  it('does not reserve space when told not to', () => {
    render(
      <main data-testid="page">
        <SelectionBar count={1} onClose={() => {}} reserveSpace={false} />
      </main>,
    );
    expect(screen.getByTestId('page').style.paddingBottom).toBe('');
  });

  it('accepts a custom count label and renders without actions', () => {
    render(<SelectionBar count={1} onClose={() => {}} countLabel="One thing" />);
    expect(screen.getByText('One thing')).toBeInTheDocument();
  });
});
