/**
 * The maintenance due and warning counts use i18next's _one / _other plural
 * keys. The old _plural suffix is not resolved by i18next 25, which left every
 * count reading "N item due" and "N warning".
 */

import { describe, expect, it } from 'vitest';
import i18n from '../../i18n';

describe('maintenance count plurals', () => {
  it('uses the singular for one and the plural for other counts', () => {
    expect(i18n.t('maintenance.dueCount', { count: 1 })).toBe('1 item due');
    expect(i18n.t('maintenance.dueCount', { count: 3 })).toBe('3 items due');
    expect(i18n.t('maintenance.warningCount', { count: 1 })).toBe('1 warning');
    expect(i18n.t('maintenance.warningCount', { count: 4 })).toBe('4 warnings');
    expect(i18n.t('maintenance.logEntryCount', { count: 1 })).toBe('1 entry');
    expect(i18n.t('maintenance.logEntryCount', { count: 2 })).toBe('2 entries');
  });
});
