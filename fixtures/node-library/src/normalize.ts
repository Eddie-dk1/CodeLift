export function normalizeLabel(value: string): string {
  return value.trim().toLowerCase().replaceAll(" ", "-");
}
