/**
 * GcodeViewer with the WebGL library stubbed: tool-number remapping, colour
 * mapping, the layer controls, and the not-sliced / error states.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { setAuthToken } from '../../api/client';

const previews: FakePreview[] = [];

class FakePreview {
  options: Record<string, unknown>;
  extrusionColor: unknown;
  gcode = '';
  layers: unknown[] = [];
  endLayer = 0;
  render = vi.fn();
  resize = vi.fn();
  dispose = vi.fn();

  constructor(options: Record<string, unknown>) {
    this.options = options;
    this.extrusionColor = options.extrusionColor;
    previews.push(this);
  }

  processGCode(gcode: string) {
    this.gcode = gcode;
    this.layers = gcode.includes('G1') ? [1, 2, 3] : [];
  }
}

vi.mock('gcode-preview', () => ({ WebGLPreview: FakePreview }));

const { GcodeViewer } = await import('../../components/GcodeViewer');

const GCODE = ['G28', 'T3', 'G1 X1', 'T255', 'T7 ; swap', 'G1 X2', 'T1000'].join('\n');

beforeEach(() => {
  previews.length = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  setAuthToken(null);
});

describe('GcodeViewer', () => {
  it('remaps tools into T0-T7, filters special commands and maps colours', async () => {
    let auth: string | null = null;
    server.use(
      http.get('/api/v1/plate.gcode', ({ request }) => {
        auth = request.headers.get('Authorization');
        return new HttpResponse(GCODE);
      }),
    );
    setAuthToken('tok');
    const colors = ['#000000', '#111111', '#222222', '#333333', '#444444', '#555555', '#666666', '#777777'];
    render(<GcodeViewer gcodeUrl="/api/v1/plate.gcode" filamentColors={colors} />);

    expect(await screen.findByText('3 / 3')).toBeInTheDocument();
    const preview = previews[0];
    expect(preview.options.extrusionColor).toEqual(colors);
    expect(preview.gcode.split('\n')).toEqual(['G28', 'T0', 'G1 X1', '; FILTERED: T255', 'T1 ; swap', 'G1 X2', '; FILTERED: T1000']);
    expect(preview.extrusionColor).toEqual(['#333333', '#777777']);
    expect(auth).toBe('Bearer tok');
  });

  it('uses one colour when given a single filament and steps through layers', async () => {
    server.use(http.get('/api/v1/plate.gcode', () => new HttpResponse('G1 X1')));
    const user = userEvent.setup();
    render(<GcodeViewer gcodeUrl="/api/v1/plate.gcode" filamentColors={['#ff0000']} />);

    await screen.findByText('3 / 3');
    const preview = previews[0];
    expect(preview.options.extrusionColor).toBe('#ff0000');

    const [prev, next] = screen.getAllByRole('button');
    expect(next).toBeDisabled();
    await user.click(prev);
    expect(screen.getByText('2 / 3')).toBeInTheDocument();
    expect(preview.endLayer).toBe(2);
    fireEvent.change(screen.getByRole('slider'), { target: { value: '1' } });
    expect(screen.getByText('1 / 3')).toBeInTheDocument();
    expect(prev).toBeDisabled();
    await user.click(next);
    expect(screen.getByText('2 / 3')).toBeInTheDocument();

    fireEvent(window, new Event('resize'));
    expect(preview.resize).toHaveBeenCalled();
  });

  it('hides the layer controls when there are no layers', async () => {
    server.use(http.get('/api/v1/plate.gcode', () => new HttpResponse('; empty')));
    render(<GcodeViewer gcodeUrl="/api/v1/plate.gcode" />);

    await waitFor(() => expect(screen.queryByText('Loading G-code...')).not.toBeInTheDocument());
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(previews[0].options.extrusionColor).toBe('#00ae42');
  });

  it('explains when the file has not been sliced', async () => {
    server.use(http.get('/api/v1/plate.gcode', () => HttpResponse.json({ detail: 'File has not been sliced' }, { status: 404 })));
    render(<GcodeViewer gcodeUrl="/api/v1/plate.gcode" />);

    expect(await screen.findByText('G-code not available')).toBeInTheDocument();
  });

  it.each([
    [HttpResponse.json({ detail: 'Archive missing' }, { status: 404 })],
    [new HttpResponse('boom', { status: 500 })],
  ])('shows a load error (%#)', async (response) => {
    server.use(http.get('/api/v1/plate.gcode', () => response));
    render(<GcodeViewer gcodeUrl="/api/v1/plate.gcode" />);

    expect(await screen.findByText('Failed to load G-code')).toBeInTheDocument();
  });

  it('disposes the preview on unmount', async () => {
    server.use(http.get('/api/v1/plate.gcode', () => new HttpResponse('G1 X1')));
    const { unmount } = render(<GcodeViewer gcodeUrl="/api/v1/plate.gcode" />);

    await screen.findByText('3 / 3');
    unmount();

    expect(previews[0].dispose).toHaveBeenCalled();
  });
});
