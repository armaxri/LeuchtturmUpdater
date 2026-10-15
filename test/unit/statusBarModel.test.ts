import { describe, expect, it } from 'vitest';

import { statusBarView, type StatusBarInput } from '../../src/ui/statusBarModel';

const base: StatusBarInput = {
  mode: 'whenUpdates',
  enabled: true,
  checking: false,
  updates: 0,
  problems: 0,
};

describe('statusBarView', () => {
  it('shows the update count only when there are updates (default mode)', () => {
    expect(statusBarView(base).visible).toBe(false);
    expect(statusBarView({ ...base, updates: 2 })).toMatchObject({
      visible: true,
      text: '$(broadcast) 2',
    });
  });

  it('spins while checking', () => {
    expect(statusBarView({ ...base, checking: true })).toMatchObject({
      visible: true,
      text: '$(sync~spin) Leuchtturm',
    });
  });

  it('honours always and never', () => {
    expect(statusBarView({ ...base, mode: 'always' })).toMatchObject({
      visible: true,
      text: '$(broadcast)',
    });
    expect(statusBarView({ ...base, mode: 'never', updates: 3 }).visible).toBe(false);
    expect(statusBarView({ ...base, enabled: false, updates: 3 }).visible).toBe(false);
  });

  it('mentions problems in the tooltip', () => {
    expect(statusBarView({ ...base, updates: 1, problems: 2 }).tooltip).toBe(
      'Leuchtturm: 1 update available, 2 problems. Click to show.',
    );
  });
});
