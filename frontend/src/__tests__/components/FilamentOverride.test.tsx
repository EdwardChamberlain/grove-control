/**
 * Tests for the FilamentOverride component.
 *
 * FilamentOverride allows users to override the 3MF's original filament
 * choices with filaments available across printers of the selected model.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { render } from '../utils';
import { FilamentOverride } from '../../components/PrintModal/FilamentOverride';
import type { FilamentReqsData } from '../../components/PrintModal/types';
import { FilamentMaterial } from '../../utils/filamentMaterial';

const defaultFilamentReqs: FilamentReqsData = {
  filaments: [
    { slot_id: 1, type: 'PLA', color: '#FF0000', used_grams: 25, used_meters: 8.5 },
  ],
};

const defaultAvailable = [
  { type: 'PLA', color: '#FF0000', tray_info_idx: 'GFA00', tray_sub_brands: 'PLA Basic', extruder_id: null },
  { type: 'PLA', color: '#00FF00', tray_info_idx: 'GFA01', tray_sub_brands: 'PLA Basic', extruder_id: null },
  { type: 'PETG', color: '#0000FF', tray_info_idx: 'GFG00', tray_sub_brands: 'PETG Basic', extruder_id: null },
];

const mockOnChange = vi.fn();

function selection(type: string, color: string, trayInfoIdx = '', traySubBrands = type) {
  const material = FilamentMaterial.fromAmsTray({
    tray_type: type,
    tray_color: color,
    tray_info_idx: trayInfoIdx,
    tray_sub_brands: traySubBrands,
  });
  return {
    type: material.family,
    color: material.rgbHex,
    material: material.toQueueJson(),
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FilamentOverride', () => {
  describe('rendering', () => {
    it('returns null when filamentReqs is undefined', () => {
      render(
        <FilamentOverride
          filamentReqs={undefined}
          availableFilaments={defaultAvailable}
          overrides={{}}
          onChange={mockOnChange}
        />
      );

      expect(screen.queryByText('Filament Requirements')).not.toBeInTheDocument();
    });

    it('returns null when filaments array is empty', () => {
      render(
        <FilamentOverride
          filamentReqs={{ filaments: [] }}
          availableFilaments={defaultAvailable}
          overrides={{}}
          onChange={mockOnChange}
        />
      );

      expect(screen.queryByText('Filament Requirements')).not.toBeInTheDocument();
    });

    it('shows the sliced profile as the default when no alternatives are available', () => {
      render(
        <FilamentOverride
          filamentReqs={defaultFilamentReqs}
          availableFilaments={[]}
          overrides={{}}
          onChange={mockOnChange}
        />
      );

      expect(screen.getByText('Filament Requirements')).toBeInTheDocument();
      const select = screen.getByRole('combobox');
      expect(select).toBeDisabled();
      expect(select.querySelector('option[value=""]')?.textContent).toMatch(/Original: PLA/);
    });

    it('renders filament slot with type and grams', () => {
      render(
        <FilamentOverride
          filamentReqs={defaultFilamentReqs}
          availableFilaments={defaultAvailable}
          overrides={{}}
          onChange={mockOnChange}
        />
      );

      // The grams text "(25g)" is in a nested span within the type label
      expect(screen.getByText('(25g)')).toBeInTheDocument();
      // The requirements heading confirms the section renders
      expect(screen.getByText('Filament Requirements')).toBeInTheDocument();
    });

    it('renders override dropdown for each slot', () => {
      const twoSlotReqs: FilamentReqsData = {
        filaments: [
          { slot_id: 1, type: 'PLA', color: '#FF0000', used_grams: 25, used_meters: 8.5 },
          { slot_id: 2, type: 'PLA', color: '#00FF00', used_grams: 10, used_meters: 3.2 },
        ],
      };

      render(
        <FilamentOverride
          filamentReqs={twoSlotReqs}
          availableFilaments={defaultAvailable}
          overrides={{}}
          onChange={mockOnChange}
        />
      );

      const selects = screen.getAllByRole('combobox');
      expect(selects).toHaveLength(2);
    });
  });

  describe('type filtering', () => {
    it('only shows same-type filaments in dropdown', () => {
      render(
        <FilamentOverride
          filamentReqs={defaultFilamentReqs}
          availableFilaments={defaultAvailable}
          overrides={{}}
          onChange={mockOnChange}
        />
      );

      const select = screen.getByRole('combobox');
      const options = select.querySelectorAll('option');

      // 1 default "Original" option + 2 PLA options (not PETG)
      expect(options).toHaveLength(3);

      // Verify no PETG option values exist
      const optionValues = Array.from(options).map((o) => o.getAttribute('value'));
      expect(optionValues.some((v) => v?.startsWith('PETG|'))).toBe(false);
    });

    it('shows all same-type options regardless of color', () => {
      const threeColorAvailable = [
        { type: 'PLA', color: '#FF0000', tray_info_idx: 'GFA00', tray_sub_brands: 'PLA Basic', extruder_id: null },
        { type: 'PLA', color: '#00FF00', tray_info_idx: 'GFA01', tray_sub_brands: 'PLA Basic', extruder_id: null },
        { type: 'PLA', color: '#FFFFFF', tray_info_idx: 'GFA02', tray_sub_brands: 'PLA Basic', extruder_id: null },
      ];

      render(
        <FilamentOverride
          filamentReqs={defaultFilamentReqs}
          availableFilaments={threeColorAvailable}
          overrides={{}}
          onChange={mockOnChange}
        />
      );

      const select = screen.getByRole('combobox');
      const options = select.querySelectorAll('option');

      // 1 default "Original" option + 3 PLA color options
      expect(options).toHaveLength(4);
    });
  });

  describe('subtype display', () => {
    it('shows tray_sub_brands in dropdown options when available', () => {
      const subtypeAvailable = [
        { type: 'PLA', color: '#000000', tray_info_idx: 'GFL99', tray_sub_brands: 'PLA Basic', extruder_id: null },
        { type: 'PLA', color: '#000000', tray_info_idx: 'GFL05', tray_sub_brands: 'PLA Matte', extruder_id: null },
      ];

      render(
        <FilamentOverride
          filamentReqs={defaultFilamentReqs}
          availableFilaments={subtypeAvailable}
          overrides={{}}
          onChange={mockOnChange}
        />
      );

      const select = screen.getByRole('combobox');
      const options = Array.from(select.querySelectorAll('option'));
      const optionTexts = options.map((o) => o.textContent);

      // Should show "PLA Basic" and "PLA Matte", not just "PLA"
      expect(optionTexts.some((t) => t?.includes('PLA Basic'))).toBe(true);
      expect(optionTexts.some((t) => t?.includes('PLA Matte'))).toBe(true);
    });

    it('keeps same-hex material variants distinct in option values', () => {
      const subtypeAvailable = [
        { type: 'PLA', color: '#FFFFFF', tray_info_idx: 'GFA00', tray_sub_brands: 'PLA Basic', extruder_id: null },
        { type: 'PLA', color: '#FFFFFF', tray_info_idx: 'GFA01', tray_sub_brands: 'PLA Matte', extruder_id: null },
      ];

      render(
        <FilamentOverride
          filamentReqs={defaultFilamentReqs}
          availableFilaments={subtypeAvailable}
          overrides={{}}
          onChange={mockOnChange}
        />
      );

      const select = screen.getByRole('combobox');
      const nonDefaultValues = Array.from(select.querySelectorAll('option'))
        .filter((option) => option.value)
        .map((option) => option.value);

      expect(nonDefaultValues).toHaveLength(2);
      expect(new Set(nonDefaultValues).size).toBe(2);
      expect(nonDefaultValues.some((value) => value.includes('|BASIC|'))).toBe(true);
      expect(nonDefaultValues.some((value) => value.includes('|MATTE|'))).toBe(true);
    });

    it('falls back to type when tray_sub_brands is empty', () => {
      const noSubtypeAvailable = [
        { type: 'PLA', color: '#FF0000', tray_info_idx: 'GFA00', tray_sub_brands: '', extruder_id: null },
      ];

      render(
        <FilamentOverride
          filamentReqs={defaultFilamentReqs}
          availableFilaments={noSubtypeAvailable}
          overrides={{}}
          onChange={mockOnChange}
        />
      );

      const select = screen.getByRole('combobox');
      const options = Array.from(select.querySelectorAll('option'));
      // Non-default option should show "PLA" as the type fallback
      const nonDefaultOptions = options.filter((o) => o.getAttribute('value') !== '');
      expect(nonDefaultOptions[0].textContent).toContain('PLA');
    });
  });

  describe('nozzle filtering', () => {
    it('filters by extruder_id when nozzle_id is set', () => {
      const nozzleReqs: FilamentReqsData = {
        filaments: [
          { slot_id: 1, type: 'PLA', color: '#FF0000', used_grams: 25, used_meters: 8.5, nozzle_id: 0 },
        ],
      };

      const dualExtruderAvailable = [
        { type: 'PLA', color: '#FF0000', tray_info_idx: 'GFA00', tray_sub_brands: 'PLA Basic', extruder_id: 0 },
        { type: 'PLA', color: '#00FF00', tray_info_idx: 'GFA01', tray_sub_brands: 'PLA Basic', extruder_id: 1 },
      ];

      render(
        <FilamentOverride
          filamentReqs={nozzleReqs}
          availableFilaments={dualExtruderAvailable}
          overrides={{}}
          onChange={mockOnChange}
        />
      );

      const select = screen.getByRole('combobox');
      const options = select.querySelectorAll('option');

      // 1 default + 1 PLA with extruder_id=0 (extruder_id=1 is filtered out)
      expect(options).toHaveLength(2);

      const optionValues = Array.from(options).map((o) => o.getAttribute('value'));
      expect(optionValues.some((v) => v?.includes('#FF0000FF'))).toBe(true);
      expect(optionValues.some((v) => v?.includes('#00FF00FF'))).toBe(false);
    });

    it('shows all filaments when nozzle_id is undefined', () => {
      const noNozzleReqs: FilamentReqsData = {
        filaments: [
          { slot_id: 1, type: 'PLA', color: '#FF0000', used_grams: 25, used_meters: 8.5 },
        ],
      };

      const mixedExtruderAvailable = [
        { type: 'PLA', color: '#FF0000', tray_info_idx: 'GFA00', tray_sub_brands: 'PLA Basic', extruder_id: 0 },
        { type: 'PLA', color: '#00FF00', tray_info_idx: 'GFA01', tray_sub_brands: 'PLA Basic', extruder_id: 1 },
      ];

      render(
        <FilamentOverride
          filamentReqs={noNozzleReqs}
          availableFilaments={mixedExtruderAvailable}
          overrides={{}}
          onChange={mockOnChange}
        />
      );

      const select = screen.getByRole('combobox');
      const options = select.querySelectorAll('option');

      // 1 default + 2 PLA options (no nozzle filtering)
      expect(options).toHaveLength(3);
    });

    it('includes filaments with null extruder_id', () => {
      const nozzleReqs: FilamentReqsData = {
        filaments: [
          { slot_id: 1, type: 'PLA', color: '#FF0000', used_grams: 25, used_meters: 8.5, nozzle_id: 0 },
        ],
      };

      const mixedAvailable = [
        { type: 'PLA', color: '#FF0000', tray_info_idx: 'GFA00', tray_sub_brands: 'PLA Basic', extruder_id: 0 },
        { type: 'PLA', color: '#00FF00', tray_info_idx: 'GFA01', tray_sub_brands: 'PLA Basic', extruder_id: null },
        { type: 'PLA', color: '#FFFFFF', tray_info_idx: 'GFA02', tray_sub_brands: 'PLA Basic', extruder_id: 1 },
      ];

      render(
        <FilamentOverride
          filamentReqs={nozzleReqs}
          availableFilaments={mixedAvailable}
          overrides={{}}
          onChange={mockOnChange}
        />
      );

      const select = screen.getByRole('combobox');
      const options = select.querySelectorAll('option');

      // 1 default + extruder_id=0 + extruder_id=null (extruder_id=1 filtered out)
      expect(options).toHaveLength(3);

      const optionValues = Array.from(options).map((o) => o.getAttribute('value'));
      expect(optionValues.some((v) => v?.includes('#FF0000FF'))).toBe(true);
      expect(optionValues.some((v) => v?.includes('#00FF00FF'))).toBe(true);
      expect(optionValues.some((v) => v?.includes('#FFFFFFFF'))).toBe(false);
    });
  });

  describe('interactions', () => {
    it('calls onChange when selecting an override', () => {
      render(
        <FilamentOverride
          filamentReqs={defaultFilamentReqs}
          availableFilaments={defaultAvailable}
          overrides={{}}
          onChange={mockOnChange}
        />
      );

      const select = screen.getByRole('combobox');
      const selectedValue = Array.from(select.querySelectorAll('option'))
        .find((option) => option.textContent?.includes('Green'))
        ?.getAttribute('value');
      expect(selectedValue).toBeTruthy();
      fireEvent.change(select, { target: { value: selectedValue } });

      expect(mockOnChange).toHaveBeenCalledWith({
        1: selection('PLA', '#00FF00', 'GFA01', 'PLA Basic'),
      });
    });

    it('calls onChange to remove override when selecting original', () => {
      const activeOverrides = {
        1: selection('PLA', '#00FF00', 'GFA01', 'PLA Basic'),
      };

      render(
        <FilamentOverride
          filamentReqs={defaultFilamentReqs}
          availableFilaments={defaultAvailable}
          overrides={activeOverrides}
          onChange={mockOnChange}
        />
      );

      const select = screen.getByRole('combobox');
      fireEvent.change(select, { target: { value: '' } });

      expect(mockOnChange).toHaveBeenCalledWith({});
    });
  });

  describe('canonical original-label resolution', () => {
    it('uses known profile ids to derive the material subtype', async () => {
      const reqs: FilamentReqsData = {
        filaments: [
          { slot_id: 1, type: 'PLA', color: '#1A1A1A', used_grams: 25, used_meters: 8.5, tray_info_idx: 'GFA01' },
        ],
      };

      render(
        <FilamentOverride
          filamentReqs={reqs}
          availableFilaments={defaultAvailable}
          overrides={{}}
          onChange={mockOnChange}
        />,
      );

      // Scope to the dropdown's placeholder option; the tooltip on the color
      // swatch carries the same text.
      await waitFor(() => {
        const select = screen.getByRole('combobox');
        const placeholder = select.querySelector('option[value=""]');
        expect(placeholder?.textContent).toMatch(/PLA Matte/);
      });
    });

    it('ignores vendor and user-preset names for active print labels', async () => {
      const reqs: FilamentReqsData = {
        filaments: [
          { slot_id: 1, type: 'PLA', color: '#FF0000', used_grams: 25, used_meters: 8.5, tray_info_idx: 'GFA00' },
        ],
      };

      render(
        <FilamentOverride
          filamentReqs={reqs}
          availableFilaments={defaultAvailable}
          overrides={{}}
          onChange={mockOnChange}
        />,
      );

      await waitFor(() => {
        const select = screen.getByRole('combobox');
        const placeholder = select.querySelector('option[value=""]');
        expect(placeholder?.textContent).toMatch(/PLA Basic \(Red\)/);
      });
      expect(screen.queryByText(/Bambu PLA Basic/)).not.toBeInTheDocument();
      expect(screen.queryByText(/My House PLA/)).not.toBeInTheDocument();
    });

    it('uses generic colour names instead of catalogue colour names', async () => {
      const reqs: FilamentReqsData = {
        filaments: [
          { slot_id: 1, type: 'PLA', color: '#000000', used_grams: 25, used_meters: 8.5, tray_info_idx: 'GFA01' },
        ],
      };

      render(
        <FilamentOverride
          filamentReqs={reqs}
          availableFilaments={defaultAvailable}
          overrides={{}}
          onChange={mockOnChange}
        />,
      );

      await waitFor(() => {
        const select = screen.getByRole('combobox');
        const placeholder = select.querySelector('option[value=""]');
        expect(placeholder?.textContent).toMatch(/PLA Matte \(Black\)/);
      });
    });

    it('disambiguates per slot when two slots share a hex but differ in material', async () => {
      const reqs: FilamentReqsData = {
        filaments: [
          { slot_id: 1, type: 'PLA', color: '#000000', used_grams: 25, used_meters: 8.5, tray_info_idx: 'GFA01' },
          { slot_id: 2, type: 'PLA', color: '#000000', used_grams: 10, used_meters: 3.2, tray_info_idx: 'GFA00' },
        ],
      };

      render(
        <FilamentOverride
          filamentReqs={reqs}
          availableFilaments={defaultAvailable}
          overrides={{}}
          onChange={mockOnChange}
        />,
      );

      await waitFor(() => {
        const selects = screen.getAllByRole('combobox');
        expect(selects).toHaveLength(2);
        expect(selects[0].querySelector('option[value=""]')?.textContent).toMatch(/PLA Matte \(Black\)/);
        expect(selects[1].querySelector('option[value=""]')?.textContent).toMatch(/PLA Basic \(Black\)/);
      });
    });

    it('falls back to generated generic colour names', async () => {
      const reqs: FilamentReqsData = {
        filaments: [
          { slot_id: 1, type: 'PLA', color: '#FF0000', used_grams: 25, used_meters: 8.5, tray_info_idx: 'GFA01' },
        ],
      };

      render(
        <FilamentOverride
          filamentReqs={reqs}
          availableFilaments={defaultAvailable}
          overrides={{}}
          onChange={mockOnChange}
        />,
      );

      // The generated colour helper should keep the placeholder non-empty.
      await waitFor(() => {
        const select = screen.getByRole('combobox');
        const placeholder = select.querySelector('option[value=""]');
        expect(placeholder?.textContent).toMatch(/PLA Matte \(Red\)/);
        expect(placeholder?.textContent).not.toMatch(/null/);
      });
    });

    it('falls back to the raw type when the SKU is unknown to both maps', async () => {
      // Unknown ids must not break rendering — the original "PLA" label is
      // still better than a blank.
      const reqs: FilamentReqsData = {
        filaments: [
          { slot_id: 1, type: 'PLA', color: '#FF0000', used_grams: 25, used_meters: 8.5, tray_info_idx: 'GFXXX' },
        ],
      };

      render(
        <FilamentOverride
          filamentReqs={reqs}
          availableFilaments={defaultAvailable}
          overrides={{}}
          onChange={mockOnChange}
        />,
      );

      // (25g) is the easiest signal the row mounted at all; once it's there,
      // assert the placeholder option carries the raw type.
      await waitFor(() => {
        expect(screen.getByText('(25g)')).toBeInTheDocument();
      });
      const select = screen.getByRole('combobox');
      const placeholder = select.querySelector('option[value=""]');
      expect(placeholder?.textContent).toMatch(/PLA \(/);
    });
  });
});
