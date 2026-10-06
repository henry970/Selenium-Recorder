/**
 * Minimal ZIP file writer (STORE method — no compression).
 * Chrome extensions can't fetch a bundled JSZip from a CDN under MV3's
 * remote-code restrictions, so this hand-rolled writer avoids the
 * dependency entirely. Good enough for exporting small generated
 * source-code projects.
 *
 * Usage:
 *   const zip = new ZipWriter();
 *   zip.addFile('requirements.txt', 'selenium\npytest\n');
 *   zip.addFile('tests/test_x.py', '...');
 *   const blob = zip.generateBlob();
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const dosDate = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  return { time, dosDate };
}

class ZipWriter {
  constructor() {
    this.files = []; // { name, bytes }
  }

  addFile(path, content) {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    this.files.push({ name: path.replace(/^\/+/, ''), bytes });
  }

  generateBlob() {
    const encoder = new TextEncoder();
    const localChunks = [];
    const centralChunks = [];
    let offset = 0;
    const now = new Date();
    const { time, dosDate } = dosDateTime(now);

    for (const file of this.files) {
      const nameBytes = encoder.encode(file.name);
      const crc = crc32(file.bytes);
      const size = file.bytes.length;

      const localHeader = new DataView(new ArrayBuffer(30));
      localHeader.setUint32(0, 0x04034b50, true);
      localHeader.setUint16(4, 20, true); // version needed
      localHeader.setUint16(6, 0, true); // flags
      localHeader.setUint16(8, 0, true); // method: store
      localHeader.setUint16(10, time, true);
      localHeader.setUint16(12, dosDate, true);
      localHeader.setUint32(14, crc, true);
      localHeader.setUint32(18, size, true); // compressed size
      localHeader.setUint32(22, size, true); // uncompressed size
      localHeader.setUint16(26, nameBytes.length, true);
      localHeader.setUint16(28, 0, true); // extra length

      localChunks.push(new Uint8Array(localHeader.buffer), nameBytes, file.bytes);

      const centralHeader = new DataView(new ArrayBuffer(46));
      centralHeader.setUint32(0, 0x02014b50, true);
      centralHeader.setUint16(4, 20, true); // version made by
      centralHeader.setUint16(6, 20, true); // version needed
      centralHeader.setUint16(8, 0, true); // flags
      centralHeader.setUint16(10, 0, true); // method
      centralHeader.setUint16(12, time, true);
      centralHeader.setUint16(14, dosDate, true);
      centralHeader.setUint32(16, crc, true);
      centralHeader.setUint32(20, size, true);
      centralHeader.setUint32(24, size, true);
      centralHeader.setUint16(28, nameBytes.length, true);
      centralHeader.setUint16(30, 0, true); // extra length
      centralHeader.setUint16(32, 0, true); // comment length
      centralHeader.setUint16(34, 0, true); // disk number
      centralHeader.setUint16(36, 0, true); // internal attrs
      centralHeader.setUint32(38, 0, true); // external attrs
      centralHeader.setUint32(42, offset, true); // local header offset

      centralChunks.push(new Uint8Array(centralHeader.buffer), nameBytes);

      offset += 30 + nameBytes.length + size;
    }

    const centralSize = centralChunks.reduce((a, c) => a + c.length, 0);
    const centralOffset = offset;

    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(4, 0, true);
    end.setUint16(6, 0, true);
    end.setUint16(8, this.files.length, true);
    end.setUint16(10, this.files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, centralOffset, true);
    end.setUint16(20, 0, true);

    return new Blob([...localChunks, ...centralChunks, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }
}
