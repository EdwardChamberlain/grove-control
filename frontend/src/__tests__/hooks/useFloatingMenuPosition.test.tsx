import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { floatingMenuStyle, useFloatingMenuPosition } from '../../hooks/useFloatingMenuPosition';
import { ReactSelect, ToolbarDropdown } from '../../components/ToolbarControls';

const VIEWPORT_HEIGHT = 800;

function rect(top: number, height = 32, left = 100, width = 120): DOMRect {
  return {
    top,
    bottom: top + height,
    left,
    right: left + width,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function fakeTrigger(top: number) {
  const el = document.createElement('button');
  el.getBoundingClientRect = () => rect(top);
  return el;
}

function fakeMenu(contentHeight: number) {
  const el = document.createElement('div');
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: contentHeight });
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: contentHeight + 2 });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: contentHeight });
  return el;
}

function position(triggerTop: number, menuHeight: number) {
  const triggerRef = { current: fakeTrigger(triggerTop) as HTMLElement | null };
  const menuRef = { current: fakeMenu(menuHeight) as HTMLElement | null };
  return renderHook(({ open }) => useFloatingMenuPosition(open, triggerRef, menuRef), {
    initialProps: { open: true },
  });
}

describe('useFloatingMenuPosition', () => {
  beforeEach(() => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(VIEWPORT_HEIGHT);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens below the trigger when the menu fits', () => {
    const { result } = position(100, 200);

    expect(result.current).toMatchObject({
      placement: 'below',
      top: 136,
      left: 100,
      minWidth: 120,
      maxHeight: 288,
    });
    expect(result.current.bottom).toBeUndefined();
  });

  it('opens above the trigger when there is no room below', () => {
    // Trigger spans 720–752, leaving 36px below and 708px above.
    const { result } = position(720, 200);

    expect(result.current).toMatchObject({
      placement: 'above',
      bottom: VIEWPORT_HEIGHT - 720 + 4,
      maxHeight: 288,
    });
    expect(result.current.top).toBeUndefined();
  });

  it('stays below when there is even less room above', () => {
    // 64px above, 132px below: a 200px menu fits neither, so use the larger side.
    const { result } = position(72, 200);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(248);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    expect(result.current.placement).toBe('below');
    expect(result.current.maxHeight).toBe(248 - 104 - 4 - 8);
  });

  it('caps the height to the space above when opening upwards', () => {
    // 200px above, 36px below.
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(276);
    const { result } = position(212, 400);

    expect(result.current.placement).toBe('above');
    expect(result.current.maxHeight).toBe(212 - 4 - 8);
  });

  it('repositions on scroll and stops listening once closed', () => {
    const trigger = fakeTrigger(100);
    const triggerRef = { current: trigger as HTMLElement | null };
    const menuRef = { current: fakeMenu(200) as HTMLElement | null };
    const { result, rerender } = renderHook(
      ({ open }) => useFloatingMenuPosition(open, triggerRef, menuRef),
      { initialProps: { open: true } },
    );
    expect(result.current.placement).toBe('below');

    trigger.getBoundingClientRect = () => rect(740);
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.placement).toBe('above');

    rerender({ open: false });
    trigger.getBoundingClientRect = () => rect(100);
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.placement).toBe('above');
  });

  it('does nothing without a trigger element', () => {
    const triggerRef = { current: null };
    const menuRef = { current: null };
    const { result } = renderHook(() => useFloatingMenuPosition(true, triggerRef, menuRef));

    expect(result.current).toMatchObject({ placement: 'below', top: 0, left: 0 });
  });

  it('builds an inline style from the position', () => {
    expect(
      floatingMenuStyle({ left: 1, bottom: 2, minWidth: 3, maxHeight: 4, placement: 'above' }),
    ).toEqual({ left: 1, top: undefined, bottom: 2, minWidth: 3, maxHeight: 4 });
  });
});

describe('dropdowns near the bottom of the screen', () => {
  beforeEach(() => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(VIEWPORT_HEIGHT);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect(740));
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(200);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ReactSelect opens its listbox upwards', async () => {
    const user = userEvent.setup();
    render(
      <ReactSelect aria-label="Show" value="25" onChange={vi.fn()}>
        <option value="25">25</option>
        <option value="50">50</option>
        <option value="-1">All</option>
      </ReactSelect>,
    );

    await user.click(screen.getByRole('combobox', { name: 'Show' }));
    const listbox = screen.getByRole('listbox');

    expect(listbox).toHaveAttribute('data-placement', 'above');
    expect(listbox.style.bottom).toBe(`${VIEWPORT_HEIGHT - 740 + 4}px`);
    expect(listbox.style.top).toBe('');
  });

  it('ToolbarDropdown opens its menu upwards', async () => {
    const user = userEvent.setup();
    render(
      <ToolbarDropdown
        value="a"
        options={[{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }]}
        onChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Alpha' }));
    const menu = screen.getByRole('button', { name: 'Beta' }).parentElement as HTMLElement;

    expect(menu).toHaveAttribute('data-placement', 'above');
    expect(menu.style.top).toBe('');
  });
});
