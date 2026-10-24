/**
 * Link into the Files page. `file` opens the file's folder and highlights it;
 * `folder` is optional and only lets the page start in the right folder
 * before the file itself has loaded.
 */
export function filesLink({ fileId, folderId }: { fileId?: number | null; folderId?: number | null }): string {
  const params = new URLSearchParams();
  if (folderId != null) params.set('folder', String(folderId));
  if (fileId != null) params.set('file', String(fileId));
  const query = params.toString();
  return query ? `/files?${query}` : '/files';
}
