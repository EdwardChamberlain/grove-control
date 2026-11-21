import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '../utils';
import userEvent from '@testing-library/user-event';
import { ReactSelect, ToolbarDropdown } from '../../components/ToolbarControls';

describe('ReactSelect', () => {
  it('uses the associated form label as its accessible name', async () => {
    render(
      <form>
        <label htmlFor="flavor">Flavor</label>
        <ReactSelect id="flavor" name="flavor" value="vanilla" onChange={vi.fn()}>
          <option value="vanilla">Vanilla</option>
          <option value="chocolate">Chocolate</option>
        </ReactSelect>
      </form>,
    );

    expect(await screen.findByRole('combobox', { name: /flavor/i })).toHaveValue('vanilla');
  });

  it('contributes its selected value to form data', async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();
    render(
      <form aria-label="dessert">
        <label htmlFor="flavor">Flavor</label>
        <ReactSelect id="flavor" name="flavor" defaultValue="vanilla" required onChange={handleChange}>
          <option value="">Pick one</option>
          <option value="vanilla">Vanilla</option>
          <option value="chocolate">Chocolate</option>
        </ReactSelect>
      </form>,
    );

    const select = await screen.findByRole('combobox', { name: /flavor/i });
    await user.click(select);
    await user.click(await screen.findByRole('option', { name: 'Chocolate' }));

    const form = screen.getByRole('form', { name: /dessert/i }) as HTMLFormElement;
    expect(new FormData(form).get('flavor')).toBe('chocolate');
    expect(handleChange).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({ value: 'chocolate', name: 'flavor' }),
    }));
  });

  it('supports keyboard selection and skips disabled options', async () => {
    const user = userEvent.setup();
    render(
      <form aria-label="dessert">
        <label htmlFor="flavor">Flavor</label>
        <ReactSelect id="flavor" name="flavor" defaultValue="vanilla">
          <option value="vanilla">Vanilla</option>
          <option value="strawberry" disabled>Strawberry</option>
          <option value="chocolate">Chocolate</option>
        </ReactSelect>
      </form>,
    );

    const select = await screen.findByRole('combobox', { name: /flavor/i });
    select.focus();
    await user.keyboard('[ArrowDown][Enter]');

    await waitFor(() => expect(select).toHaveValue('chocolate'));
    const form = screen.getByRole('form', { name: /dessert/i }) as HTMLFormElement;
    expect(new FormData(form).get('flavor')).toBe('chocolate');
  });
});

describe('ReactSelect sizing', () => {
  const renderSelect = (className?: string) => {
    render(
      <ReactSelect value="a" className={className} onChange={vi.fn()}>
        <option value="a">Alpha</option>
        <option value="b">Beta</option>
      </ReactSelect>,
    );
    return screen.getByRole('combobox');
  };

  it('keeps the compact toolbar size when the caller sets no sizing', () => {
    const trigger = renderSelect();

    expect(trigger).toHaveClass('h-8', 'px-2');
  });

  it('lets a form field size itself so it matches the text inputs beside it', () => {
    // A fixed 32px toolbar height used to win over py-2 and leave form selects shorter than inputs.
    const trigger = renderSelect('w-full px-3 py-2 bg-bambu-dark border rounded-lg text-white');

    expect(trigger).toHaveClass('px-3', 'py-2');
    expect(trigger).not.toHaveClass('h-8');
    expect(trigger).not.toHaveClass('px-2');
  });

  it('respects an explicit height from the caller', () => {
    const trigger = renderSelect('w-full h-10');

    expect(trigger).toHaveClass('h-10');
    expect(trigger).not.toHaveClass('h-8');
  });

  it('only drops the axis the caller sizes', () => {
    expect(renderSelect('px-3')).toHaveClass('px-3', 'h-8');
  });

  it('does not mistake min/max height utilities for sizing', () => {
    const trigger = renderSelect('min-h-0 max-h-12');

    expect(trigger).toHaveClass('h-8', 'px-2');
  });

  it.each([undefined, 'w-full px-3 py-2'])('keeps the shared control styling (%s)', (className) => {
    const trigger = renderSelect(className);

    expect(trigger).toHaveClass('rounded-lg', 'border', 'text-sm');
  });
});

describe('ToolbarDropdown keyboard', () => {
  it('closes its menu on Escape and marks the key handled so a surrounding panel can stay open', async () => {
    const user = userEvent.setup();
    const outer = vi.fn();
    render(
      <div onKeyDown={(e) => outer(e.defaultPrevented)}>
        <ToolbarDropdown value="a" onChange={vi.fn()} options={[{ value: 'a', label: 'Option A' }, { value: 'b', label: 'Option B' }]} />
      </div>,
    );

    await user.click(screen.getByRole('button', { name: 'Option A' }));
    expect(await screen.findByRole('button', { name: 'Option B' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'Option B' })).not.toBeInTheDocument();
    expect(outer).toHaveBeenLastCalledWith(true);

    // With the menu closed, Escape is left alone for whatever contains the dropdown.
    await user.keyboard('{Escape}');
    expect(outer).toHaveBeenLastCalledWith(false);
  });
});

describe('dropdowns near the bottom of the screen', () => {
  const VIEWPORT_HEIGHT = 800;
  let triggerTop = 740;

  const rect = (top: number) => ({
    top, bottom: top + 32, left: 100, right: 220, width: 120, height: 32, x: 100, y: top,
    toJSON: () => ({}),
  }) as DOMRect;

  beforeEach(() => {
    triggerTop = 740;
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(VIEWPORT_HEIGHT);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => rect(triggerTop));
    // Each option is 40px tall, so the menu's height follows its content.
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.querySelectorAll('button').length * 40;
    });
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

  it('flips upwards when options arrive while the menu is open', async () => {
    // 56px below the trigger: room for one option but not five.
    triggerTop = 700;
    const user = userEvent.setup();
    const options = (count: number) => Array.from({ length: count }, (_, i) => (
      <option key={i} value={String(i)}>{`Option ${i}`}</option>
    ));
    const { rerender } = render(
      <ReactSelect aria-label="Printer" value="0" onChange={vi.fn()}>{options(1)}</ReactSelect>,
    );

    await user.click(screen.getByRole('combobox', { name: 'Printer' }));
    expect(screen.getByRole('listbox')).toHaveAttribute('data-placement', 'below');

    rerender(<ReactSelect aria-label="Printer" value="0" onChange={vi.fn()}>{options(5)}</ReactSelect>);
    expect(screen.getByRole('listbox')).toHaveAttribute('data-placement', 'above');
  });

  it('closes when its trigger is scrolled off the screen', async () => {
    const user = userEvent.setup();
    render(
      <ReactSelect aria-label="Show" value="25" onChange={vi.fn()}>
        <option value="25">25</option>
        <option value="50">50</option>
      </ReactSelect>,
    );

    await user.click(screen.getByRole('combobox', { name: 'Show' }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    triggerTop = 900;
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Show' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens from the keyboard while its trigger is scrolled off the screen', async () => {
    const user = userEvent.setup();
    render(
      <ReactSelect aria-label="Show" value="25" onChange={vi.fn()}>
        <option value="25">25</option>
        <option value="50">50</option>
      </ReactSelect>,
    );
    const select = screen.getByRole('combobox', { name: 'Show' });
    select.focus();
    triggerTop = -200;

    await user.keyboard('[ArrowDown]');

    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(select).toHaveAttribute('aria-expanded', 'true');
  });

  it('closes ToolbarDropdown when its trigger is scrolled off the screen', async () => {
    const user = userEvent.setup();
    render(
      <ToolbarDropdown
        value="a"
        options={[{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }]}
        onChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Alpha' }));
    triggerTop = -100;
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });

    expect(screen.queryByRole('button', { name: 'Beta' })).not.toBeInTheDocument();
  });
});
