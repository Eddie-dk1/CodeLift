import type {
  AnalysisResult,
  DependencyClassification,
  ExportResult,
  ExtractionPlan,
  VerificationResult,
} from "@codelift/core";

export interface StudioSession {
  projectName: string;
  projectRoot: string;
  tsconfigs: string[];
  sourceFiles: string[];
  initialTsconfig: string | null;
  initialEntrypoint: string | null;
  ambiguousTsconfig: boolean;
  capabilities: {
    profiles: string[];
    sourcePreview: boolean;
    extraction: boolean;
    verification: boolean;
  };
}

export interface SourcePreview {
  path: string;
  content: string;
}

export interface StudioJob {
  id: string;
  type: "export" | "verify";
  status: "running" | "completed" | "failed" | "cancelled";
  message: string;
  destination?: string;
  result?: ExportResult | VerificationResult;
  error?: string;
}

export interface PlanResponse {
  planId: string;
  plan: ExtractionPlan;
}

function sessionToken(): string {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const incoming = hash.get("token");
  if (incoming) {
    window.sessionStorage.setItem("codelift-token", incoming);
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    return incoming;
  }
  return window.sessionStorage.getItem("codelift-token") ?? "";
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-codelift-token": sessionToken(),
      ...init?.headers,
    },
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed with status ${response.status}.`);
  return body;
}

export function getSession(): Promise<StudioSession> {
  return request<StudioSession>("/api/session");
}

export function runAnalysis(tsconfigPath: string, entrypoint: string): Promise<AnalysisResult> {
  return request<AnalysisResult>("/api/analyze", {
    method: "POST",
    body: JSON.stringify({ tsconfigPath, entrypoint }),
  });
}

export function getSource(path: string): Promise<SourcePreview> {
  return request<SourcePreview>(`/api/source?path=${encodeURIComponent(path)}`);
}

export function createPlan(input: {
  tsconfigPath: string;
  entrypoint: string;
  packageName: string;
  destination: string;
  acceptedWarningIds?: string[];
  dependencyOverrides?: Record<string, DependencyClassification>;
  copyLicense?: boolean;
}): Promise<PlanResponse> {
  return request<PlanResponse>("/api/plan", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function startExport(planId: string, confirmation: string): Promise<string> {
  const response = await request<{ jobId: string }>("/api/export", {
    method: "POST",
    body: JSON.stringify({ planId, confirmation }),
  });
  return response.jobId;
}

export async function startVerification(
  packageRoot: string,
  install: boolean,
  allowInstallScripts = false,
): Promise<string> {
  const response = await request<{ jobId: string }>("/api/verify", {
    method: "POST",
    body: JSON.stringify({ packageRoot, install, allowInstallScripts }),
  });
  return response.jobId;
}

export function getJob(jobId: string): Promise<StudioJob> {
  return request<StudioJob>(`/api/jobs/${encodeURIComponent(jobId)}`);
}

export function cancelJob(jobId: string): Promise<StudioJob> {
  return request<StudioJob>(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
}
