import type { GraphNode, NodeRun, RunLockLevel } from "@promptgraph/shared";
import type { Node } from "@xyflow/react";
import type { NodeLane } from "../../lib/lanes";

export interface NodeIssues {
  errors: string[];
  warnings: string[];
}

export interface PgNodeData extends Record<string, unknown> {
  node: GraphNode;
  /** Run mode only: the node's current node run (null before the engine created one). */
  nodeRun: NodeRun | null;
  /** Run mode: the node's lane (planned until the engine created it), for the coloured badge. */
  lane: NodeLane | null;
  /** merge nodes: input labels in merge order (the first keeps its lane). Empty otherwise. */
  mergeInputs: string[];
  runMode: boolean;
  issues: NodeIssues;
  /** Phase 2 shows the error port on every node. */
  phase: 1 | 2;
  /** Changed outside the editor a moment ago (chat, MCP): drawn with a pulsing halo. */
  highlighted?: boolean;
  /** Edit mode during an active run (§8.7): the node already started (null = still editable). */
  lock?: RunLockLevel | null;
}

export type PgFlowNode = Node<PgNodeData, "pg">;
