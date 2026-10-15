/**
 * Removes secrets from text before it reaches a log. Two layers:
 * 1. Every known secret value (resolved `${secret:…}` values, tokens) is replaced verbatim.
 * 2. Patterns that look like credentials (auth headers, npm tokens, URL user info) are masked
 *    even when we never saw the value, e.g. a token echoed back by a server or a script.
 */

const MASK = '***';

type Replacer = string | ((match: string, ...groups: string[]) => string);

const PATTERNS: [RegExp, Replacer][] = [
  // `Authorization: Basic abc`, `"authorization": "Bearer abc"`, `Proxy-Authorization=...`
  [
    /((?:proxy-)?authorization["']?\s*[:=]\s*["']?)(?:(basic|bearer|token|negotiate)\s+)?[^\s"',;}]+/gi,
    (_m, prefix: string, scheme: string | undefined) =>
      `${prefix}${scheme ? `${scheme} ` : ''}${MASK}`,
  ],
  // `.npmrc` style `//host/:_authToken=abc`, `_auth=abc`, `_password=abc`
  [/(_authToken|_auth|_password)(\s*=\s*)[^\s"']+/gi, `$1$2${MASK}`],
  // `https://user:password@host`
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, `$1${MASK}:${MASK}@`],
];

export class Redactor {
  private readonly secrets = new Set<string>();

  /** Registers a value that must never appear in logs. Very short values are ignored. */
  add(secret: string | undefined): void {
    // Masking 1–3 character strings would mangle unrelated text and protects nothing.
    if (secret && secret.length >= 4) {
      this.secrets.add(secret);
    }
  }

  redact(text: string): string {
    let out = text;
    // Longest first, so a secret that contains another secret is masked as a whole.
    for (const s of [...this.secrets].sort((a, b) => b.length - a.length)) {
      out = out.split(s).join(MASK);
    }
    for (const [re, replacement] of PATTERNS) {
      // Two calls because TS picks `replace` overloads per argument type, not for a union.
      out =
        typeof replacement === 'string'
          ? out.replace(re, replacement)
          : out.replace(re, replacement);
    }
    return out;
  }
}
