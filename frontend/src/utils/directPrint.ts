export function isDirectPrintFile(file: File): boolean {
  const lower = file.name.toLowerCase();
  return lower.endsWith('.gcode') || lower.endsWith('.gcode.3mf');
}
