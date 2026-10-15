/** Config for the `npm` source (SPEC §6.3): VSIX files wrapped in npm packages. */

import { expandPath, expandTemplate, type TemplateContext } from '../util/template';
import {
  optionalString,
  parseAuth,
  parseTls,
  requiredString,
  SourceConfigError,
  stringList,
  type CommonSourceConfig,
  type TlsConfig,
} from './sourceConfig';

export interface NpmSourceConfig extends CommonSourceConfig, TlsConfig {
  type: 'npm';
  /** Registry URL, always ending with `/`. */
  registry: string;
  /** `@scope`: list all packages of the scope via the registry's search API. */
  scope?: string;
  /** Explicit package names; take precedence over `scope`. */
  packages: string[];
  /** From `auth`. Without it, credentials come from `npmrcPath`. */
  authorization?: string;
  /** Absolute path of the `.npmrc` to read credentials from when `auth` is not set. */
  npmrcPath: string;
  sensitiveValues: string[];
}

const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

export function parseNpmSource(
  common: CommonSourceConfig,
  raw: Record<string, unknown>,
  ctx: TemplateContext,
): NpmSourceConfig {
  const registryText = expandTemplate(requiredString(raw.registry, 'registry'), ctx);
  let registry: URL;
  try {
    registry = new URL(registryText);
  } catch {
    throw new SourceConfigError(`"registry" is not a valid URL: ${registryText}`);
  }
  if (registry.protocol !== 'http:' && registry.protocol !== 'https:') {
    throw new SourceConfigError('"registry" must be an http:// or https:// URL');
  }
  if (!registry.pathname.endsWith('/')) {
    registry.pathname += '/';
  }

  let scope = optionalString(raw.scope, 'scope')?.trim() || undefined;
  if (scope && !scope.startsWith('@')) {
    scope = `@${scope}`;
  }
  if (scope && !/^@[a-z0-9-~][a-z0-9-._~]*$/.test(scope)) {
    throw new SourceConfigError(`"scope" is not a valid npm scope: ${scope}`);
  }
  if (raw.packages !== undefined && !Array.isArray(raw.packages)) {
    throw new SourceConfigError('"packages" must be an array of package names');
  }
  const packages = stringList(raw.packages).map((p) => p.trim());
  for (const p of packages) {
    if (!PACKAGE_NAME.test(p)) {
      throw new SourceConfigError(`"packages" contains an invalid package name: "${p}"`);
    }
  }
  if (!scope && packages.length === 0) {
    throw new SourceConfigError('set "scope" (to search the registry) or list "packages"');
  }

  const { authorization, sensitive } = parseAuth(raw.auth, ctx);
  const npmrc = optionalString(raw.npmrc, 'npmrc') ?? '~/.npmrc';
  return {
    ...common,
    type: 'npm',
    registry: registry.toString(),
    scope,
    packages,
    authorization,
    npmrcPath: expandPath(npmrc, ctx),
    sensitiveValues: sensitive,
    ...parseTls(raw, ctx),
  };
}
