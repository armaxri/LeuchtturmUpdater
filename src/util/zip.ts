/**
 * Reads single entries from a zip file (a `.vsix` is a zip) without unpacking it: find the
 * central directory at the end of the file, look up the entry, inflate just that entry.
 * Only the parts needed for VSIX files are supported: stored and deflated entries, no ZIP64,
 * no encryption.
 */

import * as fs from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** The end record is 22 bytes plus a comment of at most 65535 bytes. */
const EOCD_SEARCH = 22 + 0xffff;

export interface ZipEntryInfo {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

async function readAt(file: fs.FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await file.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

/** Lists the entries of a zip file from its central directory. */
export async function listZip(path: string): Promise<ZipEntryInfo[]> {
  const file = await fs.open(path, 'r');
  try {
    return await listOpen(file);
  } finally {
    await file.close();
  }
}

async function listOpen(file: fs.FileHandle): Promise<ZipEntryInfo[]> {
  const { size } = await file.stat();
  const tailStart = Math.max(0, size - EOCD_SEARCH);
  const tail = await readAt(file, tailStart, size - tailStart);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) {
    throw new Error('Not a zip file (no end of central directory record)');
  }
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) {
    throw new Error('ZIP64 archives are not supported');
  }
  const cd = await readAt(file, cdOffset, cdSize);
  const entries: ZipEntryInfo[] = [];
  let pos = 0;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > cd.length || cd.readUInt32LE(pos) !== CENTRAL_SIGNATURE) {
      throw new Error('Corrupt zip central directory');
    }
    const nameLength = cd.readUInt16LE(pos + 28);
    const extraLength = cd.readUInt16LE(pos + 30);
    const commentLength = cd.readUInt16LE(pos + 32);
    entries.push({
      method: cd.readUInt16LE(pos + 10),
      compressedSize: cd.readUInt32LE(pos + 20),
      size: cd.readUInt32LE(pos + 24),
      localHeaderOffset: cd.readUInt32LE(pos + 42),
      name: cd.subarray(pos + 46, pos + 46 + nameLength).toString('utf8'),
    });
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Reads one entry's content, or undefined if it does not exist. `maxBytes` guards against
 * "zip bombs" that inflate to huge sizes.
 */
export async function readZipEntry(
  path: string,
  name: string,
  maxBytes = 5 * 1024 * 1024,
): Promise<Buffer | undefined> {
  const file = await fs.open(path, 'r');
  try {
    const entry = (await listOpen(file)).find((e) => e.name === name);
    if (!entry) {
      return undefined;
    }
    if (entry.size > maxBytes) {
      throw new Error(`${name} is too large (${entry.size} bytes)`);
    }
    const local = await readAt(file, entry.localHeaderOffset, 30);
    if (local.length < 30 || local.readUInt32LE(0) !== LOCAL_SIGNATURE) {
      throw new Error(`Corrupt zip entry ${name}`);
    }
    const dataStart =
      entry.localHeaderOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    const data = await readAt(file, dataStart, entry.compressedSize);
    switch (entry.method) {
      case 0:
        return data;
      case 8:
        return inflateRawSync(data, { maxOutputLength: maxBytes });
      default:
        throw new Error(`Unsupported zip compression method ${entry.method} for ${name}`);
    }
  } finally {
    await file.close();
  }
}
