import type { SVGProps } from 'react';

/**
 * Loading indicator: a nozzle lays down three layers from the bed upwards,
 * alternating left to right. Everything draws with `currentColor`, so it follows
 * the surrounding text colour (usually `text-bambu-green`, which tracks the
 * accent colour setting). Size it with `w-*`/`h-*` classes like any icon.
 *
 * The animation lives in `index.css` (`.spinner`) and falls back to a gentle
 * pulse when the user prefers reduced motion.
 */
export function Spinner({ className = '', ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={`spinner ${className}`.trim()}
      {...props}
    >
      <rect x="2" y="21.5" width="20" height="1.6" rx="0.8" opacity="0.45" />
      <rect className="spinner-l1" x="4" y="17.5" width="16" height="3" rx="1.5" />
      <rect className="spinner-l2" x="4" y="13" width="16" height="3" rx="1.5" />
      <rect className="spinner-l3" x="4" y="8.5" width="16" height="3" rx="1.5" />
      <polygon className="spinner-nozzle" points="-2.4,-5.8 2.4,-5.8 2.4,-4 0.7,-1.9 -0.7,-1.9 -2.4,-4" />
    </svg>
  );
}
