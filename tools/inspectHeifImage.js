#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Console } = require("node:console");

// Pillow's default decompression-bomb warning threshold. Check before any
// width * height * 4 allocation, including each image in a multi-image HEIF.
const MAX_IMAGE_PIXELS = 89478485;
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"]);
const HEIF_BRANDS = new Set(["mif1", "msf1"]);
let libheifPromise;

function heifBrands(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 16) return [];
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fourcc = offset => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (fourcc(4) !== "ftyp") return [];
  let size = data.getUint32(0), header = 8;
  if (size === 1) {
    if (bytes.byteLength < 24) return [];
    const extendedSize = data.getBigUint64(8);
    if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) return [];
    size = Number(extendedSize);
    header = 16;
  } else if (size === 0) size = bytes.byteLength;
  if (size < header + 8 || size > bytes.byteLength || (size - header - 8) % 4) return [];
  const brands = [fourcc(header)];
  for (let offset = header + 8; offset < size; offset += 4) brands.push(fourcc(offset));
  return brands.filter(brand => HEIC_BRANDS.has(brand) || HEIF_BRANDS.has(brand));
}

// Candidate detection only: acceptance always requires the full pixel decode.
function isHeif(bytes) {
  return heifBrands(bytes).length > 0;
}

async function loadLibheif() {
  if (!libheifPromise) libheifPromise = (async () => {
    const filename = path.resolve(__dirname, "../ReceiveFromMasterGo/node_modules/heic-to/src/lib/libheif-without-unsafe-eval.js");
    const esbuild = require("../ReceiveFromMasterGo/node_modules/esbuild");
    const code = esbuild.buildSync({ entryPoints: [filename], bundle: true, platform: "node", format: "cjs",
      write: false, logLevel: "silent" }).outputFiles[0].text;
    const module = { exports: {} };
    // The bundled decoder logs malformed-container diagnostics with console.log.
    // Route them to stderr so the CLI's stdout remains one machine-readable JSON.
    const diagnostics = new Console({ stdout: process.stderr, stderr: process.stderr });
    new Function("module", "exports", "require", "__filename", "__dirname", "console", code)(
      module, module.exports, require, filename, path.dirname(filename), diagnostics);
    return await module.exports.default();
  })();
  return libheifPromise;
}

async function inspectHeifImage(filename) {
  const bytes = fs.readFileSync(filename);
  const brands = heifBrands(bytes);
  if (!brands.length) throw new Error("Not a HEIF-compatible ftyp image");
  const libheif = await loadLibheif();
  const decoder = new libheif.HeifDecoder();
  let images = [];
  try {
    images = decoder.decode(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    if (!images.length) throw new Error("HEIF container has no decodable images");
    let primary = null;
    for (const image of images) {
      const width = image.get_width(), height = image.get_height();
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
          !Number.isSafeInteger(width * height) || width * height > MAX_IMAGE_PIXELS) {
        throw new Error(`HEIF image dimensions exceed pixel limit (${MAX_IMAGE_PIXELS}): ${width}x${height}`);
      }
      const rgba = { width, height, data: new Uint8ClampedArray(width * height * 4) };
      for (let offset = 3; offset < rgba.data.length; offset += 4) rgba.data[offset] = 255;
      await new Promise((resolve, reject) => {
        image.display(rgba, result => {
          if (!result || result.width !== width || result.height !== height ||
              !ArrayBuffer.isView(result.data) || result.data.byteLength !== width * height * 4) {
            reject(new Error(`HEIF pixel decode failed or returned incorrect dimensions: ${width}x${height}`));
          } else resolve();
        });
      });
      if (!primary || image.is_primary()) primary = { width, height };
    }
    const heic = brands.some(brand => HEIC_BRANDS.has(brand));
    return { format: heic ? "HEIC" : "HEIF", ...primary, frameCount: images.length, extension: heic ? "heic" : "heif" };
  } finally {
    for (const image of images) {
      try { image.free(); } catch (error) { console.error("Unable to release HEIF image:", error.message); }
    }
    if (decoder.decoder) libheif.heif_context_free(decoder.decoder);
  }
}

if (require.main === module) {
  if (process.argv.length !== 3) {
    console.error("Usage: node tools/inspectHeifImage.js <image>");
    process.exitCode = 2;
  } else inspectHeifImage(process.argv[2]).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { inspectHeifImage, isHeif };
