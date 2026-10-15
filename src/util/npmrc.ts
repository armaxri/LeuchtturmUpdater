/**
 * Finds registry credentials in an `.npmrc` file, the way the npm CLI does: keys are scoped
 * to a "nerf dart" (`//host[:port]/path/`) and the most specific matching path wins.
 *
 *   //nexus.corp.example/repository/npm/:_authToken=abc      → Bearer abc
 *   //nexus.corp.example/:_auth=dXNlcjpwYXNz                 → Basic dXNlcjpwYXNz
 *   //nexus.corp.example/:username=u + :_password=<base64>   → Basic base64(u:pass)
 *
 * `${VAR}` in values is replaced from the environment, as npm does.
 */

export interface NpmrcAuth {
  authorization: string;
  /** Raw secret values that logs must redact. */
  sensitive: string[];
}

export function parseNpmrc(
  text: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Map<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(["']).*\1$/.test(value)) {
      value = value.slice(1, -1);
    }
    values.set(
      key,
      value.replace(/\$\{([^}]+)\}/g, (_m, name: string) => env[name] ?? ''),
    );
  }
  return values;
}

/** `https://host:8443/repo/npm/?x` → `//host:8443/repo/npm/` */
export function nerfDart(registry: string): string {
  const url = new URL(registry);
  const pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  return `//${url.host}${pathname}`;
}

export function findNpmrcAuth(
  values: Map<string, string>,
  registry: string,
): NpmrcAuth | undefined {
  // Try `//host/a/b/`, then `//host/a/`, then `//host/`.
  let dart = nerfDart(registry);
  for (;;) {
    const token = values.get(`${dart}:_authToken`);
    if (token) {
      return { authorization: `Bearer ${token}`, sensitive: [token] };
    }
    const auth = values.get(`${dart}:_auth`);
    if (auth) {
      return { authorization: `Basic ${auth}`, sensitive: [auth] };
    }
    const user = values.get(`${dart}:username`);
    const password64 = values.get(`${dart}:_password`);
    if (user && password64) {
      const password = Buffer.from(password64, 'base64').toString('utf8');
      const basic = Buffer.from(`${user}:${password}`).toString('base64');
      return { authorization: `Basic ${basic}`, sensitive: [basic, password64, password] };
    }
    const parent = dart.replace(/[^/]+\/$/, '');
    if (parent === dart || parent === '//') {
      return undefined;
    }
    dart = parent;
  }
}
