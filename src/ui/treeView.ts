/**
 * The "Leuchtturm" sidebar tree. The node model lives in `treeModel.ts`; this file turns it
 * into VS Code `TreeItem`s. The whole tree is rebuilt on every state change (it is small);
 * nodes carry stable `id`s so VS Code keeps expansion and selection across rebuilds.
 */

import * as vscode from 'vscode';

import {
  artifactLabel as label,
  type ArtifactState,
  type Candidate,
  type CheckState,
} from '../checker';
import { buildTree, findArtifactNodes, GROUPS, KIND_LABELS, nodeId, type Node } from './treeModel';

function hasNotes(c: Candidate): boolean {
  const v = c.available;
  return Boolean(v.releaseNotes || v.releaseNotesUrl || v.releaseNotesOnDemand);
}

function themeIcon(id: string, color?: string): vscode.ThemeIcon {
  return new vscode.ThemeIcon(id, color ? new vscode.ThemeColor(color) : undefined);
}

function tooltip(a: ArtifactState, state: CheckState | undefined): vscode.MarkdownString {
  const checkedAt = state?.checkedAt ?? Date.now();
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**${label(a)}**  \n`);
  md.appendText(a.id);
  md.appendMarkdown('\n\n');
  md.appendMarkdown(`Installed: ${a.installedVersion ?? '—'}  \n`);
  if (a.latest) {
    md.appendMarkdown(
      `Latest: ${a.latest.version} from \`${a.latest.sourceName}\` (${a.latest.sourceType})  \n`,
    );
  }
  if (a.status === 'skipped') {
    md.appendMarkdown(`Version ${a.latest?.version} is skipped.  \n`);
  }
  if (a.pin) {
    md.appendMarkdown(`Pinned to \`${a.pin}\`  \n`);
  }
  md.appendMarkdown(`Last check: ${new Date(checkedAt).toLocaleString()}`);
  for (const w of (a.latest && state?.sourceWarnings[a.latest.sourceName]) || []) {
    md.appendMarkdown('  \n$(warning) ');
    md.appendText(w);
  }
  const notes = a.latest?.available.releaseNotes;
  if (notes) {
    md.appendMarkdown('\n\n---\n\n');
    md.appendMarkdown(notes);
  }
  return md;
}

export class LeuchtturmTreeProvider implements vscode.TreeDataProvider<Node> {
  private roots: Node[] = [];
  private state: CheckState | undefined;
  private readonly changeEmitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  update(state: CheckState | undefined): void {
    this.state = state;
    this.roots = buildTree(state);
    this.changeEmitter.fire(undefined);
  }

  getChildren(element?: Node): Node[] {
    if (!element) {
      return this.roots;
    }
    return 'children' in element ? element.children : [];
  }

  getParent(element: Node): Node | undefined {
    return 'parent' in element ? element.parent : undefined;
  }

  /** Artifact nodes for the given IDs, for `TreeView.reveal`. */
  findArtifacts(ids: readonly string[]): Node[] {
    return findArtifactNodes(this.roots, ids);
  }

  /** The current node model (for tests). */
  get model(): readonly Node[] {
    return this.roots;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const C = vscode.TreeItemCollapsibleState;
    switch (node.type) {
      case 'kind': {
        const item = new vscode.TreeItem(KIND_LABELS[node.kind], C.Expanded);
        item.id = nodeId(node);
        return item;
      }
      case 'group': {
        const g = GROUPS.find((x) => x.key === node.group)!;
        const item = new vscode.TreeItem(
          `${g.label} (${node.count})`,
          node.group === 'upToDate' ? C.Collapsed : C.Expanded,
        );
        item.id = nodeId(node);
        item.iconPath = themeIcon(g.icon, g.color);
        item.contextValue = `group.${node.group}`;
        return item;
      }
      case 'artifact': {
        const a = node.artifact;
        const item = new vscode.TreeItem(label(a), C.Collapsed);
        item.id = nodeId(node);
        const source = a.latest ? ` · ${a.latest.sourceName}` : '';
        switch (a.status) {
          case 'update':
            item.description = `${a.installedVersion} → ${a.latest?.version}${source}`;
            item.iconPath = themeIcon('arrow-circle-up', 'charts.blue');
            break;
          case 'skipped':
            item.description = `${a.installedVersion} · ${a.latest?.version} skipped${source}`;
            item.iconPath = themeIcon('circle-slash', 'disabledForeground');
            break;
          case 'up-to-date':
            item.description = `${a.installedVersion}${source}`;
            item.iconPath = themeIcon('check');
            break;
          case 'not-installed':
            item.description = `${a.latest?.version}${source}`;
            item.iconPath = themeIcon('extensions');
            break;
        }
        item.tooltip = tooltip(a, this.state);
        item.contextValue = `artifact.${a.status}${a.latest && hasNotes(a.latest) ? '.notes' : ''}`;
        return item;
      }
      case 'version': {
        const { artifact, candidate } = node;
        const item = new vscode.TreeItem(candidate.version, C.None);
        item.id = nodeId(node);
        const tags: string[] = [];
        if (candidate.version === artifact.installedVersion) {
          tags.push('installed');
        }
        if (candidate === artifact.latest) {
          tags.push(artifact.status === 'skipped' ? 'latest, skipped' : 'latest');
        }
        tags.push(candidate.sourceName);
        item.description = tags.join(' · ');
        item.iconPath = themeIcon(
          candidate.version === artifact.installedVersion ? 'pass-filled' : 'tag',
        );
        item.tooltip = `${artifact.id} ${candidate.version} from ${candidate.sourceName} (${candidate.sourceType})`;
        const installed = candidate.version === artifact.installedVersion;
        item.contextValue = `version${installed ? '.installed' : ''}${hasNotes(candidate) ? '.notes' : ''}`;
        return item;
      }
      case 'problem': {
        const item = new vscode.TreeItem(node.problem.message, C.None);
        item.id = nodeId(node);
        item.iconPath = themeIcon('warning', 'problemsWarningIcon.foreground');
        const action = node.problem.action;
        item.tooltip = `${node.problem.message}\n\nClick to ${action ? action.title.replace(/…$/, '').toLowerCase() : 'open the log'}.`;
        item.contextValue = node.problem.source ? 'problem.source' : 'problem';
        item.command = action
          ? { command: action.command, title: action.title, arguments: action.arguments }
          : { command: 'leuchtturm.showLog', title: 'Show Log' };
        return item;
      }
    }
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
