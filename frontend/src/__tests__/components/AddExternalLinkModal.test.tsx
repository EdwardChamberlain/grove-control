/**
 * AddExternalLinkModal: validation, creating and editing links, and custom
 * icon upload / removal.
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { AddExternalLinkModal } from '../../components/AddExternalLinkModal';

const existing = {
  id: 4,
  name: 'Wiki',
  url: 'https://wiki.example',
  icon: 'book',
  open_in_new_tab: true,
  custom_icon: 'wiki.png',
  sort_order: 0,
};

function useApi() {
  const calls = { created: [] as unknown[], updated: [] as unknown[], iconUploads: 0, iconDeletes: 0 };
  server.use(
    http.post('/api/v1/external-links/', async ({ request }) => {
      calls.created.push(await request.json());
      return HttpResponse.json({ ...existing, id: 9, custom_icon: null });
    }),
    http.patch('/api/v1/external-links/:id', async ({ request }) => {
      calls.updated.push(await request.json());
      return HttpResponse.json(existing);
    }),
    http.post('/api/v1/external-links/:id/icon', () => {
      calls.iconUploads += 1;
      return HttpResponse.json(existing);
    }),
    http.delete('/api/v1/external-links/:id/icon', () => {
      calls.iconDeletes += 1;
      return HttpResponse.json({ ...existing, custom_icon: null });
    }),
  );
  return calls;
}

function fileInput(): HTMLInputElement {
  return document.querySelector('input[type="file"]') as HTMLInputElement;
}

describe('AddExternalLinkModal', () => {
  it('validates name and URL before saving', async () => {
    const calls = useApi();
    const user = userEvent.setup();
    render(<AddExternalLinkModal onClose={vi.fn()} />);

    const submit = screen.getByRole('button', { name: /^Add$/ });
    await user.click(submit);
    expect(screen.getByText('Name is required')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('My Link'), 'Docs');
    await user.click(submit);
    expect(screen.getByText('URL is required')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('https://example.com'), 'ftp://docs');
    await user.click(submit);
    expect(screen.getByText('URL must start with http:// or https://')).toBeInTheDocument();
    expect(calls.created).toEqual([]);
  });

  it('creates a link and uploads its icon', async () => {
    const calls = useApi();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<AddExternalLinkModal onClose={onClose} />);

    await user.type(screen.getByPlaceholderText('My Link'), ' Docs ');
    await user.type(screen.getByPlaceholderText('https://example.com'), 'https://docs.example');
    const toggle = screen.getByText('Open in new tab').parentElement!.querySelector('button')!;
    await user.click(toggle);
    await user.upload(fileInput(), new File(['png'], 'icon.png', { type: 'image/png' }));
    expect(await screen.findByAltText('Custom icon')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Add$/ }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.created).toEqual([{ name: 'Docs', url: 'https://docs.example', icon: 'link', open_in_new_tab: true }]);
    expect(calls.iconUploads).toBe(1);
  });

  it('rejects icons of the wrong type or size', async () => {
    useApi();
    render(<AddExternalLinkModal onClose={vi.fn()} />);

    fireEvent.change(fileInput(), { target: { files: [new File(['x'], 'a.txt', { type: 'text/plain' })] } });
    expect(screen.getByText(/valid image file/)).toBeInTheDocument();

    const big = new File([new Uint8Array(1024 * 1024 + 1)], 'big.png', { type: 'image/png' });
    fireEvent.change(fileInput(), { target: { files: [big] } });
    expect(screen.getByText('Image file must be less than 1MB')).toBeInTheDocument();
    expect(screen.queryByAltText('Custom icon')).not.toBeInTheDocument();
  });

  it('edits a link, switching from a custom icon back to a preset', async () => {
    const calls = useApi();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<AddExternalLinkModal link={existing} onClose={onClose} />);

    expect(screen.getByText('Edit Link')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Wiki')).toBeInTheDocument();
    await user.click(screen.getByTitle('Remove custom icon'));
    expect(screen.getByText('Or choose a preset icon')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.updated).toEqual([{ name: 'Wiki', url: 'https://wiki.example', icon: 'book', open_in_new_tab: true }]);
    expect(calls.iconDeletes).toBe(1);
  });

  it('uploads a replacement icon when editing', async () => {
    const calls = useApi();
    const user = userEvent.setup();
    render(<AddExternalLinkModal link={{ ...existing, custom_icon: null }} onClose={vi.fn()} />);

    await user.upload(fileInput(), new File(['png'], 'icon.png', { type: 'image/png' }));
    await user.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => expect(calls.iconUploads).toBe(1));
  });

  it('shows server errors', async () => {
    useApi();
    server.use(http.post('/api/v1/external-links/', () => HttpResponse.json({ detail: 'Duplicate name' }, { status: 400 })));
    const user = userEvent.setup();
    render(<AddExternalLinkModal onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('My Link'), 'Docs');
    await user.type(screen.getByPlaceholderText('https://example.com'), 'https://docs.example');
    await user.click(screen.getByRole('button', { name: /^Add$/ }));

    expect(await screen.findByText('Duplicate name')).toBeInTheDocument();
  });

  it('closes on Escape, cancel and the X', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<AddExternalLinkModal onClose={onClose} />);

    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'Enter' });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByText('Add External Link').parentElement!.parentElement!.querySelector('button')!);

    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
