import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** Hex-encoded SHA-256 of a file, streamed so large files don't sit in memory. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/**
 * Throws if the file's SHA-256 does not equal `expected` (hex, case-insensitive).
 * Returns the actual hash so callers can log it.
 */
export async function verifySha256(path: string, expected: string): Promise<string> {
  const actual = await sha256File(path);
  if (actual.toLowerCase() !== expected.trim().toLowerCase()) {
    throw new Error(`SHA-256 mismatch for ${path}: expected ${expected}, got ${actual}`);
  }
  return actual;
}

const SRI_ALGORITHMS = ['sha512', 'sha384', 'sha256', 'sha1'];

/**
 * Verifies npm `dist.integrity` (Subresource Integrity, e.g. `sha512-<base64>`, possibly
 * several space-separated) or, failing that, the legacy `dist.shasum` (sha1 hex). Throws on a
 * mismatch. Returns a description of what was checked, or undefined if nothing was available.
 */
export function verifyIntegrity(
  data: Buffer,
  integrity: string | undefined,
  shasum: string | undefined,
): string | undefined {
  if (integrity) {
    const candidates = integrity
      .trim()
      .split(/\s+/)
      .map((entry) => {
        const dash = entry.indexOf('-');
        return {
          algorithm: entry.slice(0, dash),
          digest: entry.slice(dash + 1).replace(/\?.*$/, ''),
        };
      })
      .filter((c) => SRI_ALGORITHMS.includes(c.algorithm));
    // Use the strongest algorithm offered.
    candidates.sort(
      (a, b) => SRI_ALGORITHMS.indexOf(a.algorithm) - SRI_ALGORITHMS.indexOf(b.algorithm),
    );
    const best = candidates[0];
    if (best) {
      const actual = createHash(best.algorithm).update(data).digest('base64');
      if (actual !== best.digest) {
        throw new Error(
          `Integrity check failed (${best.algorithm}): the download does not match the registry`,
        );
      }
      return best.algorithm;
    }
  }
  if (shasum) {
    const actual = createHash('sha1').update(data).digest('hex');
    if (actual !== shasum.toLowerCase()) {
      throw new Error(
        'Integrity check failed (sha1 shasum): the download does not match the registry',
      );
    }
    return 'sha1';
  }
  return undefined;
}
