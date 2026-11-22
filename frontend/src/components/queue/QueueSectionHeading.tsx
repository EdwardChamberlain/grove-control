interface QueueSectionHeadingProps {
  label: string;
  count: number;
  /** `kiosk` is the larger read-from-a-distance size. */
  size?: 'queue' | 'kiosk';
  testId?: string;
  className?: string;
}

/** Heading above a group of queue job lines: the group name, its count and a thin rule. */
export function QueueSectionHeading({ label, count, size = 'queue', testId, className = '' }: QueueSectionHeadingProps) {
  const k = size === 'kiosk';
  return (
    <div data-testid={testId} className={`flex items-center ${k ? 'gap-4' : 'gap-3'} ${className}`}>
      <h2 className={`font-bold uppercase tracking-[0.1em] text-white ${k ? 'text-[15px]' : 'text-[13px]'}`}>{label}</h2>
      <span className={`font-semibold tabular-nums text-bambu-gray-light ${k ? 'text-[15px]' : 'text-[13px]'}`}>{count}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-bambu-dark-tertiary" />
    </div>
  );
}
