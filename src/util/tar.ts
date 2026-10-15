/**
 * Minimal reader for `.tgz` archives such as npm package tarballs. It returns entries in
 * memory and never writes entry names to disk, so path traversal ("zip slip") cannot happen
 * here; callers pick the entry they need and choose the output file name themselves.
 *
 * Supports ustar (with the 155-byte name prefix), pax extended headers (`path=`) and GNU long
 * names, which covers what `npm pack` and registries produce.
 */

import { promisify } from 'node:util';
import { gunzip as gunzipCb } from 'node:zlib';

const gunzipAsync = promisify(gunzipCb);

export interface TarEntry {
  name: string;
  type: 'file' | 'directory' | 'other';
  data: Buffer;
}

const BLOCK = 512;

function readString(buf: Buffer, offset: number, length: number): string {
  const raw = buf.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
}

function readOctal(buf: Buffer, offset: number, length: number): number {
  const text = readString(buf, offset, length).trim();
  return text === '' ? 0 : parseInt(text, 8);
}

/** Parses pax records: "<len> <key>=<value>\n" repeated. */
function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) {
      break;
    }
    const len = Number(data.subarray(pos, space).toString());
    if (!Number.isFinite(len) || len <= 0) {
      break;
    }
    const record = data.subarray(space + 1, pos + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) {
      out[record.slice(0, eq)] = record.slice(eq + 1);
    }
    pos += len;
  }
  return out;
}

export function readTar(tar: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let longName: string | undefined;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) {
      break; // end-of-archive marker
    }
    const size = readOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const magic = readString(header, 257, 6);
    const prefix = magic.startsWith('ustar') ? readString(header, 345, 155) : '';
    let name = readString(header, 0, 100);
    if (prefix) {
      name = `${prefix}/${name}`;
    }
    const dataStart = offset + BLOCK;
    if (dataStart + size > tar.length) {
      throw new Error('Truncated tar archive');
    }
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (typeflag === 'x') {
      longName = parsePax(data).path ?? longName;
      continue;
    }
    if (typeflag === 'L') {
      longName = readString(data, 0, data.length);
      continue;
    }
    if (typeflag === 'g') {
      continue; // global pax header
    }
    if (longName) {
      name = longName;
      longName = undefined;
    }
    const type =
      typeflag === '0' || typeflag === '\0' || typeflag === '7'
        ? 'file'
        : typeflag === '5'
          ? 'directory'
          : 'other';
    entries.push({ name, type, data: Buffer.from(data) });
  }
  return entries;
}

export async function readTgz(tgz: Buffer): Promise<TarEntry[]> {
  return readTar(await gunzipAsync(tgz));
}
