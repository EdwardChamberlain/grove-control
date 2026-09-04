import { describe, expect, it } from 'vitest';

import { getActivePrintIdentity } from '../../utils/printIdentity';

const activeStatus = {
  state: 'RUNNING',
  current_print_identity: null,
  current_archive_id: null,
  subtask_name: 'Widget',
  current_print: 'widget.3mf',
  gcode_file: '/Metadata/plate_1.gcode',
};

describe('getActivePrintIdentity', () => {
  it('prefers the live subtask identity over a stale REST archive ID', () => {
    expect(getActivePrintIdentity({
      ...activeStatus,
      current_print_identity: 'job-2',
      current_archive_id: 17,
    })).toBe('subtask:job-2');
  });

  it('falls back through archive ID and print names', () => {
    expect(getActivePrintIdentity({ ...activeStatus, current_archive_id: 17 })).toBe('archive:17');
    expect(getActivePrintIdentity(activeStatus)).toBe('Widget');
  });

  it('does not retain an identity once the print is no longer active', () => {
    expect(getActivePrintIdentity({ ...activeStatus, state: 'FINISH' })).toBeNull();
  });
});
