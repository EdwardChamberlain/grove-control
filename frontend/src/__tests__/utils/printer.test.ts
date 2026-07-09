import { describe, expect, it } from 'vitest';
import { getPrinterImage } from '../../utils/printer';

describe('getPrinterImage', () => {
  it('resolves X2D identifiers', () => {
    expect(getPrinterImage('X2D')).toBe('/img/printers/x2d.png');
    expect(getPrinterImage('N6')).toBe('/img/printers/x2d.png');
  });
});
