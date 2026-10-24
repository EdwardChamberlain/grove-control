import { describe, it, expect } from 'vitest';
import { filesLink } from '../../utils/filesLink';

describe('filesLink', () => {
  it('links to the Files root with no target', () => {
    expect(filesLink({})).toBe('/files');
    expect(filesLink({ fileId: null, folderId: null })).toBe('/files');
  });

  it('links to a file on its own', () => {
    expect(filesLink({ fileId: 7 })).toBe('/files?file=7');
  });

  it('adds the folder when it is known', () => {
    expect(filesLink({ fileId: 7, folderId: 3 })).toBe('/files?folder=3&file=7');
  });

  it('links to a folder when there is no file', () => {
    expect(filesLink({ folderId: 3 })).toBe('/files?folder=3');
  });
});
