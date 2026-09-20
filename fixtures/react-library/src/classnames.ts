export function joinClassNames(...names: string[]) {
  return names.filter(Boolean).join(" ");
}
