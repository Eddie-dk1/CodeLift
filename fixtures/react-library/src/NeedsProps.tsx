export default function NeedsProps({ label }: { label: string }) {
  if (!label) throw new Error("A label is required.");
  return <span>{label}</span>;
}
