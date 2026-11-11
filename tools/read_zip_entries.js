"use strict";

const fs = require("node:fs");
const zlib = require("node:zlib");
const { readZipDirectoryTail, readZipCentralDirectory, readZipLocalHeader } = require("../shared/zipArchive.js");

function readRangeSync(fd, start, size, archiveSize) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || start < 0 || size < 0 || start + size > archiveSize) {
    throw new Error("ZIP 数据范围损坏或文件不完整");
  }
  const buffer = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const read = fs.readSync(fd, buffer, offset, size - offset, start + offset);
    if (read <= 0) throw new Error("ZIP 文件读取不完整");
    offset += read;
  }
  return buffer;
}

function readZipEntries(filePath) {
  const archiveSize = fs.statSync(filePath).size;
  const fd = fs.openSync(filePath, "r");
  try {
    const tailStart = Math.max(0, archiveSize - 22 - 65535 - 20);
    const tail = readRangeSync(fd, tailStart, archiveSize - tailStart, archiveSize);
    let location = readZipDirectoryTail(tail, archiveSize, tailStart);
    if (location.zip64Offset !== undefined) {
      location = readZipDirectoryTail(tail, archiveSize, tailStart, readRangeSync(fd, location.zip64Offset, 56, archiveSize));
    }
    const directory = readZipCentralDirectory(readRangeSync(fd, location.offset, location.size, archiveSize), location);
    const entries = Object.create(null);
    for (const entry of directory) {
      readZipLocalHeader(readRangeSync(fd, entry.localOffset, 30, archiveSize), entry, location.offset);
      if (entry.name.endsWith("/")) continue;
      const compressed = readRangeSync(fd, entry.dataStart, entry.compressedSize, archiveSize);
      let content;
      if (entry.method === 0) content = compressed;
      else if (entry.method === 8) content = zlib.inflateRawSync(compressed);
      else throw new Error("暂不支持此 ZIP 压缩方式");
      if (content.length !== entry.uncompressedSize) throw new Error("ZIP 解压后的文件尺寸不一致");
      entries[entry.name] = content;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readZipEntries, readRangeSync };
