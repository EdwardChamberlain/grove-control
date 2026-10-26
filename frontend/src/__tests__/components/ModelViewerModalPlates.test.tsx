/**
 * ModelViewerModal: paging through many plates, the fullscreen split view
 * with its draggable divider, and opening the file in the desktop slicer
 * (with a slicer token, and the fallback when the token request fails).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { ModelViewerModal } from '../../components/ModelViewerModal';

vi.mock('../../components/ModelViewer', () => ({ ModelViewer: () => <div data-testid="model-viewer" /> }));
vi.mock('../../components/GcodeViewer', () => ({ GcodeViewer: () => <div data-testid="gcode-viewer" /> }));

const plate = (index: number) => ({
  index, name: `Plate ${index}`, has_thumbnail: false, thumbnail_url: null, print_time_seconds: 600 * index,
  filament_used_grams: index, object_count: 1, objects: [`Part ${index}`], filaments: [],
});

let clickedLinks: string[];

beforeEach(() => {
  clickedLinks = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clickedLinks.push(this.href);
  });
  server.use(
    http.get('/api/v1/archives/:id/capabilities', () =>
      HttpResponse.json({ has_model: true, has_gcode: true, has_source: false, build_volume: { x: 256, y: 256, z: 256 }, filament_colors: [] }),
    ),
    http.get('/api/v1/archives/:id/plates', () => HttpResponse.json({ is_multi_plate: true, plates: Array.from({ length: 14 }, (_, i) => plate(i + 1)) })),
    http.get('/api/v1/library/files/:id/plates', () => HttpResponse.json({ is_multi_plate: false, plates: [plate(1)] })),
    http.get('/api/v1/settings/', () => HttpResponse.json({ preferred_slicer: 'orcaslicer' })),
    http.post('/api/v1/archives/:id/slicer-token', () => HttpResponse.json({ token: 'tok123' })),
    http.post('/api/v1/library/files/:id/slicer-token', () => HttpResponse.json({ token: 'libtok' })),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('plates', () => {
  it('pages through more plates than fit on one page', async () => {
    const user = userEvent.setup();
    render(<ModelViewerModal archiveId={1} title="Big job" onClose={vi.fn()} />);

    expect(await screen.findByText('Plate 1')).toBeInTheDocument();
    expect(screen.queryByText('Plate 14')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prev' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Plate 14')).toBeInTheDocument();
    expect(screen.queryByText('Plate 1')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Prev' }));
    expect(screen.getByText('Plate 1')).toBeInTheDocument();

    // Numbered page buttons.
    await user.click(screen.getByRole('button', { name: '2' }));
    expect(screen.getByText('Plate 14')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '1' }));
    expect(screen.getByText('Plate 1')).toBeInTheDocument();
  });

  it('splits fullscreen between viewer and plates, with a draggable divider', async () => {
    const user = userEvent.setup();
    render(<ModelViewerModal archiveId={1} title="Big job" onClose={vi.fn()} />);
    await screen.findByText('Plate 1');

    await user.click(screen.getByTitle('Enter fullscreen'));
    const divider = await screen.findByRole('separator');
    fireEvent.mouseDown(divider);
    expect(document.body.style.cursor).toBe('row-resize');
    fireEvent.mouseMove(document, { clientY: 200 });
    fireEvent.mouseUp(document);
    expect(document.body.style.cursor).toBe('');

    await user.click(screen.getByTitle('Exit fullscreen'));
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  });
});

describe('open in slicer', () => {
  it('opens an archive in the preferred slicer with a short-lived token', async () => {
    const user = userEvent.setup();
    render(<ModelViewerModal archiveId={1} title="Benchy" onClose={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: /Open in Slicer/ }));

    await waitFor(() => expect(clickedLinks.some((href) => href.startsWith('orcaslicer://open?file='))).toBe(true));
    expect(decodeURIComponent(clickedLinks.find((h) => h.startsWith('orcaslicer'))!)).toContain('tok123');
  });

  it('falls back to the direct download when the token request fails', async () => {
    server.use(http.post('/api/v1/archives/:id/slicer-token', () => HttpResponse.json({}, { status: 500 })));
    const user = userEvent.setup();
    render(<ModelViewerModal archiveId={1} title="Benchy" onClose={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: /Open in Slicer/ }));

    await waitFor(() => expect(clickedLinks.some((h) => h.startsWith('orcaslicer://'))).toBe(true));
    expect(decodeURIComponent(clickedLinks.find((h) => h.startsWith('orcaslicer'))!)).not.toContain('tok123');
  });

  it.each([
    [() => HttpResponse.json({ token: 'libtok' }), 'libtok'],
    [() => HttpResponse.json({}, { status: 500 }), '/download'],
  ])('opens a library file (%#)', async (tokenResponse, expected) => {
    server.use(http.post('/api/v1/library/files/:id/slicer-token', tokenResponse));
    const user = userEvent.setup();
    render(<ModelViewerModal libraryFileId={4} fileType="3mf" title="Bracket" onClose={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: /Open in Slicer/ }));

    await waitFor(() => expect(clickedLinks.some((h) => h.startsWith('orcaslicer://'))).toBe(true));
    expect(decodeURIComponent(clickedLinks.find((h) => h.startsWith('orcaslicer'))!)).toContain(expected);
  });
});
