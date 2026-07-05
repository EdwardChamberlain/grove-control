import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AMSUnit } from '../../api/client';
import {
  AmsEnvironmentIndicators,
  AmsSlotActions,
  AmsSlotGrid,
  AmsUnitHeader,
  CompactAmsUnitCard,
  ExpandedAmsUnitCard,
  HtAmsUnitCard,
} from '../../components/printer/AmsCardParts';

const ams: AMSUnit = {
  id: 0,
  humidity: 35,
  temp: 24,
  is_ams_ht: false,
  serial_number: 'AMS123',
  sw_ver: '1.0.0',
  dry_time: 0,
  dry_status: 0,
  dry_sub_status: 0,
  dry_sf_reason: [],
  dry_target_temp: null,
  dry_filament: null,
  module_type: 'ams',
  tray: Array.from({ length: 4 }, (_, id) => ({
    id,
    tray_color: null,
    tray_type: null,
    tray_sub_brands: null,
    tray_id_name: null,
    tray_info_idx: null,
    remain: 0,
    k: null,
    cali_idx: null,
    tag_uid: null,
    tray_uuid: null,
    nozzle_temp_min: null,
    nozzle_temp_max: null,
    drying_temp: null,
    drying_time: null,
    state: 9,
  })),
};

describe('composed AMS card parts', () => {
  it('combines the shared header, environment indicators, and slot grid', () => {
    render(
      <CompactAmsUnitCard amsId={ams.id}>
        <AmsUnitHeader
          label={<span>AMS-A</span>}
          environment={<AmsEnvironmentIndicators ams={ams} />}
          dryingControl={<button type="button">Dry</button>}
        />
        <AmsSlotGrid ams={ams} variant="compact" renderSlot={(_, index) => <span key={index}>Slot {index + 1}</span>} />
      </CompactAmsUnitCard>,
    );

    const card = screen.getByTestId('ams-unit-card-compact-0');
    expect(within(card).getByText('AMS-A')).toBeInTheDocument();
    expect(within(card).getByTitle(/Humidity:/)).toBeInTheDocument();
    expect(within(card).getByTitle(/Temperature:/).parentElement).toHaveClass('mr-1');
    expect(within(card).getAllByText(/Slot /)).toHaveLength(4);
  });

  it('provides dedicated expanded and HT layout wrappers', () => {
    render(<><ExpandedAmsUnitCard amsId={1}>Expanded</ExpandedAmsUnitCard><HtAmsUnitCard amsId={2}>HT</HtAmsUnitCard></>);

    expect(screen.getByTestId('ams-unit-card-expanded-1')).toHaveClass('space-y-1');
    expect(screen.getByTestId('ams-unit-card-ht-2')).toHaveTextContent('HT');
  });

  it('applies shared permission and printing gates to slot actions', () => {
    const onRefresh = vi.fn();
    const onLoad = vi.fn();
    const onUnload = vi.fn();
    render(
      <AmsSlotActions
        isPrinting={false}
        canReadRfid={false}
        canControl
        onRefresh={onRefresh}
        onLoad={onLoad}
        onUnload={onUnload}
      />,
    );

    const reread = screen.getByRole('button', { name: /re-read/i });
    expect(reread).toBeDisabled();
    expect(reread).toHaveAttribute('title');
    fireEvent.click(screen.getByRole('button', { name: /^load$/i }));
    expect(onLoad).toHaveBeenCalledOnce();
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
