import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '../utils';
import { floatingMenuStyle, useFloatingMenuPosition } from '../../hooks/useFloatingMenuPosition';

const VIEWPORT_HEIGHT = 800;
const VIEWPORT_WIDTH = 1000;

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

function fakeTrigger(top: number, left = 100) {
  const el = document.createElement('button');
  el.getBoundingClientRect = () => rect(top, 32, left);
  return el;
}

function fakeMenu(contentHeight: number, width = 0) {
  const el = document.createElement('div');
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: contentHeight });
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: contentHeight + 2 });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: contentHeight });
  // Mimics a fixed box: it is as wide as its content, but no wider than its
  // max-width or the space to the right of its `left`.
  el.getBoundingClientRect = () => {
    if (!width) return rect(0, 0, 0, 0);
    const cap = el.style.maxWidth && el.style.maxWidth !== 'none' ? parseFloat(el.style.maxWidth) : Infinity;
    const room = VIEWPORT_WIDTH - (parseFloat(el.style.left) || 0);
    return rect(0, contentHeight, 0, Math.min(width, cap, room));
  };
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
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(VIEWPORT_WIDTH);
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

  it('measures again when the content key changes', () => {
    // 36px below the trigger and 708px above.
    const triggerRef = { current: fakeTrigger(720) as HTMLElement | null };
    const menu = fakeMenu(20);
    const menuRef = { current: menu as HTMLElement | null };
    const { result, rerender } = renderHook(
      ({ key }) => useFloatingMenuPosition(true, triggerRef, menuRef, { contentKey: key }),
      { initialProps: { key: 'one option' } },
    );
    expect(result.current.placement).toBe('below');

    Object.defineProperty(menu, 'scrollHeight', { configurable: true, value: 200 });
    rerender({ key: 'one option' });
    expect(result.current.placement).toBe('below');

    rerender({ key: 'five options' });
    expect(result.current.placement).toBe('above');
  });

  it('reports a trigger scrolled out of view instead of positioning against it', () => {
    const trigger = fakeTrigger(100);
    const triggerRef = { current: trigger as HTMLElement | null };
    const menuRef = { current: fakeMenu(200) as HTMLElement | null };
    const onTriggerHidden = vi.fn();
    const { result } = renderHook(() => useFloatingMenuPosition(true, triggerRef, menuRef, { onTriggerHidden }));
    const before = result.current;

    trigger.getBoundingClientRect = () => rect(-40);
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(onTriggerHidden).toHaveBeenCalledTimes(1);

    trigger.getBoundingClientRect = () => rect(VIEWPORT_HEIGHT);
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(onTriggerHidden).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(before);
  });

  it('does not treat a trigger that is not laid out as scrolled away', () => {
    const trigger = document.createElement('button');
    trigger.getBoundingClientRect = () => ({ ...rect(0), bottom: 0, height: 0, width: 0 }) as DOMRect;
    const onTriggerHidden = vi.fn();
    renderHook(() => useFloatingMenuPosition(true, { current: trigger }, { current: fakeMenu(50) }, { onTriggerHidden }));

    expect(onTriggerHidden).not.toHaveBeenCalled();
  });

  it('ignores scrolling inside the menu', () => {
    const trigger = fakeTrigger(100);
    const menu = fakeMenu(200);
    const item = document.createElement('div');
    menu.appendChild(item);
    document.body.appendChild(menu);
    const getRect = vi.fn(() => rect(100));
    trigger.getBoundingClientRect = getRect;
    renderHook(() => useFloatingMenuPosition(true, { current: trigger }, { current: menu }));
    const callsAfterOpen = getRect.mock.calls.length;

    act(() => {
      item.dispatchEvent(new Event('scroll', { bubbles: true }));
      menu.dispatchEvent(new Event('scroll'));
    });
    expect(getRect).toHaveBeenCalledTimes(callsAfterOpen);

    act(() => {
      document.body.dispatchEvent(new Event('scroll'));
    });
    expect(getRect).toHaveBeenCalledTimes(callsAfterOpen + 1);
    menu.remove();
  });

  it('keeps the same position object when nothing has moved', () => {
    const { result } = position(100, 200);
    const before = result.current;

    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });

    expect(result.current).toBe(before);
  });

  it('still opens, and does not close, when the trigger starts off screen', () => {
    // e.g. a focused select scrolled out of view, then opened from the keyboard.
    const trigger = fakeTrigger(-200);
    const onTriggerHidden = vi.fn();
    const { result } = renderHook(() =>
      useFloatingMenuPosition(true, { current: trigger }, { current: fakeMenu(100) }, { onTriggerHidden }),
    );

    expect(onTriggerHidden).not.toHaveBeenCalled();
    expect(result.current.placement).toBe('below');

    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(onTriggerHidden).not.toHaveBeenCalled();
  });

  it('measures against the visible height, leaving out a horizontal scrollbar', () => {
    // innerHeight is 800 but a 15px scrollbar leaves 785px visible.
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(785);
    const { result } = position(720, 200);

    expect(result.current).toMatchObject({ placement: 'above', bottom: 785 - 720 + 4 });
  });

  it('never shrinks the menu below one row', () => {
    // A 60px-tall screen with the trigger filling most of it.
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(60);
    const { result } = position(10, 200);

    expect(result.current.maxHeight).toBe(40);
  });

  it('shifts left so a menu overflowing the right edge stays inside the viewport', () => {
    // Trigger starts at 900; a 200px menu would reach 1100 on a 1000px screen.
    const triggerRef = { current: fakeTrigger(100, 900) as HTMLElement | null };
    const menuRef = { current: fakeMenu(100, 200) as HTMLElement | null };
    const { result } = renderHook(() => useFloatingMenuPosition(true, triggerRef, menuRef));

    expect(result.current).toMatchObject({ left: VIEWPORT_WIDTH - 8 - 200, placement: 'below' });
    expect(result.current.maxWidth).toBeUndefined();
  });

  it('clamps a menu wider than the viewport to the left margin with a max width', () => {
    const triggerRef = { current: fakeTrigger(100, 900) as HTMLElement | null };
    const menuRef = { current: fakeMenu(100, 1200) as HTMLElement | null };
    const { result } = renderHook(() => useFloatingMenuPosition(true, triggerRef, menuRef));

    expect(result.current).toMatchObject({ left: 8, maxWidth: VIEWPORT_WIDTH - 2 * 8 });
  });

  it('keeps the trigger left edge for a menu that fits', () => {
    const triggerRef = { current: fakeTrigger(100, 100) as HTMLElement | null };
    const menuRef = { current: fakeMenu(100, 200) as HTMLElement | null };
    const { result } = renderHook(() => useFloatingMenuPosition(true, triggerRef, menuRef));

    expect(result.current).toMatchObject({ left: 100, minWidth: 120 });
    expect(result.current.maxWidth).toBeUndefined();
  });

  it('keeps the trigger left edge when the menu ends exactly on the margin', () => {
    // 780 + 212 = 992 = 1000 - 8: fits with no shift.
    const triggerRef = { current: fakeTrigger(100, 780) as HTMLElement | null };
    const menuRef = { current: fakeMenu(100, 212) as HTMLElement | null };
    const { result } = renderHook(() => useFloatingMenuPosition(true, triggerRef, menuRef));

    expect(result.current.left).toBe(780);
  });

  it('measures the trigger width when the menu has not been laid out', () => {
    // offsetWidth is 0 before layout, so the 120px trigger width stands in for it:
    // 880 + 120 overflows the 992px limit, so it shifts to 1000 - 8 - 120.
    const triggerRef = { current: fakeTrigger(100, 880) as HTMLElement | null };
    const menuRef = { current: fakeMenu(100) as HTMLElement | null };
    const { result } = renderHook(() => useFloatingMenuPosition(true, triggerRef, menuRef));

    expect(result.current.left).toBe(VIEWPORT_WIDTH - 8 - 120);
  });

  it('shifts a menu again when the viewport narrows on resize', () => {
    const triggerRef = { current: fakeTrigger(100, 100) as HTMLElement | null };
    const menuRef = { current: fakeMenu(100, 200) as HTMLElement | null };
    const { result } = renderHook(() => useFloatingMenuPosition(true, triggerRef, menuRef));
    expect(result.current.left).toBe(100);

    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(300);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current.left).toBe(300 - 8 - 200);
  });

  it('measures the natural width and restores the menu styles afterwards', () => {
    const triggerRef = { current: fakeTrigger(100, 900) as HTMLElement | null };
    const menu = fakeMenu(100, 200);
    menu.style.left = '500px';
    menu.style.maxWidth = '50px';
    renderHook(() => useFloatingMenuPosition(true, triggerRef, { current: menu }));

    expect(menu.style.left).toBe('500px');
    expect(menu.style.maxWidth).toBe('50px');
  });

  it('stays pinned across repeated scrolls when wider than the viewport', () => {
    const triggerRef = { current: fakeTrigger(100, 900) as HTMLElement | null };
    const menu = fakeMenu(100, 1200);
    const { result } = renderHook(() => useFloatingMenuPosition(true, triggerRef, { current: menu }));
    for (let i = 0; i < 3; i++) {
      // Apply the styles the way the component would between events.
      Object.assign(menu.style, { left: `${result.current.left}px`, maxWidth: `${result.current.maxWidth}px` });
      act(() => {
        window.dispatchEvent(new Event('scroll'));
      });
      expect(result.current).toMatchObject({ left: 8, maxWidth: VIEWPORT_WIDTH - 16 });
    }
  });

  it('uses the natural width when re-measured at a large left', () => {
    const triggerRef = { current: fakeTrigger(100, 900) as HTMLElement | null };
    const menu = fakeMenu(100, 300);
    menu.style.left = '900px'; // only 100px of room here, so it would measure narrow
    const { result } = renderHook(() => useFloatingMenuPosition(true, triggerRef, { current: menu }));

    expect(result.current.left).toBe(VIEWPORT_WIDTH - 8 - 300);
  });

  it('counts the trigger width when the content is narrower', () => {
    const triggerRef = { current: fakeTrigger(100, 880) as HTMLElement | null };
    const menuRef = { current: fakeMenu(100, 34) as HTMLElement | null };
    const { result } = renderHook(() => useFloatingMenuPosition(true, triggerRef, menuRef));

    expect(result.current.left).toBe(VIEWPORT_WIDTH - 8 - 120);
  });

  it('clamps a trigger that starts left of the viewport to the margin', () => {
    const triggerRef = { current: fakeTrigger(100, -50) as HTMLElement | null };
    const menuRef = { current: fakeMenu(100, 200) as HTMLElement | null };
    const { result } = renderHook(() => useFloatingMenuPosition(true, triggerRef, menuRef));

    expect(result.current.left).toBe(8);
  });

  it('shifts left when opening above', () => {
    const triggerRef = { current: fakeTrigger(700, 900) as HTMLElement | null };
    const menuRef = { current: fakeMenu(200, 200) as HTMLElement | null };
    const { result } = renderHook(() => useFloatingMenuPosition(true, triggerRef, menuRef));

    expect(result.current).toMatchObject({ placement: 'above', left: VIEWPORT_WIDTH - 8 - 200 });
  });

  it('builds an inline style from the position', () => {
    expect(
      floatingMenuStyle({ left: 1, bottom: 2, minWidth: 3, maxHeight: 4, placement: 'above' }),
    ).toEqual({ left: 1, top: undefined, bottom: 2, minWidth: 3, maxHeight: 4 });
  });

  it('passes the max width through to the inline style', () => {
    expect(
      floatingMenuStyle({ left: 8, top: 5, minWidth: 3, maxWidth: 984, maxHeight: 4, placement: 'below' }),
    ).toMatchObject({ left: 8, maxWidth: 984 });
  });
});
