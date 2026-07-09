/**
 * Tests for canonical print-workflow filament labels.
 *
 * Official/vendor colour names are intentionally ignored here. Active print
 * surfaces derive labels from family, subtype, and normalised colour only.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { extractMaterialHint, useFilamentLabels } from '../../components/PrintModal/useFilamentLabels';

afterEach(() => {
  cleanup();
});

describe('extractMaterialHint', () => {
  it('strips the leading brand token from multi-word names', () => {
    expect(extractMaterialHint('Bambu PLA Matte')).toBe('PLA Matte');
    expect(extractMaterialHint('PolyLite ABS')).toBe('ABS');
    expect(extractMaterialHint('Bambu PLA-CF')).toBe('PLA-CF');
  });

  it('returns single-word names unchanged so "PLA" stays "PLA"', () => {
    expect(extractMaterialHint('PLA')).toBe('PLA');
    expect(extractMaterialHint('PETG-HF')).toBe('PETG-HF');
  });

  it('collapses interior whitespace and trims edges', () => {
    expect(extractMaterialHint('  Bambu   PLA   Matte  ')).toBe('PLA Matte');
  });

  it('returns "" when the input is blank', () => {
    expect(extractMaterialHint('')).toBe('');
    expect(extractMaterialHint('   ')).toBe('');
  });
});

describe('useFilamentLabels', () => {
  it('returns [] for undefined or empty inputs', () => {
    const { result, rerender } = renderHook(
      ({ reqs }: { reqs: undefined | Array<{ type: string; color: string }> }) =>
        useFilamentLabels(reqs),
      { initialProps: { reqs: undefined } },
    );
    expect(result.current).toEqual([]);

    rerender({ reqs: [] });
    expect(result.current).toEqual([]);
  });

  it('derives material subtype from known profile ids', () => {
    const { result } = renderHook(() =>
      useFilamentLabels([{ type: 'PLA', color: '#000000', tray_info_idx: 'GFA01' }]),
    );

    expect(result.current).toEqual([{ resolvedName: 'PLA Matte', colorLabel: 'Black' }]);
  });

  it('uses generic colour names instead of official/vendor colour names', () => {
    const { result } = renderHook(() =>
      useFilamentLabels([{ type: 'PLA', color: '#FFFFFF', tray_info_idx: 'GFA01' }]),
    );

    expect(result.current).toEqual([{ resolvedName: 'PLA Matte', colorLabel: 'White' }]);
  });

  it('keeps positional alignment across slots with identical hex values', () => {
    const { result } = renderHook(() =>
      useFilamentLabels([
        { type: 'PLA', color: '#FFFFFF', tray_info_idx: 'GFA01' },
        { type: 'PLA', color: '#FFFFFF', tray_info_idx: 'GFA00' },
      ]),
    );

    expect(result.current).toEqual([
      { resolvedName: 'PLA Matte', colorLabel: 'White' },
      { resolvedName: 'PLA Basic', colorLabel: 'White' },
    ]);
  });

  it('prefers canonical material objects when provided by the API', () => {
    const { result } = renderHook(() =>
      useFilamentLabels([
        {
          type: 'PLA',
          color: '#000000',
          tray_info_idx: 'GFA00',
          material: {
            family: 'PETG',
            subtype: 'HF',
            color_hex: '#00FF00FF',
            profile_id: 'GFG02',
          },
        },
      ]),
    );

    expect(result.current).toEqual([{ resolvedName: 'PETG HF', colorLabel: 'Green' }]);
  });

  it('parses material labels without simple first-space splitting', () => {
    const { result } = renderHook(() =>
      useFilamentLabels([{ type: 'PETG-HF', color: '#00FF00', tray_info_idx: 'GFXXX' }]),
    );

    expect(result.current).toEqual([{ resolvedName: 'PETG HF', colorLabel: 'Green' }]);
  });
});
