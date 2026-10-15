/**
 * Pure model of the "Leuchtturm" sidebar tree (SPEC §3.1), separate from `treeView.ts` so it
 * can be unit-tested without VS Code:
 *
 *   Updates available (n)       artifact → its versions
 *   Up to date (n)
 *   Available, not installed (n)
 *   Problems (n)
 */

import type { ArtifactState, Candidate, CheckState, Problem } from '../checker';
import type { ArtifactKind } from '../sources/types';

export type GroupKey = 'updates' | 'upToDate' | 'notInstalled' | 'problems';

export type Node =
  | { type: 'kind'; kind: ArtifactKind; children: Node[] }
  | { type: 'group'; group: GroupKey; count: number; parent?: Node; children: Node[] }
  | { type: 'artifact'; artifact: ArtifactState; parent: Node; children: Node[] }
  | { type: 'version'; artifact: ArtifactState; candidate: Candidate; parent: Node }
  | { type: 'problem'; problem: Problem; parent: Node };

export const KIND_LABELS: Record<ArtifactKind, string> = {
  'vscode-extension': 'VS Code extensions',
};

export const GROUPS: { key: GroupKey; label: string; icon: string; color?: string }[] = [
  { key: 'updates', label: 'Updates available', icon: 'arrow-circle-up', color: 'charts.blue' },
  { key: 'upToDate', label: 'Up to date', icon: 'pass', color: 'testing.iconPassed' },
  { key: 'notInstalled', label: 'Available, not installed', icon: 'add' },
  { key: 'problems', label: 'Problems', icon: 'warning', color: 'problemsWarningIcon.foreground' },
];

function groupOf(a: ArtifactState): GroupKey {
  switch (a.status) {
    case 'update':
    case 'skipped':
      return 'updates';
    case 'up-to-date':
      return 'upToDate';
    case 'not-installed':
      return 'notInstalled';
  }
}

/** Builds the node model. Exported for tests. */
export function buildTree(state: CheckState | undefined): Node[] {
  if (!state) {
    return [];
  }
  const buildGroups = (artifacts: ArtifactState[], problems: Problem[], parent?: Node): Node[] => {
    const groups: Node[] = [];
    for (const g of GROUPS) {
      const group: Node = { type: 'group', group: g.key, count: 0, parent, children: [] };
      if (g.key === 'problems') {
        group.children = problems.map((problem) => ({ type: 'problem', problem, parent: group }));
        group.count = problems.length;
      } else {
        group.children = artifacts
          .filter((a) => groupOf(a) === g.key)
          .map((artifact) => {
            const node: Node = { type: 'artifact', artifact, parent: group, children: [] };
            node.children = artifact.candidates.map((candidate) => ({
              type: 'version',
              artifact,
              candidate,
              parent: node,
            }));
            return node;
          });
        // Skipped updates are listed but not counted.
        group.count = group.children.filter(
          (n) => n.type === 'artifact' && n.artifact.status !== 'skipped',
        ).length;
      }
      if (group.children.length > 0) {
        groups.push(group);
      }
    }
    return groups;
  };

  // Group by kind (SPEC §13.3) only once there is more than one kind; until then the extra
  // level would just be noise.
  const kinds = [...new Set(state.artifacts.map((a) => a.kind))];
  if (kinds.length <= 1) {
    return buildGroups(state.artifacts, state.problems);
  }
  const roots: Node[] = kinds.map((kind) => {
    const node: Node = { type: 'kind', kind, children: [] };
    node.children = buildGroups(
      state.artifacts.filter((a) => a.kind === kind),
      [],
      node,
    );
    return node;
  });
  if (state.problems.length > 0) {
    roots.push(...buildGroups([], state.problems));
  }
  return roots;
}

export function nodeId(node: Node): string {
  switch (node.type) {
    case 'kind':
      return `kind:${node.kind}`;
    case 'group':
      return `${node.parent ? nodeId(node.parent) + '/' : ''}group:${node.group}`;
    case 'artifact':
      return `artifact:${node.artifact.id.toLowerCase()}`;
    case 'version':
      return `version:${node.artifact.id.toLowerCase()}@${node.candidate.version}`;
    case 'problem':
      return `problem:${node.problem.source ?? ''}:${node.problem.artifactId ?? ''}:${node.problem.message}`;
  }
}

/** Artifact nodes for the given IDs (for `TreeView.reveal`). */
export function findArtifactNodes(roots: readonly Node[], ids: readonly string[]): Node[] {
  const wanted = new Set(ids.map((id) => id.toLowerCase()));
  const found: Node[] = [];
  const walk = (nodes: readonly Node[]): void => {
    for (const n of nodes) {
      if (n.type === 'artifact' && wanted.has(n.artifact.id.toLowerCase())) {
        found.push(n);
      } else if (n.type === 'kind' || n.type === 'group') {
        walk(n.children);
      }
    }
  };
  walk(roots);
  return found;
}

/** Updates count for the activity bar badge (skipped versions excluded). */
export function updateCount(state: CheckState | undefined): number {
  return state?.artifacts.filter((a) => a.status === 'update').length ?? 0;
}
