export interface FilamentMaterialJson {
  family: string;
  subtype?: string | null;
  color_hex: string;
  profile_id?: string | null;
  setting_id?: string | null;
}

export interface FilamentMaterialInput {
  family?: string | null;
  subtype?: string | null;
  colorHex?: string | null;
  color_hex?: string | null;
  profileId?: string | null;
  profile_id?: string | null;
  settingId?: string | null;
  setting_id?: string | null;
  type?: string | null;
  color?: string | null;
  tray_type?: string | null;
  tray_sub_brands?: string | null;
  tray_color?: string | null;
  tray_info_idx?: string | null;
  rgba?: string | null;
  slicer_filament?: string | null;
  material?: FilamentMaterialJson | null;
}

const FILAMENT_TYPE_GROUPS = [
  ['PA-CF', 'PA12-CF', 'PAHT-CF'],
];

const EQUIV_MAP: Record<string, string> = {};
for (const group of FILAMENT_TYPE_GROUPS) {
  const canonical = group[0].toUpperCase();
  for (const entry of group) EQUIV_MAP[entry.toUpperCase()] = canonical;
}

const KNOWN_FAMILIES = [
  'PETG-HF', 'PETG HF', 'PETG-CF', 'PLA-CF', 'PAHT-CF', 'PA12-CF', 'PA6-CF', 'PA-CF',
  'NYLON', 'PETG', 'HIPS', 'PLA', 'ABS', 'ASA', 'TPU', 'PVA', 'PC', 'PA', 'PET',
].sort((a, b) => b.length - a.length);

const PROFILE_LABELS: Record<string, string> = {
  GFA00: 'Bambu PLA Basic',
  GFA01: 'Bambu PLA Matte',
  GFA02: 'Bambu PLA Metal',
  GFA05: 'Bambu PLA Silk',
  GFA06: 'Bambu PLA Silk+',
  GFA07: 'Bambu PLA Marble',
  GFA08: 'Bambu PLA Sparkle',
  GFA09: 'Bambu PLA Tough',
  GFA11: 'Bambu PLA Aero',
  GFA12: 'Bambu PLA Glow',
  GFA13: 'Bambu PLA Dynamic',
  GFA15: 'Bambu PLA Galaxy',
  GFA16: 'Bambu PLA Wood',
  GFA50: 'Bambu PLA-CF',
  GFG00: 'Bambu PETG Basic',
  GFG01: 'Bambu PETG Translucent',
  GFG02: 'Bambu PETG HF',
  GFG50: 'Bambu PETG-CF',
  GFG96: 'Generic PETG HF',
  GFG98: 'Generic PETG-CF',
  GFG99: 'Generic PETG',
  GFL95: 'Generic PLA High Speed',
  GFL96: 'Generic PLA Silk',
  GFL98: 'Generic PLA-CF',
  GFL99: 'Generic PLA',
  GFN03: 'Bambu PA-CF',
  GFN04: 'Bambu PAHT-CF',
  GFN05: 'Bambu PA6-CF',
  GFN98: 'Generic PA-CF',
  GFN99: 'Generic PA',
  GFU00: 'Bambu TPU 95A HF',
  GFU01: 'Bambu TPU 95A',
  GFU02: 'Bambu TPU for AMS',
  GFU98: 'Generic TPU for AMS',
  GFU99: 'Generic TPU',
};

function cleanToken(value?: string | null): string {
  return (value || '').replace('@', ' @ ').trim().split(/\s+/).filter(Boolean).join(' ');
}

function normalizeSubtype(value?: string | null): string | null {
  const subtype = cleanToken((value || '').split('@', 1)[0]);
  if (!subtype || ['GENERIC', 'BAMBU', 'BAMBU LAB'].includes(subtype.toUpperCase())) return null;
  if (subtype.startsWith('@')) return null;
  return subtype;
}

export function canonicalFilamentType(type?: string | null): string {
  const upper = (type || '').trim().toUpperCase();
  return EQUIV_MAP[upper] ?? upper;
}

export function normalizeColorHex(value?: string | null, fallback = '#808080FF'): string {
  let raw = (value || '').trim().replace(/^#/, '');
  if (raw.length !== 6 && raw.length !== 8) raw = fallback.replace(/^#/, '');
  if (raw.length === 6) raw += 'FF';
  if (!/^[0-9a-fA-F]{8}$/.test(raw)) {
    raw = fallback.replace(/^#/, '');
    if (raw.length === 6) raw += 'FF';
  }
  return `#${raw.slice(0, 8).toUpperCase()}`;
}

export function parseMaterialLabel(label?: string | null, familyHint?: string | null): { family: string; subtype: string | null } {
  const clean = cleanToken(label);
  const hint = cleanToken(familyHint).toUpperCase();
  let hintFamily = '';
  if (hint) {
    const normalizedHint = hint.replaceAll(' ', '-');
    hintFamily = KNOWN_FAMILIES.find((candidate) =>
      normalizedHint === candidate.toUpperCase().replaceAll(' ', '-')
    )?.toUpperCase() ?? '';
  }
  if (!clean && hint) return { family: hintFamily || hint, subtype: null };
  if (!clean) return { family: '', subtype: null };
  const upper = clean.toUpperCase();
  let family = '';
  let subtype: string | null = null;

  if (hintFamily && (upper === hintFamily || ` ${upper} `.includes(` ${hintFamily} `) || upper.startsWith(`${hintFamily}-`))) {
    family = hintFamily;
  } else {
    for (const candidate of KNOWN_FAMILIES) {
      const candidateUpper = candidate.toUpperCase();
      const padded = ` ${upper.replaceAll('-', ' - ')} `;
      const candidatePadded = ` ${candidateUpper.replaceAll('-', ' - ')} `;
      if (upper === candidateUpper || ` ${upper} `.includes(` ${candidateUpper} `) || padded.includes(candidatePadded)) {
        family = candidateUpper;
        break;
      }
    }
  }

  if (!family) {
    const [first, ...rest] = clean.split(' ');
    return { family: first.toUpperCase(), subtype: normalizeSubtype(rest.join(' ')) };
  }

  if (family === 'PETG-HF' || family === 'PETG HF') {
    family = 'PETG';
    subtype = 'HF';
  }

  const familyIdx = upper.indexOf(family);
  if (familyIdx >= 0) {
    subtype = normalizeSubtype(clean.slice(familyIdx + family.length).replace(/^[-\s]+/, '')) || subtype;
  } else if (family === 'PETG') {
    const idx = Math.max(upper.indexOf('PETG-HF'), upper.indexOf('PETG HF'));
    if (idx >= 0) subtype = normalizeSubtype(clean.slice(idx + 'PETG-HF'.length).replace(/^[-\s]+/, '')) || subtype;
  }

  return { family, subtype };
}

export function colorsAreSimilar(color1?: string | null, color2?: string | null, threshold = 40): boolean {
  const c1 = normalizeColorHex(color1);
  const c2 = normalizeColorHex(color2);
  if (c1.slice(7, 9) === '00' || c2.slice(7, 9) === '00') {
    return c1.slice(7, 9) === c2.slice(7, 9) && c1.slice(0, 7) === c2.slice(0, 7);
  }
  return [1, 3, 5].every((idx) =>
    Math.abs(parseInt(c1.slice(idx, idx + 2), 16) - parseInt(c2.slice(idx, idx + 2), 16)) <= threshold
  );
}

export function filamentMaterialIdentityKey(input: FilamentMaterial | FilamentMaterialInput | FilamentMaterialJson): string {
  const material = input instanceof FilamentMaterial ? input : new FilamentMaterial(input);
  return [
    material.compatibleFamilyKey,
    material.subtypeKey,
    material.colorHex,
  ].join('|');
}

export const FilamentMatchScore = {
  NoMatch: 0,
  Family: 100,
  MaterialSimilarColor: 200,
  MaterialColor: 300,
  Profile: 400,
} as const;

function profileMaterial(profileId?: string | null): { family: string; subtype: string | null } {
  const label = PROFILE_LABELS[(profileId || '').split('_')[0]];
  return label ? parseMaterialLabel(label) : { family: '', subtype: null };
}

export class FilamentMaterial {
  family: string;
  subtype: string | null;
  colorHex: string;
  profileId: string | null;
  settingId: string | null;

  constructor(input: FilamentMaterialInput) {
    const material = input.material;
    const profileId = cleanToken(input.profileId ?? input.profile_id ?? input.slicer_filament ?? input.tray_info_idx ?? material?.profile_id) || null;
    const base = parseMaterialLabel(
      [input.family ?? material?.family ?? input.type ?? input.tray_type ?? '', input.subtype ?? material?.subtype ?? ''].filter(Boolean).join(' '),
      input.family ?? input.type ?? input.tray_type ?? material?.family ?? undefined,
    );
    const prof = profileMaterial(profileId);
    this.family = (base.family || prof.family || '').toUpperCase();
    this.subtype = normalizeSubtype(input.subtype ?? material?.subtype) ?? base.subtype ?? prof.subtype;
    this.colorHex = normalizeColorHex(input.colorHex ?? input.color_hex ?? material?.color_hex ?? input.color ?? input.tray_color ?? input.rgba);
    this.profileId = profileId;
    this.settingId = cleanToken(input.settingId ?? input.setting_id ?? material?.setting_id) || null;
  }

  static fromAmsTray(tray: FilamentMaterialInput): FilamentMaterial {
    const parsed = parseMaterialLabel(tray.tray_sub_brands ?? tray.tray_type ?? tray.type, tray.tray_type ?? tray.type);
    return new FilamentMaterial({
      family: parsed.family,
      subtype: parsed.subtype,
      colorHex: tray.tray_color ?? tray.color,
      profileId: tray.tray_info_idx ?? tray.profile_id,
      settingId: tray.setting_id,
    });
  }

  static fromRequirement(req: FilamentMaterialInput): FilamentMaterial {
    return new FilamentMaterial(req);
  }

  static from3mfRequirement(req: FilamentMaterialInput): FilamentMaterial {
    return FilamentMaterial.fromRequirement(req);
  }

  static fromSpool(spool: FilamentMaterialInput): FilamentMaterial {
    return new FilamentMaterial({
      family: spool.family ?? spool.type,
      subtype: spool.subtype,
      colorHex: spool.rgba ?? spool.colorHex ?? spool.color_hex ?? spool.color,
      profileId: spool.slicer_filament ?? spool.profileId ?? spool.profile_id,
      settingId: spool.settingId ?? spool.setting_id,
    });
  }

  static fromQueueOverride(override: FilamentMaterialInput): FilamentMaterial {
    return new FilamentMaterial(override);
  }

  get familyKey(): string {
    return this.family.toUpperCase();
  }

  get compatibleFamilyKey(): string {
    return canonicalFilamentType(this.family);
  }

  get subtypeKey(): string {
    return (this.subtype || '').toUpperCase();
  }

  get rgbHex(): string {
    return this.colorHex.slice(0, 7);
  }

  get materialLabel(): string {
    return [this.family, this.subtype].filter(Boolean).join(' ');
  }

  get genericColorName(): string {
    if (this.colorHex.slice(7, 9) === '00') return 'Clear';
    const r = parseInt(this.colorHex.slice(1, 3), 16) / 255;
    const g = parseInt(this.colorHex.slice(3, 5), 16) / 255;
    const b = parseInt(this.colorHex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0;
    let s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    h *= 360;
    if (l < 0.15) return 'Black';
    if (l > 0.85) return 'White';
    if (s < 0.15) {
      if (l < 0.4) return 'Dark Gray';
      if (l > 0.6) return 'Light Gray';
      return 'Gray';
    }
    if (h >= 15 && h < 45 && l < 0.45) return 'Brown';
    if (h >= 45 && h < 70 && l < 0.40) return 'Brown';
    if (h < 15 || h >= 345) return 'Red';
    if (h < 45) return 'Orange';
    if (h < 70) return 'Yellow';
    if (h < 150) return 'Green';
    if (h < 200) return 'Cyan';
    if (h < 260) return 'Blue';
    if (h < 290) return 'Purple';
    return 'Pink';
  }

  get displayName(): string {
    return `${this.materialLabel || 'Unknown'} - ${this.genericColorName}`;
  }

  toQueueJson(): FilamentMaterialJson {
    return {
      family: this.family,
      subtype: this.subtype,
      color_hex: this.colorHex,
      profile_id: this.profileId,
      setting_id: this.settingId,
    };
  }

  toLegacyTypeColor(): { type: string; color: string; tray_info_idx: string } {
    return {
      type: this.family,
      color: this.rgbHex,
      tray_info_idx: this.profileId || '',
    };
  }

  toMqttFields(): {
    tray_type: string;
    tray_sub_brands: string;
    tray_color: string;
    tray_info_idx: string;
    setting_id: string;
  } {
    return {
      tray_type: this.family,
      tray_sub_brands: this.materialLabel || this.family,
      tray_color: this.colorHex.replace(/^#/, ''),
      tray_info_idx: this.profileId || '',
      setting_id: this.settingId || '',
    };
  }

  isFamilyMatch(other: FilamentMaterial): boolean {
    return !!this.compatibleFamilyKey && this.compatibleFamilyKey === other.compatibleFamilyKey;
  }

  isMaterialMatch(other: FilamentMaterial): boolean {
    if (!this.isFamilyMatch(other)) return false;
    return !this.subtypeKey || !other.subtypeKey || this.subtypeKey === other.subtypeKey;
  }

  isColorMatch(other: FilamentMaterial): boolean {
    return this.rgbHex.toUpperCase() === other.rgbHex.toUpperCase() && this.colorHex.slice(7, 9) === other.colorHex.slice(7, 9);
  }

  isSimilarColor(other: FilamentMaterial): boolean {
    return colorsAreSimilar(this.colorHex, other.colorHex);
  }

  isProfileMatch(other: FilamentMaterial): boolean {
    return !!this.profileId && !!other.profileId && this.profileId === other.profileId;
  }

  isExactMatch(other: FilamentMaterial): boolean {
    if (this.profileId && other.profileId) {
      return this.isProfileMatch(other);
    }
    return this.isMaterialMatch(other) && this.isColorMatch(other);
  }

  compatibilityScore(
    other: FilamentMaterial,
    policy: { allowFamilyFallback?: boolean } = {},
  ): (typeof FilamentMatchScore)[keyof typeof FilamentMatchScore] {
    if (this.isProfileMatch(other)) return FilamentMatchScore.Profile;
    if (this.isMaterialMatch(other) && this.isColorMatch(other)) return FilamentMatchScore.MaterialColor;
    if (this.isMaterialMatch(other) && this.isSimilarColor(other)) return FilamentMatchScore.MaterialSimilarColor;
    if (policy.allowFamilyFallback && this.isFamilyMatch(other)) return FilamentMatchScore.Family;
    return FilamentMatchScore.NoMatch;
  }
}
