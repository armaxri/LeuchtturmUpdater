/** Config for the `script` source (SPEC §6.5): a user program that speaks a JSON protocol. */

import {
  expandPath,
  expandTemplate,
  findVariableNames,
  type TemplateContext,
} from '../util/template';
import {
  isObject,
  optionalString,
  requiredString,
  SourceConfigError,
  stringRecord,
  type CommonSourceConfig,
} from './sourceConfig';

export type ScriptAction = 'list' | 'download' | 'notes';

export const DEFAULT_SCRIPT_ARGS: Record<ScriptAction, string[]> = {
  list: ['get_versions'],
  download: [
    'download_version',
    '--id',
    '${id}',
    '--version',
    '${version}',
    '--target-dir',
    '${targetDir}',
  ],
  notes: ['get_release_notes', '--id', '${id}', '--version', '${version}'],
};

/** Variables each action's arguments may use (plus `ref.*`, env, secrets, userHome, platform). */
const ACTION_VARS: Record<ScriptAction, string[]> = {
  list: [],
  download: ['id', 'version', 'targetDir'],
  notes: ['id', 'version'],
};

export interface ScriptSourceConfig extends CommonSourceConfig {
  type: 'script';
  /** Executable (PATH lookup or absolute path after `~` expansion). */
  command: string;
  /** Optional script file, passed as the first argument. Absolute after expansion. */
  script?: string;
  cwd?: string;
  /** Templates, expanded per run. */
  env: Record<string, string>;
  /** Argument templates per action; `notes` is null when disabled. */
  args: { list: string[]; download: string[]; notes: string[] | null };
  templateContext: TemplateContext;
}

function parseArgs(raw: unknown, action: ScriptAction, ctx: TemplateContext): string[] {
  if (raw === undefined) {
    return DEFAULT_SCRIPT_ARGS[action];
  }
  if (!Array.isArray(raw) || !raw.every((a) => typeof a === 'string')) {
    throw new SourceConfigError(`"args.${action}" must be an array of strings`);
  }
  for (const name of findVariableNames(...raw)) {
    if (name.startsWith('env:') || name.startsWith('secret:')) {
      expandTemplate(`\${${name}}`, ctx); // throws a helpful error if unset
    } else if (
      !name.startsWith('ref.') &&
      !['userHome', 'platform', ...ACTION_VARS[action]].includes(name)
    ) {
      throw new SourceConfigError(
        `"args.${action}" uses \${${name}}, which is not available for this action`,
      );
    }
  }
  return raw;
}

export function parseScriptSource(
  common: CommonSourceConfig,
  raw: Record<string, unknown>,
  ctx: TemplateContext,
): ScriptSourceConfig {
  const command = expandPath(requiredString(raw.command, 'command'), ctx);
  const script = optionalString(raw.script, 'script');
  const cwd = optionalString(raw.cwd, 'cwd');
  const env = stringRecord(raw.env, 'env');
  // Check env templates now, so a missing variable shows up as a config problem.
  Object.values(env).forEach((v) => expandTemplate(v, ctx));
  const args = isObject(raw.args) ? raw.args : {};
  if (raw.args !== undefined && !isObject(raw.args)) {
    throw new SourceConfigError('"args" must be an object with "list", "download" and "notes"');
  }
  return {
    ...common,
    type: 'script',
    command,
    script: script ? expandPath(script, ctx) : undefined,
    cwd: cwd ? expandPath(cwd, ctx) : undefined,
    env,
    args: {
      list: parseArgs(args.list, 'list', ctx),
      download: parseArgs(args.download, 'download', ctx),
      notes:
        args.notes === null || args.notes === false ? null : parseArgs(args.notes, 'notes', ctx),
    },
    templateContext: ctx,
  };
}
