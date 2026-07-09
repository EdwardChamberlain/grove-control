import { describe, expect, it } from 'vitest';
import {
  FilamentMaterial,
  FilamentMatchScore,
  normalizeColorHex,
  parseMaterialLabel,
} from '../../utils/filamentMaterial';

describe('FilamentMaterial', () => {
  it('normalizes colors to RGBA hex', () => {
    expect(normalizeColorHex('#FFFFFF')).toBe('#FFFFFFFF');
    expect(normalizeColorHex('00000000')).toBe('#00000000');
  });

  it('uses canonical generated display names', () => {
    const material = new FilamentMaterial({
      family: 'PLA',
      subtype: 'Matte',
      colorHex: '#FFFFFF',
      profileId: 'GFA01',
    });

    expect(material.displayName).toBe('PLA Matte - White');
  });

  it('derives Bambu subtype from profile id for sliced requirements', () => {
    const matte = FilamentMaterial.fromRequirement({ type: 'PLA', color: '#FFFFFF', tray_info_idx: 'GFA01' });
    const basic = FilamentMaterial.fromRequirement({ type: 'PLA', color: '#FFFFFF', tray_info_idx: 'GFA00' });

    expect(matte.materialLabel).toBe('PLA Matte');
    expect(basic.materialLabel).toBe('PLA Basic');
    expect(matte.isFamilyMatch(basic)).toBe(true);
    expect(matte.isMaterialMatch(basic)).toBe(false);
  });

  it('serializes to queue, legacy, and MQTT boundary shapes', () => {
    const material = FilamentMaterial.fromRequirement({ type: 'PLA', color: '#FFFFFF', tray_info_idx: 'GFA01' });

    expect(material.toQueueJson()).toEqual({
      family: 'PLA',
      subtype: 'Matte',
      color_hex: '#FFFFFFFF',
      profile_id: 'GFA01',
      setting_id: null,
    });
    expect(material.toLegacyTypeColor()).toEqual({
      type: 'PLA',
      color: '#FFFFFF',
      tray_info_idx: 'GFA01',
    });
    expect(material.toMqttFields()).toEqual({
      tray_type: 'PLA',
      tray_sub_brands: 'PLA Matte',
      tray_color: 'FFFFFFFF',
      tray_info_idx: 'GFA01',
      setting_id: '',
    });
  });

  it('scores exact material and family fallback matches', () => {
    const required = FilamentMaterial.fromRequirement({ type: 'PLA', color: '#FFFFFF', tray_info_idx: 'GFA01' });
    const matte = FilamentMaterial.fromAmsTray({ tray_type: 'PLA', tray_sub_brands: 'PLA Matte', tray_color: '#FFFFFF' });
    const basic = FilamentMaterial.fromAmsTray({ tray_type: 'PLA', tray_sub_brands: 'PLA Basic', tray_color: '#FFFFFF' });

    expect(required.compatibilityScore(matte)).toBe(FilamentMatchScore.MaterialColor);
    expect(required.compatibilityScore(basic)).toBe(FilamentMatchScore.NoMatch);
    expect(required.compatibilityScore(basic, { allowFamilyFallback: true })).toBe(FilamentMatchScore.Family);
  });

  it('parses known material label shapes', () => {
    expect(parseMaterialLabel('Bambu PLA Basic')).toEqual({ family: 'PLA', subtype: 'Basic' });
    expect(parseMaterialLabel('Bambu PLA Basic @BBL X1C')).toEqual({ family: 'PLA', subtype: 'Basic' });
    expect(parseMaterialLabel('PLA Matte', 'PLA Matte')).toEqual({ family: 'PLA', subtype: 'Matte' });
    expect(parseMaterialLabel('Generic PLA')).toEqual({ family: 'PLA', subtype: null });
    expect(parseMaterialLabel('PETG-HF')).toEqual({ family: 'PETG', subtype: 'HF' });
    expect(parseMaterialLabel('TPU 95A')).toEqual({ family: 'TPU', subtype: '95A' });
  });

  it('accepts a full material label in the requirement type field', () => {
    const material = FilamentMaterial.fromRequirement({ type: 'PLA Matte', color: '#FFFFFF' });

    expect(material.family).toBe('PLA');
    expect(material.subtype).toBe('Matte');
    expect(material.displayName).toBe('PLA Matte - White');
  });
});
