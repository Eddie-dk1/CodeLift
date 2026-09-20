import type {
  AnalysisResult,
  DependencyClassification,
  ExportResult,
  ExtractionPlan,
  VerificationResult,
} from "@codelift/core";
import {
  Check,
  CircleAlert,
  LoaderCircle,
  PackageCheck,
  Scissors,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  cancelJob,
  createPlan,
  getJob,
  type StudioJob,
  startExport,
  startVerification,
} from "../lib/api.js";
import styles from "./WorkflowPanel.module.css";

interface WorkflowPanelProps {
  analysis: AnalysisResult;
  tsconfigPath: string;
  entrypoint: string;
}

function suggestedName(entrypoint: string): string {
  const name =
    entrypoint
      .split("/")
      .at(-1)
      ?.replace(/\.(?:mts|tsx|ts)$/u, "") ?? "extracted-package";
  return name
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .toLowerCase();
}

function isExportResult(result: StudioJob["result"]): result is ExportResult {
  return Boolean(result && "planDigest" in result);
}

function isVerificationResult(result: StudioJob["result"]): result is VerificationResult {
  return Boolean(result && "checks" in result);
}

async function waitForJob(jobId: string, onUpdate: (job: StudioJob) => void): Promise<StudioJob> {
  for (;;) {
    const job = await getJob(jobId);
    onUpdate(job);
    if (job.status !== "running") return job;
    await new Promise((resolve) => window.setTimeout(resolve, 450));
  }
}

export function WorkflowPanel({ analysis, tsconfigPath, entrypoint }: WorkflowPanelProps) {
  const [packageName, setPackageName] = useState(() => suggestedName(entrypoint));
  const [destination, setDestination] = useState("");
  const [acceptWarnings, setAcceptWarnings] = useState(false);
  const [copyLicense, setCopyLicense] = useState(false);
  const [dependencyOverrides, setDependencyOverrides] = useState<
    Record<string, DependencyClassification>
  >({});
  const [planId, setPlanId] = useState<string | null>(null);
  const [plan, setPlan] = useState<ExtractionPlan | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [job, setJob] = useState<StudioJob | null>(null);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [verification, setVerification] = useState<VerificationResult | null>(null);
  const [install, setInstall] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    setPackageName(suggestedName(entrypoint));
    setDestination("");
    setAcceptWarnings(false);
    setCopyLicense(false);
    setDependencyOverrides({});
    setPlanId(null);
    setPlan(null);
    setConfirmation("");
    setJob(null);
    setExportResult(null);
    setVerification(null);
    setError(null);
  }, [entrypoint]);

  const warnings = useMemo(() => analysis.issues.filter((issue) => !issue.blocking), [analysis]);
  const step = verification ? 4 : exportResult ? 3 : plan ? 2 : 1;

  const makePlan = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await createPlan({
        tsconfigPath,
        entrypoint,
        packageName,
        destination,
        ...(acceptWarnings ? { acceptedWarningIds: warnings.map((issue) => issue.id) } : {}),
        ...(Object.keys(dependencyOverrides).length > 0 ? { dependencyOverrides } : {}),
        ...(copyLicense ? { copyLicense: true } : {}),
      });
      setPlanId(response.planId);
      setPlan(response.plan);
      setConfirmation("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const runExport = async () => {
    if (!planId) return;
    const currentGeneration = generation.current;
    setBusy(true);
    setError(null);
    try {
      const jobId = await startExport(planId, confirmation);
      const completed = await waitForJob(jobId, (next) => {
        if (generation.current === currentGeneration) setJob(next);
      });
      if (completed.status === "failed") throw new Error(completed.error ?? "Export failed.");
      if (completed.status === "cancelled") return;
      if (isExportResult(completed.result)) setExportResult(completed.result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const runVerify = async () => {
    if (!exportResult) return;
    const currentGeneration = generation.current;
    setBusy(true);
    setError(null);
    try {
      const jobId = await startVerification(exportResult.destination, install);
      const completed = await waitForJob(jobId, (next) => {
        if (generation.current === currentGeneration) setJob(next);
      });
      if (completed.status === "failed") throw new Error(completed.error ?? "Verification failed.");
      if (isVerificationResult(completed.result)) setVerification(completed.result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const stopJob = async () => {
    if (job?.status !== "running") return;
    setJob(await cancelJob(job.id));
  };

  return (
    <section className={styles.panel} aria-label="Extraction workflow">
      <div className={styles.title}>
        <Scissors size={16} /> Extract package
      </div>
      <div className={styles.steps}>
        {["Plan", "Review", "Export", "Verify"].map((label, index) => (
          <span key={label} className={index + 1 <= step ? styles.activeStep : ""}>
            {index + 1 < step ? <Check size={11} /> : index + 1} {label}
          </span>
        ))}
      </div>

      {!plan ? (
        <div className={styles.form}>
          <label>
            Package name
            <input value={packageName} onChange={(event) => setPackageName(event.target.value)} />
          </label>
          <label>
            New destination
            <input
              value={destination}
              placeholder="/absolute/path/to/new-package"
              onChange={(event) => setDestination(event.target.value)}
            />
          </label>
          <small>The destination must not exist and must stay outside the source project.</small>
          {warnings.length > 0 ? (
            <label className={styles.checkLabel}>
              <input
                type="checkbox"
                checked={acceptWarnings}
                onChange={(event) => setAcceptWarnings(event.target.checked)}
              />
              Accept {warnings.length} analysis warning{warnings.length === 1 ? "" : "s"}
            </label>
          ) : null}
          <label className={styles.checkLabel}>
            <input
              type="checkbox"
              checked={copyLicense}
              onChange={(event) => setCopyLicense(event.target.checked)}
            />
            Copy the source LICENSE when one exists
          </label>
          {analysis.externalPackages.filter(
            (dependency) => dependency.name !== "react" && dependency.name !== "react-dom",
          ).length > 0 ? (
            <div className={styles.dependencies}>
              <strong>Dependency handling</strong>
              {analysis.externalPackages
                .filter(
                  (dependency) => dependency.name !== "react" && dependency.name !== "react-dom",
                )
                .map((dependency) => (
                  <label key={dependency.name}>
                    {dependency.name}
                    <select
                      value={dependencyOverrides[dependency.name] ?? "dependencies"}
                      onChange={(event) =>
                        setDependencyOverrides((current) => ({
                          ...current,
                          [dependency.name]: event.target.value as DependencyClassification,
                        }))
                      }
                    >
                      <option value="dependencies">dependency</option>
                      <option value="peerDependencies">peer dependency</option>
                      <option value="devDependencies">development only</option>
                    </select>
                  </label>
                ))}
            </div>
          ) : null}
          <button
            disabled={busy || !packageName || !destination}
            type="button"
            onClick={() => void makePlan()}
          >
            {busy ? <LoaderCircle className={styles.spin} size={14} /> : <Scissors size={14} />}
            Create plan
          </button>
        </div>
      ) : (
        <div className={styles.review}>
          <div className={styles.summary}>
            <span
              className={
                plan.status === "ready"
                  ? styles.ready
                  : plan.status === "review"
                    ? styles.reviewStatus
                    : styles.blocked
              }
            >
              {plan.status}
            </span>
            <strong>{plan.files.length} files</strong>
            <strong>{plan.rewrites.length} rewrites</strong>
            <strong>{plan.dependencyDecisions.length} dependency decisions</strong>
          </div>
          <code className={styles.destination}>{plan.target.destination}</code>
          <details>
            <summary>Planned files</summary>
            <ul>
              {plan.files.map((file) => (
                <li key={file.source}>
                  <code>{file.source}</code> → <code>{file.destination}</code>
                </li>
              ))}
            </ul>
          </details>
          {plan.rewrites.length > 0 ? (
            <details>
              <summary>Import rewrites</summary>
              <ul>
                {plan.rewrites.map((rewrite) => (
                  <li key={`${rewrite.file}:${rewrite.location.line}:${rewrite.from}`}>
                    <code>{rewrite.from}</code> → <code>{rewrite.to}</code>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          {!exportResult ? (
            <>
              {plan.status !== "ready" ? (
                <p className={styles.problem}>
                  <CircleAlert size={14} /> This plan cannot be exported until its issues are
                  resolved.
                </p>
              ) : (
                <label>
                  Type <strong>{plan.target.packageName}</strong> to confirm
                  <input
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                  />
                </label>
              )}
              <div className={styles.actions}>
                <button
                  className={styles.secondary}
                  type="button"
                  disabled={busy}
                  onClick={() => setPlan(null)}
                >
                  Edit plan
                </button>
                <button
                  type="button"
                  disabled={
                    busy || plan.status !== "ready" || confirmation !== plan.target.packageName
                  }
                  onClick={() => void runExport()}
                >
                  {busy ? (
                    <LoaderCircle className={styles.spin} size={14} />
                  ) : (
                    <PackageCheck size={14} />
                  )}
                  Export
                </button>
              </div>
            </>
          ) : (
            <div className={styles.verify}>
              <p className={styles.success}>
                <PackageCheck size={14} /> Exported without changing the source project.
              </p>
              <label className={styles.checkLabel}>
                <input
                  type="checkbox"
                  checked={install}
                  onChange={(event) => setInstall(event.target.checked)}
                />
                Install dependencies in an isolated copy and run build
              </label>
              <small>
                {install
                  ? "Runs npm install --ignore-scripts, then only CodeLift-generated build and smoke commands."
                  : "Runs structural checks only; install, build, and smoke checks will be marked not-run."}
              </small>
              {!verification ? (
                <button disabled={busy} type="button" onClick={() => void runVerify()}>
                  {busy ? (
                    <LoaderCircle className={styles.spin} size={14} />
                  ) : (
                    <ShieldCheck size={14} />
                  )}
                  Verify package
                </button>
              ) : (
                <div className={styles.report}>
                  <strong>Verification: {verification.status}</strong>
                  {verification.checks.map((check) => (
                    <div key={check.id}>
                      <span>
                        {check.status === "passed" ? (
                          <Check size={12} />
                        ) : (
                          <CircleAlert size={12} />
                        )}
                      </span>
                      <span>{check.label}</span>
                      <code>{check.status}</code>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {job?.status === "running" ? (
        <div className={styles.job}>
          <LoaderCircle className={styles.spin} size={13} /> {job.message}
          <button type="button" onClick={() => void stopJob()}>
            <X size={12} /> Cancel
          </button>
        </div>
      ) : null}
      {error ? <p className={styles.problem}>{error}</p> : null}
    </section>
  );
}
