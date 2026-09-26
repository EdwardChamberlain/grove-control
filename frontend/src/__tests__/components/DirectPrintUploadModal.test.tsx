import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { DirectPrintUploadModal } from '../../components/DirectPrintUploadModal';
import { render } from '../utils';
import { server } from '../mocks/server';

describe('DirectPrintUploadModal', () => {
  const onClose = vi.fn();
  const onFileUploaded = vi.fn();
  let uploadRequests = 0;

  beforeEach(() => {
    vi.clearAllMocks();
    uploadRequests = 0;
    server.use(
      http.post('/api/v1/queue/upload-source', () => {
        uploadRequests += 1;
        return HttpResponse.json({
          id: 41,
          filename: 'direct-print.gcode.3mf',
          file_type: '3mf',
          file_size: 128,
          thumbnail_path: null,
          duplicate_of: null,
          metadata: { sliced_for_model: 'X1C' },
        });
      }),
    );
  });

  it('accepts one .gcode.3mf upload through the native picker', async () => {
    const user = userEvent.setup();
    render(<DirectPrintUploadModal onClose={onClose} onFileUploaded={onFileUploaded} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.multiple).toBe(false);
    expect(input.accept).toBe('.gcode,.3mf');

    await user.upload(input, new File(['gcode'], 'part.gcode.3mf', { type: 'application/octet-stream' }));

    await waitFor(() => expect(uploadRequests).toBe(1));
    expect(onFileUploaded).toHaveBeenCalledWith(expect.objectContaining({ filename: 'direct-print.gcode.3mf' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('rejects a plain .3mf after the picker allows the compound .gcode.3mf extension', async () => {
    const user = userEvent.setup();
    render(<DirectPrintUploadModal onClose={onClose} onFileUploaded={onFileUploaded} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File(['project'], 'project.3mf', { type: 'application/octet-stream' }));

    expect(await screen.findByText('Only .gcode and .gcode.3mf files can be printed', { selector: 'p' })).toBeInTheDocument();
    expect(uploadRequests).toBe(0);
    expect(onFileUploaded).not.toHaveBeenCalled();
  });

  it('rejects multi-file drops just like the printer-card Print flow', () => {
    render(<DirectPrintUploadModal onClose={onClose} onFileUploaded={onFileUploaded} />);

    const dropZone = screen.getByText('Drop one file here').parentElement!;
    fireEvent.drop(dropZone, {
      dataTransfer: {
        files: [
          new File(['one'], 'one.gcode', { type: 'application/octet-stream' }),
          new File(['two'], 'two.gcode.3mf', { type: 'application/octet-stream' }),
        ],
      },
    });

    expect(screen.getByText('Select one file at a time')).toBeInTheDocument();
    expect(uploadRequests).toBe(0);
  });
});
