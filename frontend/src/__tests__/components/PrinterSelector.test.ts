import { describe, expect, it } from 'vitest';
import type { FilamentMappingPreview } from '../../api/client';

describe('printer mapping preview boundary', () => {
  it('represents backend candidate and status data without client-side matching', () => {
    const preview: FilamentMappingPreview = {
      auto_mapping: [0],
      mapping: [0],
      loaded_filaments: [],
      comparisons: [{
        slot_id: 1,
        material: {
          family: 'PLA',
          subtype: 'Basic',
          color_hex: '#FFFFFFFF',
          material_label: 'PLA Basic',
          display_name: 'PLA Basic - White',
          generic_color_name: 'White',
        },
        status: 'match',
        mapped_tray_id: 0,
        candidate_tray_ids: [0],
      }],
    };

    expect(preview.comparisons[0].candidate_tray_ids).toEqual([0]);
  });
});
