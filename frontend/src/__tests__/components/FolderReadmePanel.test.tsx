/**
 * Tests for FolderReadmePanel (#1268).
 */

import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { FolderReadmePanel } from '../../components/FolderReadmePanel';
import { server } from '../mocks/server';

describe('FolderReadmePanel', () => {
  it('renders nothing when the folder has no markdown (404)', async () => {
    server.use(
      http.get('/api/v1/library/folders/:id/readme', () =>
        HttpResponse.json({ detail: 'No markdown' }, { status: 404 }),
      ),
    );
    render(<FolderReadmePanel folderId={1} />);
    // Wait briefly so the query has time to resolve, then confirm no panel
    // chrome leaked into the DOM (the test render util mounts toast/provider
    // wrappers, so we can't assert `container.firstChild === null`).
    await waitFor(() => {
      expect(screen.queryByText('Truncated')).not.toBeInTheDocument();
      expect(document.querySelector('button[type="button"] svg.lucide-file-text')).toBeNull();
    });
  });

  it('renders markdown content and the filename when present', async () => {
    server.use(
      http.get('/api/v1/library/folders/:id/readme', () =>
        HttpResponse.json({
          filename: 'README.md',
          content: '# Robot model\n\nA cute robot.',
          truncated: false,
        }),
      ),
    );
    render(<FolderReadmePanel folderId={42} />);
    expect(await screen.findByText('README.md')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Robot model' })).toBeInTheDocument();
    expect(screen.getByText('A cute robot.')).toBeInTheDocument();
  });

  it('shows a Truncated chip when the API flags the content as clipped', async () => {
    server.use(
      http.get('/api/v1/library/folders/:id/readme', () =>
        HttpResponse.json({
          filename: 'description.md',
          content: 'very long content',
          truncated: true,
        }),
      ),
    );
    render(<FolderReadmePanel folderId={7} />);
    expect(await screen.findByText('Truncated')).toBeInTheDocument();
  });
});

describe('FolderReadmePanel GFM support without autolink literals (#86)', () => {
  it('keeps tables, strikethrough, task lists, and footnotes working', async () => {
    server.use(
      http.get('/api/v1/library/folders/:id/readme', () =>
        HttpResponse.json({
          filename: 'README.md',
          content: [
            '| Part | Filament |',
            '| --- | --- |',
            '| Body | PLA |',
            '',
            'Print at ~~0.2mm~~ 0.16mm.',
            '',
            '- [x] Sliced',
            '- [ ] Printed',
            '',
            'Supports supports[^1]',
            '',
            '[^1]: Tree, 0.4mm.',
          ].join('\n'),
          truncated: false,
        }),
      ),
    );

    render(<FolderReadmePanel folderId={86} />);

    expect(await screen.findByRole('columnheader', { name: 'Part' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Body' })).toBeInTheDocument();
    expect(screen.getByText(/0\.16mm\./)).toBeInTheDocument();
    expect(screen.getByText('0.2mm').tagName).toBe('DEL');

    const checkboxes = await screen.findAllByRole('checkbox');
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]).toBeChecked();
    expect(checkboxes[1]).not.toBeChecked();

    expect(await screen.findByRole('link', { name: '1' })).toHaveAttribute('href', '#user-content-fn-1');
    expect(screen.getByText('Tree, 0.4mm.')).toBeInTheDocument();
  });

  it('keeps explicit links while leaving bare URLs and emails as plain text', async () => {
    server.use(
      http.get('/api/v1/library/folders/:id/readme', () =>
        HttpResponse.json({
          filename: 'README.md',
          content: [
            '[the model](https://example.com/model)',
            '',
            '<https://example.com/angle>',
            '',
            'Bare URL: https://example.com/plain',
            '',
            'Bare email: maker@example.com',
          ].join('\n'),
          truncated: false,
        }),
      ),
    );

    render(<FolderReadmePanel folderId={86} />);

    expect(await screen.findByRole('link', { name: 'the model' })).toHaveAttribute('href', 'https://example.com/model');
    expect(screen.getByRole('link', { name: 'https://example.com/angle' })).toHaveAttribute(
      'href',
      'https://example.com/angle',
    );
    expect(screen.getByText('Bare URL: https://example.com/plain')).toBeInTheDocument();
    expect(screen.getByText('Bare email: maker@example.com')).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });
});
