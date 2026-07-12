/**
 * Tests for the colour catalog admin (ColorCatalogSettings).
 *
 * Pin the #1154 wiring contract:
 * - The Add form sends `extra_colors` + `effect_type` alongside the legacy
 *   manufacturer / color_name / hex_color / material fields.
 * - Inline-edit hydrates the new fields from the existing entry and sends
 *   them back through `updateColorEntry`.
 * - Effect dropdown lists the full unified vocabulary (surface effects
 *   + sheen variants + structural variants), not just the original 5.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { render } from '../utils';
import { api } from '../../api/client';
import { ColorCatalogSettings } from '../../components/ColorCatalogSettings';

vi.mock('../../api/client', async () => {
  // Preserve every other method on `api` (ThemeContext / AuthContext call
  // some on mount) and override only the catalog ones the component touches.
  const actual: typeof import('../../api/client') = await vi.importActual('../../api/client');
  return {
    ...actual,
    api: {
      ...actual.api,
      getColorCatalog: vi.fn(),
      addColorEntry: vi.fn(),
      updateColorEntry: vi.fn(),
      deleteColorEntry: vi.fn(),
      bulkDeleteColorEntries: vi.fn(),
      resetColorCatalog: vi.fn(),
    },
    getAuthToken: vi.fn(() => null),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ColorCatalogSettings — Add form (#1154)', () => {
  it('sends extra_colors and effect_type when adding an entry', async () => {
    vi.mocked(api.getColorCatalog).mockResolvedValueOnce([]);
    vi.mocked(api.addColorEntry).mockResolvedValueOnce({
      id: 1,
      manufacturer: 'Test',
      color_name: 'Aurora',
      hex_color: '#EC984C',
      material: null,
      is_default: false,
      extra_colors: 'ec984c,6cd4bc,a66eb9,d87694',
      effect_type: 'sparkle',
    });

    render(<ColorCatalogSettings />);
    // Wait for initial load to settle so the Add button is rendered.
    await waitFor(() => expect(api.getColorCatalog).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByText(/loading/i)).not.toBeInTheDocument(),
    );

    // Open the Add form via the toolbar's "Add" button — there's only one
    // before the form opens, so this is unambiguous.
    fireEvent.click(screen.getByRole('button', { name: /Add$/i }));

    // The form now renders with manufacturer, color name, hex, material,
    // extra_colors, and effect_type inputs.
    fireEvent.change(screen.getByPlaceholderText('Manufacturer'), {
      target: { value: 'Test' },
    });
    fireEvent.change(screen.getByPlaceholderText('Color Name'), {
      target: { value: 'Aurora' },
    });
    // Hex has both a <input type="color"> and a <input type="text"
    // placeholder="#FFFFFF">. Pick the text variant by placeholder.
    fireEvent.change(screen.getByPlaceholderText('#FFFFFF'), {
      target: { value: '#EC984C' },
    });
    fireEvent.change(screen.getByPlaceholderText('EC984C,#6CD4BC,A66EB9,D87694'), {
      target: { value: 'EC984C,#6CD4BC,A66EB9,D87694' },
    });
    // Pick "Sparkle" from the custom effect-type dropdown.
    fireEvent.click(screen.getByRole('combobox', { name: /^None$/i }));
    fireEvent.click(screen.getByRole('option', { name: /^Sparkle$/i }));

    // Submit. The form's submit "Add" button is now the second button with
    // that label (toolbar Add still exists), so query inside the form
    // container by clicking the last matching button.
    const allAddButtons = screen.getAllByRole('button', { name: /Add$/i });
    fireEvent.click(allAddButtons[allAddButtons.length - 1]);

    await waitFor(() => expect(api.addColorEntry).toHaveBeenCalledTimes(1));
    expect(api.addColorEntry).toHaveBeenCalledWith({
      manufacturer: 'Test',
      color_name: 'Aurora',
      hex_color: '#EC984C',
      material: null,
      extra_colors: 'EC984C,#6CD4BC,A66EB9,D87694',
      effect_type: 'sparkle',
    });
  });

  it('lists every variant in the effect dropdown (not just the original 5)', async () => {
    vi.mocked(api.getColorCatalog).mockResolvedValueOnce([]);
    render(<ColorCatalogSettings />);
    await waitFor(() => expect(api.getColorCatalog).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByText(/loading/i)).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: /Add$/i }));
    fireEvent.click(screen.getByRole('combobox', { name: /^None$/i }));
    const options = screen.getAllByRole('option').map((o) => o.textContent);

    // Surface effects (V1).
    expect(options).toContain('Sparkle');
    expect(options).toContain('Wood');
    expect(options).toContain('Marble');
    expect(options).toContain('Glow');
    expect(options).toContain('Matte');
    // Structural variants added in #1154 follow-up.
    expect(options).toContain('Gradient');
    expect(options).toContain('Dual Color');
    expect(options).toContain('Tri Color');
    expect(options).toContain('Multicolor');
    // Sheen / finish variants.
    expect(options).toContain('Silk');
    expect(options).toContain('Galaxy');
    expect(options).toContain('Rainbow');
    expect(options).toContain('Metal');
    expect(options).toContain('Translucent');
    // None / no-effect option.
    expect(options).toContain('None');
  });
});

describe('ColorCatalogSettings — inline edit (#1154)', () => {
  it('hydrates extra_colors and effect_type when entering edit mode', async () => {
    const seed = {
      id: 42,
      manufacturer: 'Bambu Lab',
      color_name: 'Galaxy',
      hex_color: '#1A2B3C',
      material: 'PLA',
      is_default: true,
      extra_colors: 'aabbcc,ddeeff',
      effect_type: 'galaxy',
    };
    vi.mocked(api.getColorCatalog).mockResolvedValueOnce([seed]);

    render(<ColorCatalogSettings />);
    await waitFor(() => expect(screen.getByText('Galaxy')).toBeInTheDocument());

    // Click the Edit button on the seeded row.
    // The row's edit button has no accessible label so query by SVG-bearing
    // button containing the Pencil icon — there's only one in the rendered tree.
    const buttons = screen.getAllByRole('button');
    const editButton = buttons.find((b) => b.querySelector('svg.lucide-pencil'));
    expect(editButton).toBeDefined();
    fireEvent.click(editButton!);

    // The extra-colors input should now be populated with the seeded value.
    const extraColorsInputs = screen.getAllByPlaceholderText(
      'EC984C,#6CD4BC,A66EB9,D87694',
    ) as HTMLInputElement[];
    expect(extraColorsInputs[0].value).toBe('aabbcc,ddeeff');

    // The effect dropdown reflects the seeded effect.
    expect(screen.getByRole('combobox', { name: /^Galaxy$/i })).toBeInTheDocument();
  });
});
