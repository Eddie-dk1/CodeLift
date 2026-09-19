import type { AnalysisResult } from "@codelift/core";

export interface StudioSession {
  projectName: string;
  projectRoot: string;
  tsconfigs: string[];
  sourceFiles: string[];
  initialTsconfig: string | null;
  initialEntrypoint: string | null;
  capabilities: {
    profile: string;
    sourcePreview: boolean;
    extraction: boolean;
  };
}

export interface SourcePreview {
  path: string;
  content: string;
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
