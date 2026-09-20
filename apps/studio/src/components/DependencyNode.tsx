import { Handle, type NodeProps, Position } from "@xyflow/react";
import { Box, CircleAlert, FileCode2, FileImage, Hexagon, Play } from "lucide-react";
import type { DependencyNodeData } from "../lib/graph-layout.js";
import styles from "./DependencyNode.module.css";

export function DependencyNode({ data, selected }: NodeProps) {
  const { dependency, issueCount, isEntrypoint } = data as DependencyNodeData;
  const Icon =
    dependency.kind === "external-package"
      ? Box
      : dependency.kind === "node-builtin"
        ? Hexagon
        : dependency.kind === "local-asset"
          ? FileImage
          : dependency.kind === "unresolved"
            ? CircleAlert
            : isEntrypoint
              ? Play
              : FileCode2;

  return (
    <div
      className={`${styles.node} ${styles[dependency.kind]} ${selected ? styles.selected : ""}`}
      data-node-kind={dependency.kind}
    >
      <Handle className={styles.handle} type="target" position={Position.Top} />
      <Icon aria-hidden="true" size={18} strokeWidth={1.7} />
      <div className={styles.copy}>
        <strong>{dependency.label}</strong>
        <span>{dependency.path?.replace(`/${dependency.label}`, "") || dependency.kind}</span>
      </div>
      {issueCount > 0 ? (
        <span className={styles.issue} title={`${issueCount} issues`}>
          {issueCount}
        </span>
      ) : null}
      <Handle className={styles.handle} type="source" position={Position.Bottom} />
    </div>
  );
}
