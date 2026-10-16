/**
 * Config for the `npm` source (SPEC §6.3): VSIX files wrapped in npm packages. Leuchtturm runs
 * the user's own npm CLI, so registries, logins and certificates come from the user's npm
 * configuration (`.npmrc`, `npm login`); none of that is configured here.
 */

import { expandTemplate, type TemplateContext } from '../util/template';
import {
  optionalString,
  SourceConfigError,
  stringList,
  type CommonSourceConfig,
} from './sourceConfig';

export interface NpmSourceConfig extends CommonSourceConfig {
  type: 'npm';
  /** Passed to npm as `--registry`. Unset: npm's own configuration decides. */
  registry?: string;
  /** `@scope`: list all packages of the scope with `npm search`. */
  scope?: string;
  /** Explicit package names; take precedence over `scope`. */
  packages: string[];
}

const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** Settings that Leuchtturm no longer handles; npm's own configuration covers them. */
const NPM_CONFIG_FIELDS = ['auth', 'npmrc', 'ca', 'strictSSL'];

export function parseNpmSource(
  common: CommonSourceConfig,
  raw: Record<string, unknown>,
  ctx: TemplateContext,
): NpmSourceConfig {
  for (const field of NPM_CONFIG_FIELDS) {
    if (raw[field] !== undefined) {
      throw new SourceConfigError(
        `"${field}" is not supported: Leuchtturm runs your npm, which uses your own npm ` +
          'configuration. Set up logins and certificates for npm itself (`npm login`, ' +
          '.npmrc), then npm and Leuchtturm both use them.',
      );
    }
  }
  let registry: string | undefined;
  const registryText = optionalString(raw.registry, 'registry')?.trim();
  if (registryText) {
    const expanded = expandTemplate(registryText, ctx);
    let url: URL;
    try {
      url = new URL(expanded);
    } catch {
      throw new SourceConfigError(`"registry" is not a valid URL: ${expanded}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new SourceConfigError('"registry" must be an http:// or https:// URL');
    }
    if (!url.pathname.endsWith('/')) {
      url.pathname += '/';
    }
    registry = url.toString();
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
  return { ...common, type: 'npm', registry, scope, packages };
}
