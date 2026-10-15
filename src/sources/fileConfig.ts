import { expandPath, type TemplateContext } from '../util/template';
import {
  compileRegex,
  regexGroupNames,
  SourceConfigError,
  type CommonSourceConfig,
} from './sourceConfig';

export const DEFAULT_FILE_PATTERN =
  '^(?<id>[\\w-]+\\.[\\w-]+)-(?<version>\\d+\\.\\d+\\.\\d+(?:-[\\w.]+)?)\\.vsix$';

export interface FileSourceConfig extends CommonSourceConfig {
  type: 'file';
  /** Absolute path after `~` and `${…}` expansion. */
  path: string;
  recursive: boolean;
  filePattern: RegExp;
}

export function parseFileSource(
  common: CommonSourceConfig,
  raw: Record<string, unknown>,
  ctx: TemplateContext,
): FileSourceConfig {
  if (typeof raw.path !== 'string' || raw.path.trim() === '') {
    throw new SourceConfigError('"path" is required for a file source');
  }
  const patternText = raw.filePattern ?? DEFAULT_FILE_PATTERN;
  if (typeof patternText !== 'string') {
    throw new SourceConfigError('"filePattern" must be a string');
  }
  // Case-insensitive because VS Code extension IDs are, and shares often live on Windows.
  const filePattern = compileRegex(patternText, 'i', 'filePattern');
  // Every match must name the extension and its version.
  const groups = regexGroupNames(filePattern);
  for (const g of ['id', 'version']) {
    if (!groups.includes(g)) {
      throw new SourceConfigError(`"filePattern" must contain a named group (?<${g}>…)`);
    }
  }
  return {
    ...common,
    type: 'file',
    path: expandPath(raw.path, ctx),
    recursive: raw.recursive === true,
    filePattern,
  };
}
