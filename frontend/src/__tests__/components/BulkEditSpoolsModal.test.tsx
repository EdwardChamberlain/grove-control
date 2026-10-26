/**
 * BulkEditSpoolsModal: only ticked, non-empty fields go into the patch;
 * searchable dropdowns (with and without custom values), number and colour
 * normalisation, and blocking Apply on an invalid colour.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { BulkEditSpoolsModal, type BulkEditSpoolsModalProps } from '../../components/BulkEditSpoolsModal';

function setup(overrides: Partial<BulkEditSpoolsModalProps> = {}) {
  const onApply = vi.fn();
  const onClose = vi.fn();
  render(
    <BulkEditSpoolsModal
      isOpen
      selectedCount={3}
      isPending={false}
      availableLocations={[{ id: 4, name: 'Dry box' }, { id: 5, name: 'Shelf' }]}
      availableMaterials={['PLA', 'Nylon-X']}
      availableSubtypes={['Silk']}
      availableBrands={['Acme']}
      availableCategories={['Prototype', 'Production']}
      availableSlicerFilaments={['GFL99']}
      availableSlicerFilamentNames={['Old Name']}
      onClose={onClose}
      onApply={onApply}
      {...overrides}
    />,
  );
  return { onApply, onClose };
}

function row(label: string): HTMLElement {
  return screen.getByText(label, { selector: 'label' }).closest('div.flex.items-start') as HTMLElement;
}

const apply = () => screen.getByRole('button', { name: /Apply to 3 spools/ });

beforeEach(() => {
  server.use(
    http.get('/api/v1/cloud/status', () => HttpResponse.json({ is_authenticated: true })),
    http.get('/api/v1/cloud/filaments', () => HttpResponse.json([])),
    http.get('/api/v1/orca-cloud/status', () => HttpResponse.json({ connected: false })),
    http.get('/api/v1/local-presets/', () => HttpResponse.json({ filament: [], printer: [], process: [] })),
    http.get('/api/v1/cloud/builtin-filaments', () => HttpResponse.json([])),
  );
});

describe('BulkEditSpoolsModal', () => {
  it('starts with nothing to apply', () => {
    setup();

    expect(screen.getByText('Bulk edit spools')).toBeInTheDocument();
    expect(screen.getByText('Applies to 3 selected spools. Only fields you tick get updated.')).toBeInTheDocument();
    expect(screen.getByText('0 fields will be updated.')).toBeInTheDocument();
    expect(apply()).toBeDisabled();
  });

  it('builds a patch from the fields that were set', async () => {
    const { onApply } = setup();
    const user = userEvent.setup();

    // Searchable list: pick an existing value.
    await user.click(within(row('Material')).getByRole('textbox'));
    await user.type(within(row('Material')).getByRole('textbox'), 'nyl');
    await user.click(screen.getByRole('button', { name: 'Nylon-X' }));

    // Free text accepted, and offered as a custom value.
    await user.type(within(row('Brand')).getByRole('textbox'), 'Brand New');
    await user.click(screen.getByRole('button', { name: 'Use "Brand New"' }));

    // Closed list: only existing locations.
    await user.click(within(row('Storage Location')).getByRole('textbox'));
    await user.type(within(row('Storage Location')).getByRole('textbox'), 'zzz');
    expect(screen.getByText('No matches found')).toBeInTheDocument();
    await user.clear(within(row('Storage Location')).getByRole('textbox'));
    await user.click(screen.getByRole('button', { name: 'Shelf' }));

    await user.type(within(row('Cost per kg')).getByRole('spinbutton'), '24.5');
    await user.type(within(row('Color')).getByPlaceholderText('RRGGBB or RRGGBBAA'), '#ff8800');
    await user.type(within(row('Note')).getByRole('textbox'), '  restocked  ');
    await user.click(within(row('Category')).getByRole('textbox'));
    await user.click(screen.getByRole('button', { name: 'Production' }));

    expect(screen.getByText('7 fields will be updated.')).toBeInTheDocument();
    await user.click(apply());

    expect(onApply).toHaveBeenCalledWith({
      material: 'Nylon-X',
      brand: 'Brand New',
      rgba: 'FF8800FF',
      location_id: 5,
      cost_per_kg: 24.5,
      note: 'restocked',
      category: 'Production',
    });
  });

  it('ticking a field without a value changes nothing; unticking removes it', async () => {
    const { onApply } = setup();
    const user = userEvent.setup();

    await user.click(within(row('Label Weight')).getByRole('checkbox'));
    expect(within(row('Label Weight')).getByRole('checkbox')).toBeChecked();
    expect(apply()).toBeDisabled();

    await user.type(within(row('Label Weight')).getByRole('spinbutton'), '750');
    await user.type(within(row('Color Name')).getByRole('textbox'), 'Sunset');
    await user.click(within(row('Color Name')).getByRole('checkbox'));
    await user.click(apply());

    expect(onApply).toHaveBeenCalledWith({ label_weight: 750 });
  });

  it('blocks Apply while a colour is invalid', async () => {
    setup();
    const user = userEvent.setup();

    await user.type(within(row('Color')).getByPlaceholderText('RRGGBB or RRGGBBAA'), 'XYZ');

    expect(screen.getByText(/Enter 6 hex characters/)).toBeInTheDocument();
    expect(apply()).toBeDisabled();

    fireEvent.change(row('Color').querySelector('input[type="color"]')!, { target: { value: '#112233' } });
    expect(screen.queryByText(/Enter 6 hex characters/)).not.toBeInTheDocument();
    expect(apply()).toBeEnabled();
  });

  it('closes dropdowns on Escape and outside clicks', async () => {
    setup();
    const user = userEvent.setup();

    await user.click(within(row('Subtype')).getByRole('textbox'));
    expect(screen.getByRole('button', { name: 'Silk' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'Silk' })).not.toBeInTheDocument();

    await user.click(within(row('Subtype')).getByRole('textbox'));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('button', { name: 'Silk' })).not.toBeInTheDocument();
  });

  it('closes from cancel, the X and the backdrop', async () => {
    const { onClose } = setup();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.click(document.querySelector('.fixed.inset-0')!);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('shows the pending state', () => {
    setup({ isPending: true });

    expect(screen.getByRole('button', { name: /Applying/ })).toBeDisabled();
    expect(within(row('Material')).getByRole('textbox')).toBeDisabled();
  });

  it('renders nothing when closed', () => {
    setup({ isOpen: false });

    expect(screen.queryByText('Bulk edit spools')).not.toBeInTheDocument();
  });
});
