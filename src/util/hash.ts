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
