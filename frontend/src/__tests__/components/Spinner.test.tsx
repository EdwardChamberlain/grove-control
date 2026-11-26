import { describe, it, expect } from 'vitest';
import { render } from '../utils';
import { Spinner } from '../../components/Spinner';

describe('Spinner', () => {
  it('renders a decorative svg that inherits the text colour', () => {
    const { container } = render(<Spinner className="w-4 h-4 text-bambu-green" />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg).toHaveClass('spinner', 'w-4', 'h-4', 'text-bambu-green');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('fill', 'currentColor');
  });

  it('draws the bed, three layers and the nozzle', () => {
    const { container } = render(<Spinner />);
    expect(container.querySelectorAll('rect')).toHaveLength(4);
    expect(container.querySelectorAll('.spinner-nozzle')).toHaveLength(1);
  });

  it('passes extra props through to the svg', () => {
    const { container } = render(<Spinner data-testid="busy" />);
    expect(container.querySelector('[data-testid="busy"]')).not.toBeNull();
  });
});
