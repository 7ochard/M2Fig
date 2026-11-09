"use strict";

const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;
const UINT32_RANGE = 0x100000000;
const utf8FilenameDecoder = new TextDecoder("utf-8", { fatal: true });
let gb18030FilenameDecoder;
let gbkFilenameDecoder;

function filenameCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function decodeEntryName(bytes, view, nameOffset, nameLength, extraLength, flags) {
  const raw = bytes.subarray(nameOffset, nameOffset + nameLength);
  if (flags & 0x800) {
    try { return utf8FilenameDecoder.decode(raw); }
    catch (_) { throw new Error("ZIP 声明的 UTF-8 文件名无效"); }
  }
  const limit = nameOffset + nameLength + extraLength;
  let offset = nameOffset + nameLength;
  while (offset < limit) {
    requireRange(view, offset, 4, limit);
    const tag = view.getUint16(offset, true), size = view.getUint16(offset + 2, true);
    offset += 4;
    requireRange(view, offset, size, limit);
    // APPNOTE 4.6.9: accept Unicode Path only for version 1 and the CRC of
    // these exact header filename bytes. Stale/invalid extras are ignored.
    if (tag === 0x7075 && size >= 5 && view.getUint8(offset) === 1 &&
        view.getUint32(offset + 1, true) === filenameCrc32(raw)) {
      try { return utf8FilenameDecoder.decode(bytes.subarray(offset + 5, offset + size)); }
      catch (_) { /* fall back to the original header name */ }
    }
    offset += size;
  }
  try { return utf8FilenameDecoder.decode(raw); }
  catch (_) {
    // Windows re-compression may use CP936 without the UTF-8 flag. GB18030
    // also covers four-byte Chinese names; GBK retains its single-byte Euro.
    try {
      gb18030FilenameDecoder = gb18030FilenameDecoder || new TextDecoder("gb18030", { fatal: true });
      return gb18030FilenameDecoder.decode(raw);
    } catch (_) {
      try {
        gbkFilenameDecoder = gbkFilenameDecoder || new TextDecoder("gbk", { fatal: true });
        return gbkFilenameDecoder.decode(raw);
      } catch (_) { throw new Error("ZIP 文件名编码无效，无法读取路径"); }
    }
  }
}

function validateEntryName(name) {
  if (!name || name.includes("\0") || /^[\\/]/.test(name) || /^[A-Za-z]:/.test(name) ||
      name.split(/[\\/]/).includes("..")) throw new Error("ZIP 文件路径无效或越界");
}

function requireRange(view, offset, length, limit = view.byteLength) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
      offset < 0 || length < 0 || offset > limit || length > limit - offset) {
    throw new Error("ZIP 数据范围损坏或文件不完整");
  }
}

function readUint64(view, offset, limit) {
  requireRange(view, offset, 8, limit);
  const value = view.getUint32(offset, true) + view.getUint32(offset + 4, true) * UINT32_RANGE;
  if (!Number.isSafeInteger(value)) throw new Error("ZIP64 数值超出可精确读取的范围");
  return value;
}

function findEndOfCentralDirectory(view) {
  const first = Math.max(0, view.byteLength - 22 - UINT16_MAX);
  for (let offset = view.byteLength - 22; offset >= first; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 &&
        offset + 22 + view.getUint16(offset + 20, true) === view.byteLength) return offset;
  }
  throw new Error("不是有效的 ZIP 文件");
}

function readZipDirectoryTail(input, archiveSize, tailOffset = 0, zip64Bytes) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (tailOffset + bytes.length !== archiveSize) throw new Error("ZIP 尾部数据范围损坏");
  const endOffset = findEndOfCentralDirectory(view);
  const disk = view.getUint16(endOffset + 4, true);
  const directoryDisk = view.getUint16(endOffset + 6, true);
  let diskEntries = view.getUint16(endOffset + 8, true);
  let entryCount = view.getUint16(endOffset + 10, true);
  let size = view.getUint32(endOffset + 12, true);
  let offset = view.getUint32(endOffset + 16, true);
  let limit = tailOffset + endOffset;
  if (disk !== 0 || directoryDisk !== 0) throw new Error("暂不支持分卷 ZIP 文件");

  if (entryCount === UINT16_MAX || diskEntries === UINT16_MAX ||
      size === UINT32_MAX || offset === UINT32_MAX) {
    const locator = endOffset - 20;
    requireRange(view, locator, 20);
    if (view.getUint32(locator, true) !== 0x07064b50) throw new Error("ZIP64 目录定位信息缺失");
    if (view.getUint32(locator + 4, true) !== 0 || view.getUint32(locator + 16, true) !== 1) {
      throw new Error("暂不支持分卷 ZIP 文件");
    }
    const zip64 = readUint64(view, locator + 8);
    requireRange({ byteLength: archiveSize }, zip64, 56, tailOffset + locator);
    if (!zip64Bytes) return { zip64Offset: zip64 };
    const record = zip64Bytes instanceof Uint8Array ? zip64Bytes : new Uint8Array(zip64Bytes);
    const recordView = new DataView(record.buffer, record.byteOffset, record.byteLength);
    requireRange(recordView, 0, 56);
    if (recordView.getUint32(0, true) !== 0x06064b50) throw new Error("ZIP64 目录损坏");
    const recordSize = readUint64(recordView, 4);
    if (recordSize < 44) throw new Error("ZIP64 目录损坏");
    requireRange({ byteLength: archiveSize }, zip64 + 12, recordSize, tailOffset + locator);
    if (recordView.getUint32(16, true) !== 0 || recordView.getUint32(20, true) !== 0) {
      throw new Error("暂不支持分卷 ZIP 文件");
    }
    diskEntries = readUint64(recordView, 24);
    entryCount = readUint64(recordView, 32);
    size = readUint64(recordView, 40);
    offset = readUint64(recordView, 48);
    limit = zip64;
  }

  if (diskEntries !== entryCount) throw new Error("暂不支持分卷 ZIP 文件");
  requireRange({ byteLength: archiveSize }, offset, size, limit);
  if (entryCount > Math.floor(size / 46)) throw new Error("ZIP 目录条目数量损坏");
  return { offset, size, entryCount };
}

function resolveZip64Entry(view, extraOffset, extraLength, entry) {
  if (entry.uncompressedSize !== UINT32_MAX && entry.compressedSize !== UINT32_MAX &&
      entry.localOffset !== UINT32_MAX && entry.disk !== UINT16_MAX) return;

  const limit = extraOffset + extraLength;
  let offset = extraOffset;
  while (offset < limit) {
    requireRange(view, offset, 4, limit);
    const tag = view.getUint16(offset, true);
    const size = view.getUint16(offset + 2, true);
    offset += 4;
    requireRange(view, offset, size, limit);
    if (tag === 0x0001) {
      const end = offset + size;
      // APPNOTE 4.5.3: only sentinel-marked fields occur, in this order.
      for (const key of ["uncompressedSize", "compressedSize", "localOffset"]) {
        if (entry[key] !== UINT32_MAX) continue;
        entry[key] = readUint64(view, offset, end);
        offset += 8;
      }
      if (entry.disk === UINT16_MAX) {
        requireRange(view, offset, 4, end);
        entry.disk = view.getUint32(offset, true);
      }
      return;
    }
    offset += size;
  }
  throw new Error("ZIP64 文件尺寸或偏移信息缺失");
}

// Shared by the browser importer and Node diagnostics. Offsets are relative to
// this byte view, including when the caller supplies a Buffer/subarray.
function readZipCentralDirectory(input, directory) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const directoryEnd = directory.size;
  requireRange(view, 0, directoryEnd);
  const result = [];
  const names = new Set();
  let offset = 0;
  for (let i = 0; i < directory.entryCount; i++) {
    requireRange(view, offset, 46, directoryEnd);
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("ZIP 中央目录损坏");
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameOffset = offset + 46;
    requireRange(view, nameOffset, nameLength + extraLength + commentLength, directoryEnd);
    const entry = {
      name: decodeEntryName(bytes, view, nameOffset, nameLength, extraLength, view.getUint16(offset + 8, true)),
      flags: view.getUint16(offset + 8, true),
      method: view.getUint16(offset + 10, true),
      crc32: view.getUint32(offset + 16, true),
      compressedSize: view.getUint32(offset + 20, true),
      uncompressedSize: view.getUint32(offset + 24, true),
      disk: view.getUint16(offset + 34, true),
      localOffset: view.getUint32(offset + 42, true),
      dataStart: 0
    };
    validateEntryName(entry.name);
    if (names.has(entry.name)) throw new Error(`ZIP 解码后路径重复：${entry.name}`);
    names.add(entry.name);
    resolveZip64Entry(view, nameOffset + nameLength, extraLength, entry);
    if (entry.disk !== 0) throw new Error("暂不支持分卷 ZIP 文件");
    if (entry.flags & 0x41) throw new Error("暂不支持加密 ZIP 文件");
    requireRange({ byteLength: directory.offset }, entry.localOffset, 30);
    if (entry.method === 0 && entry.compressedSize !== entry.uncompressedSize) throw new Error("ZIP 文件尺寸信息不一致");
    result.push(entry);
    offset = nameOffset + nameLength + extraLength + commentLength;
  }
  return result;
}

function readZipLocalHeader(input, entry, directoryOffset) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  requireRange(view, 0, 30);
  if (view.getUint32(0, true) !== 0x04034b50) throw new Error("ZIP 本地文件头损坏");
  if (view.getUint16(8, true) !== entry.method) throw new Error("ZIP 压缩方式信息不一致");
  if (view.getUint16(6, true) & 0x41) throw new Error("暂不支持加密 ZIP 文件");
  entry.dataStart = entry.localOffset + 30 + view.getUint16(26, true) + view.getUint16(28, true);
  requireRange({ byteLength: directoryOffset }, entry.dataStart, entry.compressedSize);
  return entry;
}

function readZipDirectory(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let directory = readZipDirectoryTail(bytes, bytes.length);
  if (directory.zip64Offset !== undefined) {
    directory = readZipDirectoryTail(bytes, bytes.length, 0, bytes.subarray(directory.zip64Offset, directory.zip64Offset + 56));
  }
  const result = readZipCentralDirectory(bytes.subarray(directory.offset, directory.offset + directory.size), directory);
  for (const entry of result) readZipLocalHeader(bytes.subarray(entry.localOffset, entry.localOffset + 30), entry, directory.offset);
  return result;
}

module.exports = { readZipDirectory, readZipDirectoryTail, readZipCentralDirectory, readZipLocalHeader };
