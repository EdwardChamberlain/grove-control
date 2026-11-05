import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '../utils';
import { floatingMenuStyle, useFloatingMenuPosition } from '../../hooks/useFloatingMenuPosition';

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

  it('builds an inline style from the position', () => {
    expect(
      floatingMenuStyle({ left: 1, bottom: 2, minWidth: 3, maxHeight: 4, placement: 'above' }),
    ).toEqual({ left: 1, top: undefined, bottom: 2, minWidth: 3, maxHeight: 4 });
  });
});
