/**
 * CalendarView: month grid, day detail, monthly totals and navigation.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { CalendarView } from '../../components/CalendarView';
import type { Archive } from '../../api/client';

// Fixed "now" so the visible month and its leading blank cells are known: 15 July 2026 is a
// Wednesday, and July 2026 starts on a Wednesday (three blank cells before the 1st).
const NOW = new Date(2026, 6, 15, 12);

function archive(id: number, day: number, extra: Partial<Archive> = {}): Archive {
  const when = new Date(2026, 6, day, 12).toISOString();
  return {
    id,
    filename: `file-${id}.gcode.3mf`,
    print_name: `Print ${id}`,
    status: 'completed',
    created_at: when,
    started_at: when,
    completed_at: when,
    ...extra,
  } as unknown as Archive;
}

function setup(archives: Archive[], props: Partial<Parameters<typeof CalendarView>[0]> = {}) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const onArchiveClick = vi.fn();
  render(<CalendarView archives={archives} onArchiveClick={onArchiveClick} {...props} />);
  return { user, onArchiveClick };
}

describe('CalendarView', () => {
  afterEach(() => vi.useRealTimers());

  it('shows the current month with a count and status dot on days that have prints', () => {
    setup([archive(1, 3), archive(2, 3, { status: 'failed' }), archive(3, 8, { status: 'failed' }), archive(4, 9)]);

    expect(screen.getByRole('heading', { name: 'July 2026' })).toBeInTheDocument();
    // Mixed day: two prints, yellow dot. Failed-only day: red. Completed-only day: green.
    const mixed = screen.getByRole('button', { name: /^3\s*2$/ });
    expect(mixed.querySelector('.bg-yellow-400')).not.toBeNull();
    expect(screen.getByRole('button', { name: /^8\s*1$/ }).querySelector('.bg-red-400')).not.toBeNull();
    expect(screen.getByRole('button', { name: /^9\s*1$/ }).querySelector('.bg-green-400')).not.toBeNull();
  });

  it('totals the month for the whole width of the page', () => {
    setup([archive(1, 3), archive(2, 3, { status: 'failed' }), archive(3, 8), {
      ...archive(4, 1), started_at: new Date(2026, 5, 20).toISOString(), created_at: new Date(2026, 5, 20).toISOString(),
    } as Archive]);

    expect(screen.getByText('Prints this month').previousElementSibling).toHaveTextContent('3');
    expect(screen.getByText('Successful').previousElementSibling).toHaveTextContent('2');
    expect(screen.getByText('Failed').previousElementSibling).toHaveTextContent('1');
  });

  it('lists the prints of a selected day with thumbnail, filament colours and file name fallback', async () => {
    const { user, onArchiveClick } = setup([
      archive(1, 3, { thumbnail_path: 'thumb.png', filament_color: '#ff0000,#00ff00' }),
      archive(2, 3, { print_name: null as unknown as string }),
    ]);

    await user.click(screen.getByRole('button', { name: /^3\s*2$/ }));

    const first = screen.getByRole('button', { name: /Print 1/ });
    expect(within(first).getByRole('presentation', { hidden: true })).toHaveAttribute('src', expect.stringContaining('/archives/1/thumbnail'));
    expect(first.querySelectorAll('div[style*="background-color"]')).toHaveLength(2);
    const second = screen.getByRole('button', { name: /file-2\.gcode\.3mf/ });
    expect(within(second).getByText('3MF')).toBeInTheDocument();

    await user.click(second);
    expect(onArchiveClick).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
  });

  it('highlights the chosen print and clears it when another day is picked', async () => {
    const { user } = setup([archive(1, 5), archive(2, 4)], { highlightedArchiveId: 2 });

    await user.click(screen.getByRole('button', { name: /^4\s*1$/ }));
    expect(screen.getByRole('button', { name: /Print 2/ })).toHaveStyle({ outline: '4px solid #facc15' });

    await user.click(screen.getByRole('button', { name: /^5\s*1$/ }));
    const print1 = screen.getByRole('button', { name: /Print 1/ });
    await user.click(print1);
    expect(print1).toHaveStyle({ outline: '4px solid #facc15' });
    await user.click(screen.getByRole('button', { name: /^4\s*1$/ }));
    expect(screen.getByRole('button', { name: /Print 2/ })).toHaveStyle({ outline: '4px solid #facc15' });
  });

  it('says so when the selected day has no prints and toggles the selection off', async () => {
    const { user } = setup([archive(1, 3)]);

    expect(screen.getByText('Select a day to see prints')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '20' }));
    expect(screen.getByText('No prints on this day')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '20' }));
    expect(screen.getByText('Select a day to see prints')).toBeInTheDocument();
  });

  it('moves between months, across year boundaries, and back to today', async () => {
    const { user } = setup([archive(1, 3)]);

    await user.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(screen.getByRole('heading', { name: 'June 2026' })).toBeInTheDocument();
    expect(screen.getByText('Prints this month').previousElementSibling).toHaveTextContent('0');

    for (let i = 0; i < 6; i++) await user.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(screen.getByRole('heading', { name: 'December 2025' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getByRole('heading', { name: 'January 2026' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Today' }));
    expect(screen.getByRole('heading', { name: 'July 2026' })).toBeInTheDocument();
    for (let i = 0; i < 6; i++) await user.click(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getByRole('heading', { name: 'January 2027' })).toBeInTheDocument();
  });
});
