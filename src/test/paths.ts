import * as path from 'node:path';

/** Repository root. Works from `src/test` (vitest) and from `out/test` (compiled). */
export const ROOT = path.resolve(__dirname, '../..');

export const TLS_CERT = path.join(ROOT, 'test/fixtures/tls/localhost.crt');
export const TLS_KEY = path.join(ROOT, 'test/fixtures/tls/localhost.key');
