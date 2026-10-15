/** Writes `.tgz` files like `npm pack` does (test fixtures only). */

import { gzipSync } from 'node:zlib';

function header(name: string, size: number): Buffer {
  const h = Buffer.alloc(512);
  // Names longer than 100 bytes would need the ustar prefix; fixtures stay short.
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100); // mode
  h.write('0000000\0', 108); // uid
  h.write('0000000\0', 116); // gid
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write(
    `${Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, '0')}\0`,
    136,
  );
  h.write('        ', 148); // checksum placeholder (spaces)
  h.write('0', 156); // regular file
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) {
    sum += b;
  }
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

/** `{ 'package/package.json': '{…}', 'package/x.vsix': <Buffer> }` → gzipped tar. */
export function makeTgz(files: Record<string, string | Buffer>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === 'string' ? Buffer.from(content) : content;
    parts.push(header(name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024)); // end-of-archive
  return gzipSync(Buffer.concat(parts));
}
