/**
 * VirtualKeyboard: appears for text inputs, types into controlled inputs,
 * shift / backspace / space keys, and dismissal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { VirtualKeyboard } from '../../components/VirtualKeyboard';

function Harness({ onVisibility }: { onVisibility?: (v: boolean) => void }) {
  const [value, setValue] = useState('');
  return (
    <div>
      <input aria-label="name" value={value} onChange={(e) => setValue(e.target.value)} />
      <input aria-label="check" type="checkbox" />
      <div data-vkb="false">
        <input aria-label="opt-out" />
      </div>
      <textarea aria-label="notes" />
      <button>outside</button>
      <VirtualKeyboard onVisibilityChange={onVisibility} />
    </div>
  );
}

function key(button: string) {
  const el = document.querySelector(`[data-skbtn="${button}"]`) as HTMLElement;
  // simple-keyboard reacts to pointer / mouse down on its buttons.
  fireEvent.pointerDown(el);
  fireEvent.mouseDown(el);
  fireEvent.click(el);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('VirtualKeyboard', () => {
  it('opens for text inputs only', () => {
    const onVisibility = vi.fn();
    render(<Harness onVisibility={onVisibility} />);

    act(() => screen.getByLabelText('check').focus());
    act(() => screen.getByLabelText('opt-out').focus());
    expect(document.querySelector('.simple-keyboard')).toBeNull();

    act(() => screen.getByLabelText('notes').focus());
    expect(document.querySelector('.simple-keyboard')).not.toBeNull();
    act(() => vi.advanceTimersByTime(150));
    expect(onVisibility).toHaveBeenLastCalledWith(true);
  });

  it('types, shifts, deletes and adds spaces', () => {
    render(<Harness />);
    const input = screen.getByLabelText('name') as HTMLInputElement;
    act(() => input.focus());

    act(() => key('h'));
    act(() => key('{shift}'));
    act(() => key('I'));
    act(() => key('{space}'));
    act(() => key('x'));
    act(() => key('{bksp}'));
    act(() => key('{lock}'));
    act(() => key('Q'));

    expect(input.value).toBe('hI Q');
  });

  it('closes with the close key after the ghost-click delay', () => {
    const onVisibility = vi.fn();
    render(<Harness onVisibility={onVisibility} />);
    act(() => screen.getByLabelText('name').focus());

    act(() => key('{close}'));
    act(() => vi.advanceTimersByTime(450));

    expect(document.querySelector('.simple-keyboard')).toBeNull();
    expect(onVisibility).toHaveBeenLastCalledWith(false);
  });

  it('closes when the backdrop is tapped', () => {
    render(<Harness />);
    act(() => screen.getByLabelText('name').focus());

    const backdrop = document.querySelector('.fixed.inset-0') as HTMLElement;
    fireEvent.mouseDown(backdrop);
    fireEvent.touchStart(backdrop);
    fireEvent.click(backdrop);
    act(() => vi.advanceTimersByTime(450));

    expect(document.querySelector('.simple-keyboard')).toBeNull();
  });

  it('hides when focus moves elsewhere', () => {
    render(<Harness />);
    act(() => screen.getByLabelText('name').focus());

    act(() => screen.getByText('outside').focus());
    act(() => vi.advanceTimersByTime(200));

    expect(document.querySelector('.simple-keyboard')).toBeNull();
  });
});
