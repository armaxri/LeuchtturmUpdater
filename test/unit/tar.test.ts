import { describe, expect, it } from 'vitest';

import { makeTgz } from '../../src/test/tarball';
import { readTar, readTgz } from '../../src/util/tar';

describe('tar reader', () => {
  it('reads files written like npm pack', async () => {
    const entries = await readTgz(
      makeTgz({
        'package/package.json': '{"name":"x"}',
        'package/x-1.0.0.vsix': Buffer.from([1, 2, 3]),
      }),
    );
    expect(entries.map((e) => [e.name, e.type, e.data.length])).toEqual([
      ['package/package.json', 'file', 12],
      ['package/x-1.0.0.vsix', 'file', 3],
    ]);
  });

  it('applies pax long names', () => {
    const pax = (name: string) => {
      const record = ` path=${name}\n`;
      const len = record.length + String(record.length + 3).length;
      return `${len}${record}`;
    };
    const header = (name: string, size: number, type: string) => {
      const h = Buffer.alloc(512);
      h.write(name, 0);
      h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
      h.write(type, 156);
      h.write('ustar\0', 257);
      return h;
    };
    const longName = `package/${'a'.repeat(120)}.vsix`;
    const record = Buffer.from(pax(longName));
    const tar = Buffer.concat([
      header('PaxHeader', record.length, 'x'),
      record,
      Buffer.alloc(512 - record.length),
      header('short', 1, '0'),
      Buffer.from('z'),
      Buffer.alloc(511),
      Buffer.alloc(1024),
    ]);
    expect(readTar(tar).map((e) => e.name)).toEqual([longName]);
  });

  it('rejects truncated archives', () => {
    const tgzHeader = Buffer.alloc(512);
    tgzHeader.write('x', 0);
    tgzHeader.write('00000001000\0', 124);
    expect(() => readTar(tgzHeader)).toThrow(/Truncated/);
  });
});
