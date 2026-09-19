import type { AnalysisResult } from "@codelift/core";
import { CheckCircle2, CircleAlert, LoaderCircle } from "lucide-react";
import styles from "./StatusBar.module.css";

interface StatusBarProps {
  result: AnalysisResult | null;
  loading: boolean;
  error: string | null;
}

export function StatusBar({ result, loading, error }: StatusBarProps) {
  if (loading) {
    return (
      <footer className={styles.bar}>
        <LoaderCircle className={styles.spin} size={15} />
        <span>Analyzing project…</span>
      </footer>
    );
  }
  if (error) {
    return (
      <footer className={`${styles.bar} ${styles.error}`}>
        <CircleAlert size={15} />
        <span>{error}</span>
      </footer>
    );
  }
  if (!result) {
    return <footer className={styles.bar}>Select an entrypoint to begin.</footer>;
  }
  return (
    <footer className={styles.bar}>
      <span className={styles.complete}>
        <CheckCircle2 size={15} /> Analysis complete
      </span>
      <span>{result.stats.localFiles} files included</span>
      <span>{result.stats.externalPackages} external dependencies</span>
      <span>{result.stats.issues} issues</span>
      <span>{result.stats.unresolvedImports} unresolved imports</span>
      <span>Completed in {result.stats.durationMs} ms</span>
    </footer>
  );
}
