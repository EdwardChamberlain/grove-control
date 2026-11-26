/**
 * SwitchbarPopover: lists the smart plugs pinned to the sidebar switchbar and
 * switches them after a confirmation.
 */

import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { SwitchbarPopover } from '../../components/SwitchbarPopover';

const plug = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  name: 'Printer plug',
  plug_type: 'tasmota',
  ip_address: '192.168.1.50',
  show_in_switchbar: true,
  ...overrides,
});

function setup() {
  server.use(
    http.get('/api/v1/smart-plugs/', () => HttpResponse.json([plug(), plug({ id: 2, name: 'Hidden plug', show_in_switchbar: false })])),
    http.get('/api/v1/smart-plugs/:id/status', () => HttpResponse.json({ state: 'ON', reachable: true, energy: { power: 12 } })),
    http.post('/api/v1/smart-plugs/:id/control', async () => {
      await delay('infinite');
      return HttpResponse.json({ success: true });
    }),
  );
  render(<SwitchbarPopover onClose={() => {}} />);
}

describe('SwitchbarPopover', () => {
  it('lists only the plugs pinned to the switchbar', async () => {
    setup();

    expect(await screen.findByText('Printer plug')).toBeInTheDocument();
    expect(screen.queryByText('Hidden plug')).not.toBeInTheDocument();
  });

  it.each([
    ['Turn On', 'Turn On'],
    ['Turn Off', 'Turn Off'],
  ])('shows a spinner on the %s button while the plug is switching', async (title, confirmText) => {
    const user = userEvent.setup();
    setup();
    await screen.findByText('Printer plug');

    const button = screen.getByTitle(title);
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    const confirm = (await screen.findAllByRole('button', { name: confirmText })).find((b) => !b.hasAttribute('title'));
    await user.click(confirm!);

    await waitFor(() => expect(button.querySelector('.spinner')).not.toBeNull());
    expect(button).toBeDisabled();
  });
});
