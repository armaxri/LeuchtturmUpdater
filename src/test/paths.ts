import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Repository root. Works from `src/test` (vitest) and from `out/test` (compiled). */
export const ROOT = path.resolve(__dirname, '../..');

export const TLS_CERT = path.join(ROOT, 'test/fixtures/tls/localhost.crt');
export const TLS_KEY = path.join(ROOT, 'test/fixtures/tls/localhost.key');

/**
 * Deletes a test's temp folder. On Windows, VS Code can hold its log files open for a moment
 * after exiting (EBUSY), so retry, and only warn if it still fails: leftover temp files must
 * not turn a passing run into a failure.
 */
export async function removeTempDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`Could not delete ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
