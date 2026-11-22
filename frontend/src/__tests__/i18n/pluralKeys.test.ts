/**
 * Plural strings use i18next's _one / _other keys. The legacy _plural suffix is
 * ignored by i18next 25, so every count fell back to the singular string
 * ("2 item", "5 print in queue"). The parity script now rejects _plural keys;
 * this checks the rendered text for the keys that used to rely on it.
 */

import { describe, expect, it } from 'vitest';
import i18n from '../../i18n';

describe('plural strings', () => {
  it.each([
    ['printers.maintenanceWarning', {}, '1 warning', '3 warnings'],
    ['printers.maintenanceDue', {}, '1 due', '3 due'],
    ['printers.queue.inQueue', {}, '1 print in queue', '3 prints in queue'],
    ['archives.platePicker.objectCount', {}, '1 object', '3 objects'],
    ['queue.itemCount', {}, '1 item', '3 items'],
    ['queue.dragGhost.batch', { name: 'Benchy' }, 'Benchy (1 copy)', 'Benchy (3 copies)'],
    ['queue.bulkEdit.title', {}, 'Edit 1 Item', 'Edit 3 Items'],
  ])('%s reads naturally for one and for several', (key, options, one, many) => {
    expect(i18n.t(key, { ...options, count: 1 })).toBe(one);
    expect(i18n.t(key, { ...options, count: 3 })).toBe(many);
  });
});
