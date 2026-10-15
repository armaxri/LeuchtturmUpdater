/**
 * `${var}` substitution for URLs, headers, args, env and paths (SPEC §7).
 *
 * An unknown or unset variable is an error, never an empty string: silently producing
 * `https:///foo` or an empty token is much harder to debug than a clear config error.
 */

import * as os from 'node:os';

export interface TemplateContext {
  /** Operation variables such as `id`, `version`, `targetDir`, and named regex groups. */
  vars?: Readonly<Record<string, string | undefined>>;
  /** Script `ref` values, available as `${ref.<key>}`. */
  ref?: Readonly<Record<string, string>>;
  /** Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Already-resolved secrets from SecretStorage, by name. */
  secrets?: Readonly<Record<string, string>>;
  /** Defaults to `os.homedir()`. */
  userHome?: string;
  /** Defaults to `currentPlatform()`. */
  platform?: string;
}

export class TemplateError extends Error {
  override name = 'TemplateError';
}

const VAR_RE = /\$\{([^}]*)\}/g;

/** VS Code style target platform, e.g. `darwin-arm64`, `win32-x64`. */
export function currentPlatform(): string {
  return `${process.platform}-${process.arch}`;
}

function lookup(name: string, ctx: TemplateContext): string {
  if (name.startsWith('env:')) {
    const key = name.slice(4);
    const value = (ctx.env ?? process.env)[key];
    if (value === undefined) {
      throw new TemplateError(`Environment variable "${key}" is not set (used as \${${name}})`);
    }
    return value;
  }
  if (name.startsWith('secret:')) {
    const key = name.slice(7);
    const value = ctx.secrets?.[key];
    if (value === undefined) {
      throw new TemplateError(
        `Secret "${key}" is not stored. Run "Leuchtturm: Store Credential…" to set it.`,
      );
    }
    return value;
  }
  if (name.startsWith('ref.')) {
    const key = name.slice(4);
    const value = ctx.ref?.[key];
    if (value === undefined) {
      throw new TemplateError(`Unknown ref value \${${name}}`);
    }
    return value;
  }
  if (name === 'userHome') {
    return ctx.userHome ?? os.homedir();
  }
  if (name === 'platform') {
    return ctx.platform ?? currentPlatform();
  }
  // `Object.hasOwn` so names like `constructor` don't resolve to inherited properties.
  if (ctx.vars && Object.hasOwn(ctx.vars, name)) {
    const value = ctx.vars[name];
    if (value !== undefined) {
      return value;
    }
  }
  throw new TemplateError(`Unknown variable \${${name}}`);
}

/** Replaces every `${…}` in `template`. Throws `TemplateError` on unknown variables. */
export function expandTemplate(template: string, ctx: TemplateContext = {}): string {
  return template.replace(VAR_RE, (_match, name: string) => lookup(name.trim(), ctx));
}

/** Like `expandTemplate`, and additionally expands a leading `~` to the home directory. */
export function expandPath(template: string, ctx: TemplateContext = {}): string {
  const expanded = expandTemplate(template, ctx);
  if (expanded === '~' || /^~[/\\]/.test(expanded)) {
    return (ctx.userHome ?? os.homedir()) + expanded.slice(1);
  }
  return expanded;
}

/** Names of all `${secret:NAME}` references in the given strings, deduplicated. */
export function findSecretNames(...templates: string[]): string[] {
  const names = new Set<string>();
  for (const t of templates) {
    for (const m of t.matchAll(VAR_RE)) {
      const name = (m[1] ?? '').trim();
      if (name.startsWith('secret:')) {
        names.add(name.slice(7));
      }
    }
  }
  return [...names];
}
