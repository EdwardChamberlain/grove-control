export function formatWeight(g: number, useKg = false): string {
  if (useKg && g >= 1000) return `${(g / 1000).toFixed(1)}kg`;
  return `${Math.round(g)}g`;
}
