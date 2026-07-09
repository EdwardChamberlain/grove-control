import { describe, expect, it } from 'vitest';
import type { FilamentRequirement } from '../../hooks/useFilamentMapping';

describe('filament mapping boundary', () => {
  it('keeps the browser input shape free of matching policy', () => {
    const requirement: FilamentRequirement = {
      slot_id: 1,
      type: 'PLA',
      color: '#FFFFFFFF',
      used_grams: 10,
      used_meters: 3,
      material: {
        family: 'PLA',
        subtype: 'Matte',
        color_hex: '#FFFFFFFF',
        profile_id: 'GFA01',
      },
    };

    expect(requirement.material?.family).toBe('PLA');
  });
});
