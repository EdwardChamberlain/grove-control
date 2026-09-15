// Only accept same-origin internal paths. Reject protocol-relative (`//evil.com`),
// backslash-normalized external URLs, absolute URLs, and the login page itself
// (which would loop). Anything else falls back to `/` so a tampered
// sessionStorage entry cannot open-redirect.
export function sanitizeRedirectTarget(target: string | null | undefined): string | null {
  if (!target) return null;
  if (!target.startsWith('/')) return null;
  if (target.startsWith('//')) return null;
  if (target.includes('\\')) return null;
  if (target.startsWith('/login')) return null;
  return target;
}
