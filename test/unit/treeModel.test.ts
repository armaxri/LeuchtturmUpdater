import { describe, expect, it } from 'vitest';

import { computeState, type SourceResult } from '../../src/checker';
import { buildTree, findArtifactNodes, updateCount, type Node } from '../../src/ui/treeModel';

function result(source: string, artifacts: [string, ...string[]][]): SourceResult {
  return {
    source,
    type: 'file',
    durationMs: 1,
    artifacts: artifacts.map(([id, ...versions]) => ({
      id,
      kind: 'vscode-extension',
      versions: versions.map((version) => ({ version, ref: {} })),
    })),
  };
}

const installed: Record<string, string> = {
  'corp.linter': '1.3.0',
  'corp.snippets': '0.9.0',
  'corp.theme': '2.1.0',
};

const state = computeState({
  results: [
    result('share', [
      ['corp.linter', '1.4.1', '1.3.0'],
      ['corp.snippets', '1.0.0'],
      ['corp.theme', '2.1.0'],
      ['corp.new', '0.1.0'],
    ]),
    { ...result('broken', []), error: 'HTTP 401' },
  ],
  tracking: [],
  trackAllFromSources: true,
  includePrerelease: false,
  installedVersion: (id) => installed[id],
  isSkipped: (id) => id === 'corp.snippets',
  now: 0,
});

function describeNodes(nodes: readonly Node[]): unknown[] {
  return nodes.map((n) => {
    switch (n.type) {
      case 'group':
        return { [`${n.group} (${n.count})`]: describeNodes(n.children) };
      case 'artifact':
        return { [n.artifact.id]: describeNodes(n.children) };
      case 'version':
        return n.candidate.version;
      case 'problem':
        return n.problem.message;
      case 'kind':
        return { [n.kind]: describeNodes(n.children) };
    }
  });
}

describe('buildTree', () => {
  it('groups artifacts by status, with versions below and skipped updates uncounted', () => {
    expect(describeNodes(buildTree(state))).toEqual([
      {
        'updates (1)': [{ 'corp.linter': ['1.4.1', '1.3.0'] }, { 'corp.snippets': ['1.0.0'] }],
      },
      { 'upToDate (1)': [{ 'corp.theme': ['2.1.0'] }] },
      { 'notInstalled (1)': [{ 'corp.new': ['0.1.0'] }] },
      { 'problems (1)': ['broken: HTTP 401'] },
    ]);
  });

  it('omits empty groups and returns nothing without a state', () => {
    expect(buildTree(undefined)).toEqual([]);
    const empty = { checkedAt: 0, artifacts: [], problems: [] };
    expect(buildTree(empty)).toEqual([]);
  });

  it('finds artifact nodes with parents for reveal', () => {
    const roots = buildTree(state);
    const [node] = findArtifactNodes(roots, ['CORP.LINTER']);
    expect(node?.type).toBe('artifact');
    expect(node && 'parent' in node && node.parent?.type).toBe('group');
  });

  it('counts updates for the badge, excluding skipped ones', () => {
    expect(updateCount(state)).toBe(1);
    expect(updateCount(undefined)).toBe(0);
  });
});
