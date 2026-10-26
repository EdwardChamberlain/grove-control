/**
 * TimelapseEditorModal: trimming, speed, playback within the trim range,
 * music overlay, and saving the processed timelapse.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { TimelapseEditorModal } from '../../components/TimelapseEditorModal';

let processed: string | null;

function useApi() {
  processed = null;
  server.use(
    http.get('/api/v1/archives/5/timelapse/info', () =>
      HttpResponse.json({ duration: 60, width: 1920, height: 1080, fps: 30, codec: 'h264', file_size: 1, has_audio: false }),
    ),
    http.get('/api/v1/archives/5/timelapse/thumbnails', () =>
      HttpResponse.json({ thumbnails: ['AAAA', 'BBBB'], timestamps: [0, 30] }),
    ),
    http.post('/api/v1/archives/5/timelapse/process', async ({ request }) => {
      processed = await request.text();
      return HttpResponse.json({ status: 'ok', output_path: null, message: 'Timelapse saved' });
    }),
  );
}

function video(): HTMLVideoElement {
  return document.querySelector('video') as HTMLVideoElement;
}

/** Give the jsdom video a duration and simulate the browser's events. */
async function loadVideo(duration = 60) {
  const el = video();
  Object.defineProperty(el, 'duration', { configurable: true, value: duration });
  let time = 0;
  // jsdom does not store currentTime; give it a plain writable value.
  Object.defineProperty(el, 'currentTime', {
    configurable: true,
    get: () => time,
    set: (value: number) => {
      time = value;
    },
  });
  await waitFor(() => {
    fireEvent(el, new Event('durationchange'));
    expect((screen.getAllByRole('slider')[0] as HTMLInputElement).max).toBe(String(duration));
  });
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    this.dispatchEvent(new Event('pause'));
  });
  URL.createObjectURL = vi.fn(() => 'blob:audio');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TimelapseEditorModal', () => {
  it('trims, changes speed and saves with a music overlay', async () => {
    useApi();
    const onSave = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<TimelapseEditorModal archiveId={5} timelapseSrc="/t.mp4" onClose={onClose} onSave={onSave} />);

    expect(await screen.findByText('Edit Timelapse')).toBeInTheDocument();
    await loadVideo();
    expect(screen.getByText(/@ 1920x1080/)).toBeInTheDocument();

    const [trimStart, trimEnd] = screen.getAllByRole('slider');
    fireEvent.change(trimStart, { target: { value: '10' } });
    fireEvent.change(trimEnd, { target: { value: '40' } });
    // Handles cannot cross within a second of each other.
    fireEvent.change(trimStart, { target: { value: '39.5' } });
    fireEvent.change(trimEnd, { target: { value: '10.5' } });
    await user.click(screen.getByRole('button', { name: '2x' }));
    expect(screen.getByText(/2x \(output: 0:15\)/)).toBeInTheDocument();

    const file = new File(['mp3'], 'song.mp3', { type: 'audio/mpeg' });
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, file);
    expect(screen.getByText('song.mp3')).toBeInTheDocument();
    expect(screen.getByText(/\+ music overlay/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Save/ }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalled();
    // Multipart body: check each field and the attached file.
    for (const [field, value] of [['trim_start', '10'], ['trim_end', '40'], ['speed', '2'], ['save_mode', 'replace']]) {
      expect(processed).toMatch(new RegExp(`name="${field}"\\r\\n\\r\\n${value}\\r\\n`));
    }
    expect(processed).toContain('name="audio"');
    expect(await screen.findByText('Timelapse saved')).toBeInTheDocument();
  });

  it('plays from the trim start and loops within the trim range', async () => {
    useApi();
    const user = userEvent.setup();
    render(<TimelapseEditorModal archiveId={5} timelapseSrc="/t.mp4" onClose={vi.fn()} />);

    await screen.findByText('Edit Timelapse');
    await loadVideo();
    const el = video();
    fireEvent.change(screen.getAllByRole('slider')[0], { target: { value: '5' } });
    el.currentTime = 0;

    await user.click(document.querySelector('.absolute.inset-0.flex') as HTMLElement); // play overlay
    expect(el.currentTime).toBe(5);

    el.currentTime = 61;
    fireEvent(el, new Event('timeupdate'));
    expect(el.currentTime).toBe(5);

    // Scrubbing is clamped to the trim range.
    fireEvent.change(screen.getAllByRole('slider')[2], { target: { value: '1' } });
    expect(el.currentTime).toBe(5);

    await user.click(el); // pause
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  });

  it('mutes, adjusts and removes the music overlay', async () => {
    useApi();
    const user = userEvent.setup();
    render(<TimelapseEditorModal archiveId={5} timelapseSrc="/t.mp4" onClose={vi.fn()} />);

    await screen.findByText('Edit Timelapse');
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, new File(['a'], 'a.mp3'));
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, new File(['b'], 'b.mp3')).catch(() => {});
    const audio = document.querySelector('audio') as HTMLAudioElement;
    const row = screen.getByText('a.mp3').closest('.flex') as HTMLElement;
    const [mute, remove] = Array.from(row.querySelectorAll('button'));

    await user.click(mute);
    expect(audio.volume).toBe(0);
    await user.click(mute);
    fireEvent.change(row.querySelector('input[type="range"]')!, { target: { value: '0.3' } });
    expect(audio.volume).toBeCloseTo(0.3);

    await user.click(remove);
    expect(screen.queryByText('a.mp3')).not.toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:audio');
  });

  it('reports processing failures', async () => {
    useApi();
    server.use(
      http.post('/api/v1/archives/5/timelapse/process', () => HttpResponse.json({ detail: 'ffmpeg missing' }, { status: 500 })),
    );
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<TimelapseEditorModal archiveId={5} timelapseSrc="/t.mp4" onClose={onClose} />);

    await user.click(await screen.findByRole('button', { name: /Save/ }));

    expect(await screen.findByText('ffmpeg missing')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape and the X', async () => {
    useApi();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<TimelapseEditorModal archiveId={5} timelapseSrc="/t.mp4" onClose={onClose} />);

    const title = await screen.findByText('Edit Timelapse');
    fireEvent.keyDown(window, { key: 'Escape' });
    await user.click(title.parentElement!.querySelector('div > button:last-child') as HTMLElement);

    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
