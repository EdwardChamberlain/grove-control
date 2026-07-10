import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';

import { AmsBackupModal } from '../../components/AmsBackupModal';
import { server } from '../mocks/server';
import { render } from '../utils';

afterEach(() => server.resetHandlers());

describe('AmsBackupModal', () => {
  it('renders backend-derived backup groups', async () => {
    server.use(
      http.get('/api/v1/printers/:id/ams-backup-groups', () => HttpResponse.json({
        effective_dual_nozzle: false,
        groups: [{
          key: 'profile:GFA00|color:#000000|extruder:0', profile_id: 'GFA00', extruder: 0,
          material: {
            family: 'PLA', subtype: 'Basic', color_hex: '#000000FF', profile_id: 'GFA00', setting_id: 'GFSA00',
            material_label: 'PLA Basic', display_name: 'PLA Basic - Black', generic_color_name: 'Black',
          },
          members: [{ ams_id: 0, tray_id: 0, is_ht: false }, { ams_id: 1, tray_id: 0, is_ht: false }],
        }],
      })),
    );
    render(<AmsBackupModal isOpen state={true} printerId={1} canToggle pending={false} onToggle={vi.fn()} onClose={vi.fn()} />);

    expect(await screen.findByText('PLA Basic')).toBeInTheDocument();
  });

  it('closes when Escape is pressed', () => {
    const onClose = vi.fn();
    render(<AmsBackupModal isOpen state={true} printerId={1} canToggle pending={false} onToggle={vi.fn()} onClose={onClose} />);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
