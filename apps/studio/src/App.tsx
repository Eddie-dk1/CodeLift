import {
  Background,
  BackgroundVariant,
  Controls,
  type NodeMouseHandler,
  ReactFlow,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import "@xyflow/react/dist/style.css";
import type { AnalysisResult, GraphNode } from "@codelift/core";
import {
  Box,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  FileCode2,
  FolderOpen,
  Play,
  RefreshCw,
  Route,
  Search,
  ShieldCheck,
} from "lucide-react";
import styles from "./App.module.css";
import { DependencyNode } from "./components/DependencyNode.js";
import { StatusBar } from "./components/StatusBar.js";
import { getSession, getSource, runAnalysis, type StudioSession } from "./lib/api.js";
import { layoutGraph } from "./lib/graph-layout.js";

const nodeTypes = { dependency: DependencyNode };

function nodeTitle(node: GraphNode | undefined): string {
  return node?.path ?? node?.packageName ?? node?.builtinName ?? node?.label ?? "Nothing selected";
}

export function App() {
  const [session, setSession] = useState<StudioSession | null>(null);
  const [tsconfigPath, setTsconfigPath] = useState("");
  const [entrypoint, setEntrypoint] = useState("");
  const [entryFilter, setEntryFilter] = useState("");
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourcePreview, setSourcePreview] = useState<{ path: string; content: string } | null>(
    null,
  );

  const analyze = useCallback(async (config: string, entry: string) => {
    if (!config || !entry) return;
    setLoading(true);
    setError(null);
    setSourcePreview(null);
    try {
      const next = await runAnalysis(config, entry);
      setResult(next);
      const entryNode = next.nodes.find((node) => node.path === next.entrypoint);
      setSelectedNodeId(entryNode?.id ?? next.nodes[0]?.id ?? null);
    } catch (analysisError) {
      setResult(null);
      setError(analysisError instanceof Error ? analysisError.message : String(analysisError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    getSession()
      .then((nextSession) => {
        if (!active) return;
        setSession(nextSession);
        const config = nextSession.initialTsconfig ?? nextSession.tsconfigs[0] ?? "";
        const entry = nextSession.initialEntrypoint ?? "";
        setTsconfigPath(config);
        setEntrypoint(entry);
        if (config && entry) void analyze(config, entry);
      })
      .catch((sessionError) => {
        if (active)
          setError(sessionError instanceof Error ? sessionError.message : String(sessionError));
      });
    return () => {
      active = false;
    };
  }, [analyze]);

  const graph = useMemo(() => (result ? layoutGraph(result) : { nodes: [], edges: [] }), [result]);
  const selectedNode = result?.nodes.find((node) => node.id === selectedNodeId);
  const selectedReason = result?.reasons.find((reason) => reason.nodeId === selectedNodeId);
  const reasonNodes =
    selectedReason?.nodePath
      .map((nodeId) => result?.nodes.find((node) => node.id === nodeId))
      .filter((node): node is GraphNode => Boolean(node)) ?? [];
  const primaryEdgeId = selectedReason?.edgePath.at(-1);
  const primaryEdge = result?.edges.find((edge) => edge.id === primaryEdgeId);
  const selectedIssues =
    result?.issues.filter(
      (issue) => issue.nodeId === selectedNodeId || issue.location?.path === selectedNode?.path,
    ) ?? [];
  const filteredEntries =
    session?.sourceFiles.filter((file) => file.toLowerCase().includes(entryFilter.toLowerCase())) ??
    [];

  const selectNode: NodeMouseHandler = (_event, node) => {
    setSelectedNodeId(node.id);
    setSourcePreview(null);
  };

  const revealSource = async () => {
    if (!selectedNode?.path) return;
    try {
      setSourcePreview(await getSource(selectedNode.path));
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : String(previewError));
    }
  };

  return (
    <main className={styles.shell}>
      <header className={styles.topbar}>
        <div className={styles.brand}>
          <span className={styles.mark}>CL</span>
          <strong>CodeLift</strong>
        </div>
        <div className={styles.projectPath} title={session?.projectRoot}>
          <FolderOpen size={15} />
          <span>{session?.projectRoot ?? "Connecting to local project…"}</span>
        </div>
        <div className={styles.compactField}>
          <div className={styles.configLabel}>
            <label htmlFor="compiler-config">Compiler config</label>
            <button
              className={styles.configHelp}
              type="button"
              aria-label="Explain compiler config"
            >
              <CircleHelp size={13} aria-hidden="true" />
              <span className={styles.configTooltip} id="compiler-config-help" role="tooltip">
                <strong>How CodeLift reads the project</strong>
                <span>
                  Controls import resolution, path aliases, and module settings. Choose the config
                  that owns the selected entrypoint.
                </span>
              </span>
            </button>
          </div>
          <select
            id="compiler-config"
            aria-label="TypeScript configuration"
            aria-describedby="compiler-config-help"
            value={tsconfigPath}
            onChange={(event) => setTsconfigPath(event.target.value)}
          >
            {session?.tsconfigs.map((config) => (
              <option key={config} value={config}>
                {config}
              </option>
            ))}
          </select>
        </div>
        <button
          className={styles.analyzeButton}
          type="button"
          disabled={!entrypoint || !tsconfigPath || loading}
          onClick={() => void analyze(tsconfigPath, entrypoint)}
        >
          {loading ? (
            <RefreshCw className={styles.spin} size={16} />
          ) : (
            <Play size={16} fill="currentColor" />
          )}
          Analyze
        </button>
      </header>

      <aside className={styles.sidebar} aria-label="Analysis inputs and included files">
        <section className={styles.entrySection}>
          <div className={styles.sectionLabel}>Entrypoint</div>
          <div className={styles.searchField}>
            <Search size={14} />
            <input
              aria-label="Filter entrypoints"
              placeholder="Filter TypeScript files"
              value={entryFilter}
              onChange={(event) => setEntryFilter(event.target.value)}
            />
          </div>
          <select
            className={styles.entrySelect}
            aria-label="Entrypoint"
            value={entrypoint}
            onChange={(event) => setEntrypoint(event.target.value)}
          >
            <option value="">Select a file…</option>
            {filteredEntries.map((file) => (
              <option key={file} value={file}>
                {file}
              </option>
            ))}
          </select>
        </section>

        <section className={styles.listSection}>
          <div className={styles.sectionHeading}>
            <span>Included files</span>
            <span>{result?.stats.localFiles ?? 0}</span>
          </div>
          <div className={styles.fileList}>
            {result?.nodes
              .filter((node) => node.kind === "local-file")
              .map((node) => (
                <button
                  type="button"
                  key={node.id}
                  className={`${styles.fileRow} ${selectedNodeId === node.id ? styles.activeRow : ""}`}
                  onClick={() => {
                    setSelectedNodeId(node.id);
                    setSourcePreview(null);
                  }}
                >
                  {node.path === result.entrypoint ? <Play size={14} /> : <FileCode2 size={14} />}
                  <span>{node.path}</span>
                  {(result.issues.some((issue) => issue.nodeId === node.id) && (
                    <CircleAlert size={13} />
                  )) ||
                    null}
                </button>
              ))}
            {!result && (
              <p className={styles.emptyCopy}>Run an analysis to see the transitive file set.</p>
            )}
          </div>
        </section>

        <section className={styles.listSection}>
          <div className={styles.sectionHeading}>
            <span>External dependencies</span>
            <span>{result?.externalPackages.length ?? 0}</span>
          </div>
          <div className={styles.packageList}>
            {result?.externalPackages.map((dependency) => (
              <div key={dependency.name} className={styles.packageRow}>
                <Box size={13} />
                <span>{dependency.name}</span>
                <small>{dependency.declaredRange ?? "unknown"}</small>
              </div>
            ))}
          </div>
        </section>
      </aside>

      <section className={styles.canvas} aria-label="Dependency graph">
        <div className={styles.canvasHeader}>
          <strong>Dependency graph</strong>
          <div className={styles.legend}>
            <span>
              <i className={styles.runtimeLine} />
              Runtime
            </span>
            <span>
              <i className={styles.typeLine} />
              Type-only
            </span>
            <span>
              <i className={styles.errorLine} />
              Unresolved
            </span>
          </div>
        </div>
        {result ? (
          <ReactFlow
            key={`${result.entrypoint}:${result.edges.length}`}
            nodes={graph.nodes}
            edges={graph.edges}
            nodeTypes={nodeTypes}
            onNodeClick={selectNode}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
            minZoom={0.25}
            maxZoom={1.5}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={28} size={1} color="#263543" />
            <Controls showInteractive={false} position="bottom-left" />
          </ReactFlow>
        ) : (
          <div className={styles.emptyState}>
            <Route size={32} strokeWidth={1.35} />
            <h1>Trace what your module carries with it.</h1>
            <p>
              Select one TypeScript entrypoint and CodeLift will explain every supported dependency.
            </p>
          </div>
        )}
      </section>

      <aside className={styles.inspector} aria-label="Selected dependency details">
        <div className={styles.inspectorTitle}>
          <div className={styles.fileGlyph}>
            {selectedNode?.kind === "external-package" ? (
              <Box size={20} />
            ) : (
              <FileCode2 size={20} />
            )}
          </div>
          <div>
            <h2>{selectedNode?.label ?? "Inspector"}</h2>
            <code>{nodeTitle(selectedNode)}</code>
          </div>
        </div>

        {selectedNode?.path ? (
          <button
            className={styles.secondaryButton}
            type="button"
            onClick={() => void revealSource()}
          >
            <FileCode2 size={15} /> Preview source
          </button>
        ) : null}

        <section className={styles.inspectorSection}>
          <h3>
            <Route size={16} /> Why included
          </h3>
          {reasonNodes.length > 0 ? (
            <>
              <p>Reachable from the entrypoint through this shortest dependency path.</p>
              <div className={styles.reasonPath}>
                {reasonNodes.map((node, index) => (
                  <span className={styles.reasonStep} key={node.id}>
                    {index > 0 ? <ChevronRight size={12} /> : null}
                    <code>{node.label}</code>
                  </span>
                ))}
              </div>
              {primaryEdge ? (
                <div className={styles.evidence}>
                  <span className={styles.evidenceLabel}>
                    Code evidence · {primaryEdge.location.path}:{primaryEdge.location.line}
                  </span>
                  <pre>{primaryEdge.sourceText}</pre>
                </div>
              ) : (
                <p className={styles.entryNote}>This is the selected entrypoint.</p>
              )}
            </>
          ) : (
            <p>Select a node in the graph or file list to inspect its inclusion path.</p>
          )}
        </section>

        <section className={styles.inspectorSection}>
          <h3>
            <CircleAlert size={16} /> Issues
            <span className={styles.sectionCount}>{selectedIssues.length}</span>
          </h3>
          {selectedIssues.length > 0 ? (
            <div className={styles.issueList}>
              {selectedIssues.map((issue) => (
                <article
                  key={issue.id}
                  className={issue.blocking ? styles.blockingIssue : styles.warningIssue}
                >
                  <strong>{issue.message}</strong>
                  {issue.detail ? <p>{issue.detail}</p> : null}
                  {issue.location ? (
                    <code>
                      {issue.location.path}:{issue.location.line}
                    </code>
                  ) : null}
                </article>
              ))}
            </div>
          ) : (
            <p>No issues are attached to this node.</p>
          )}
        </section>

        {sourcePreview ? (
          <section className={`${styles.inspectorSection} ${styles.sourceSection}`}>
            <h3>
              <ShieldCheck size={16} /> Read-only source
            </h3>
            <code>{sourcePreview.path}</code>
            <pre>{sourcePreview.content}</pre>
          </section>
        ) : null}
      </aside>

      <StatusBar result={result} loading={loading} error={error} />
    </main>
  );
}
