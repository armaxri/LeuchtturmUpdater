/** Pure presentation logic for the status bar item (SPEC §3.2), unit-tested. */

import type { StatusBarMode } from '../config';

export interface StatusBarInput {
  mode: StatusBarMode;
  enabled: boolean;
  checking: boolean;
  updates: number;
  problems: number;
}

export interface StatusBarView {
  visible: boolean;
  text: string;
  tooltip: string;
}

export function statusBarView(input: StatusBarInput): StatusBarView {
  const { mode, checking, updates, problems } = input;
  const visible =
    input.enabled && mode !== 'never' && (mode === 'always' || updates > 0 || checking);
  if (checking) {
    return {
      visible,
      text: '$(sync~spin) Leuchtturm',
      tooltip: 'Leuchtturm: checking for updates…',
    };
  }
  const tooltipParts = [
    updates === 0 ? 'No updates' : `${updates} update${updates === 1 ? '' : 's'} available`,
  ];
  if (problems > 0) {
    tooltipParts.push(`${problems} problem${problems === 1 ? '' : 's'}`);
  }
  return {
    visible,
    text: updates > 0 ? `$(broadcast) ${updates}` : '$(broadcast)',
    tooltip: `Leuchtturm: ${tooltipParts.join(', ')}. Click to show.`,
  };
}
