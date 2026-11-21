/**
 * Tests for the NotificationLogViewer filter bar.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { NotificationLogViewer } from '../../components/NotificationLogViewer';

describe('NotificationLogViewer', () => {
  beforeEach(() => {
    server.use(
      http.get('*/api/v1/notifications/logs/stats', () =>
        HttpResponse.json({ total: 0, success_count: 0, failure_count: 0, by_event_type: {}, by_provider: {} })
      ),
      http.get('*/api/v1/notifications/logs', () => HttpResponse.json([])),
    );
  });

  it('keeps the period filter the same height as the Refresh and Clear Old buttons beside it', async () => {
    render(<NotificationLogViewer onClose={() => {}} />);

    const filter = await screen.findByRole('combobox');

    // The small buttons are 28.8px with no border; the bordered dropdown needs an explicit
    // h-8 to match. Sizing it with padding (py-1.5) made it 2px taller than them.
    expect(filter).toHaveClass('h-8');
    expect(filter).not.toHaveClass('py-1.5');
    expect(await screen.findByRole('button', { name: /refresh/i })).toBeInTheDocument();
  });
});
