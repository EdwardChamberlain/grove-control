import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { render } from '../utils';
import { FilamentOverride } from '../../components/PrintModal/FilamentOverride';

describe('FilamentOverride', () => {
  it('renders only backend-approved material options and submits the canonical payload', () => {
    const onChange = vi.fn();
    render(
      <FilamentOverride
        filamentReqs={{ filaments: [{ slot_id: 1, type: 'PLA', color: '#FFFFFF', used_grams: 10, used_meters: 3 }] }}
        availableOptions={{
          slots: [{
            slot_id: 1,
            material: {
              family: 'PLA', subtype: 'Basic', color_hex: '#FFFFFFFF', profile_id: 'GFA00', setting_id: 'GFSA00',
              material_label: 'PLA Basic', display_name: 'PLA Basic - White', generic_color_name: 'White',
            },
            options: [{ material: {
              family: 'PLA', subtype: 'Matte', color_hex: '#FFFFFFFF', profile_id: 'GFA01', setting_id: 'GFSA01',
              material_label: 'PLA Matte', display_name: 'PLA Matte - White', generic_color_name: 'White',
            } }],
          }],
        }}
        overrides={{}}
        onChange={onChange}
      />,
    );

    const select = screen.getByRole('combobox');
    expect(screen.getByRole('option', { name: 'PLA Matte - White' })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'PLA|Matte|#FFFFFFFF|GFA01' } });
    expect(onChange).toHaveBeenCalledWith({
      1: {
        material: expect.objectContaining({ family: 'PLA', subtype: 'Matte', profile_id: 'GFA01' }),
      },
    });
  });
});
