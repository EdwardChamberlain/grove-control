import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReactSelect } from '../../components/ToolbarControls';

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
