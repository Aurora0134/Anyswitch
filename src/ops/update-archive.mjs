import { mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";
import { isValidReleaseVersion } from "./update-trust.mjs";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
const crc32 = (data) => { let c = 0xffffffff; for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function safeName(name) {
  if (!name || name.includes("\\") || name.includes("\0") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) return false;
  const parts = (name.endsWith("/") ? name.slice(0, -1) : name).split("/");
  return ["app", "runtime"].includes(parts[0]) && parts.every((part) => part && part !== "." && part !== ".." && !/[<>:"|?*]/.test(part));
}

function extractReleaseArchiveUnsafe(input, destination, { maxBytes = 1024 * 1024 * 1024, maxExpandedBytes = 1024 * 1024 * 1024 } = {}) {
  const data = Buffer.from(input);
  if (data.length === 0 || data.length > maxBytes) throw new Error("release archive size invalid");
  const targetRoot = resolve(destination);
  try {
    const parent = dirname(targetRoot);
    if (realpathSync(parent).toLowerCase() !== parent.toLowerCase()) throw new Error("staging parent resolves through a link");
    if (existsSync(targetRoot)) {
      if (lstatSync(targetRoot).isSymbolicLink() || !lstatSync(targetRoot).isDirectory() || readdirSync(targetRoot).length !== 0) throw new Error("staging directory must be empty and private");
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  let end = -1;
  for (let i = Math.max(0, data.length - 65557); i <= data.length - 22; i++) if (data.readUInt32LE(i) === 0x06054b50) end = i;
  if (end < 0 || data.readUInt16LE(end + 4) !== 0 || data.readUInt16LE(end + 6) !== 0) throw new Error("invalid ZIP directory");
  const count = data.readUInt16LE(end + 10), dirSize = data.readUInt32LE(end + 12), dirOffset = data.readUInt32LE(end + 16);
  if (count !== data.readUInt16LE(end + 8) || dirOffset + dirSize !== end) throw new Error("invalid ZIP directory");
  if (!existsSync(targetRoot)) mkdirSync(targetRoot, { recursive: false });
  let cursor = dirOffset;
  let expandedBytes = 0;
  const names = new Set();
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || data.readUInt32LE(cursor) !== 0x02014b50) throw new Error("invalid ZIP entry");
    const madeBy = data.readUInt16LE(cursor + 4), flags = data.readUInt16LE(cursor + 8), method = data.readUInt16LE(cursor + 10);
    const crc = data.readUInt32LE(cursor + 16), compressed = data.readUInt32LE(cursor + 20), length = data.readUInt32LE(cursor + 24);
    const nameLength = data.readUInt16LE(cursor + 28), extraLength = data.readUInt16LE(cursor + 30), commentLength = data.readUInt16LE(cursor + 32);
    const external = data.readUInt32LE(cursor + 38), localOffset = data.readUInt32LE(cursor + 42);
    const entryEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (entryEnd > end || compressed === 0xffffffff || length === 0xffffffff || localOffset === 0xffffffff) throw new Error("unsupported ZIP entry");
    const nameBytes = data.subarray(cursor + 46, cursor + 46 + nameLength), name = nameBytes.toString("utf8");
    const foldedName = name.toLocaleLowerCase("en-US");
    if (!Buffer.from(name, "utf8").equals(nameBytes) || !safeName(name) || names.has(foldedName)) throw new Error("unsafe ZIP path");
    names.add(foldedName);
    const mode = madeBy >> 8 === 3 ? external >>> 16 : 0;
    if ((mode & 0xf000) === 0xa000 || (flags & 1) || (method !== 0 && method !== 8) || length > 512 * 1024 * 1024) throw new Error("unsupported ZIP entry");
    if (localOffset + 30 > dirOffset || data.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("invalid ZIP data");
    const localFlags = data.readUInt16LE(localOffset + 6), localMethod = data.readUInt16LE(localOffset + 8);
    const localCrc = data.readUInt32LE(localOffset + 14), localCompressed = data.readUInt32LE(localOffset + 18), localLength = data.readUInt32LE(localOffset + 22);
    const localNameLength = data.readUInt16LE(localOffset + 26), localExtraLength = data.readUInt16LE(localOffset + 28);
    if (!data.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(nameBytes) || localFlags !== flags || localMethod !== method || localCrc !== crc || localCompressed !== compressed || localLength !== length) throw new Error("ZIP local and central headers mismatch");
    const start = localOffset + 30 + localNameLength + localExtraLength, finish = start + compressed;
    if (finish > dirOffset) throw new Error("invalid ZIP data");
    expandedBytes += length;
    if (expandedBytes > maxExpandedBytes) throw new Error("expanded release exceeds size limit");
    const content = method === 0 ? data.subarray(start, finish) : inflateRawSync(data.subarray(start, finish), { maxOutputLength: Math.min(512 * 1024 * 1024, maxExpandedBytes) });
    if (content.length !== length || crc32(content) !== crc) throw new Error("ZIP checksum mismatch");
    const target = resolve(targetRoot, ...name.split("/"));
    if (!target.startsWith(targetRoot + sep) && target !== targetRoot) throw new Error("unsafe ZIP path");
    if (name.endsWith("/")) mkdirSync(target, { recursive: true });
    else { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content, { flag: "wx" }); }
    cursor = entryEnd;
  }
  if (cursor !== dirOffset + dirSize) throw new Error("invalid ZIP directory size");
  const appDir = resolve(targetRoot, "app"), nodePath = resolve(targetRoot, "runtime", "node.exe");
  if (!existsSync(resolve(appDir, "package.json")) || !existsSync(nodePath)) throw new Error("release payload incomplete");
  const pkg = JSON.parse(readFileSync(resolve(appDir, "package.json"), "utf8"));
  if (typeof pkg.version !== "string" || !isValidReleaseVersion(pkg.version)) throw new Error("invalid package version");
  return { appDir, nodePath, version: pkg.version };
}

export function extractReleaseArchive(input, destination, options) {
  const existed = existsSync(destination);
  try {
    return extractReleaseArchiveUnsafe(input, destination, options);
  } catch (error) {
    if (!existed) {
      try { rmSync(destination, { recursive: true, force: true }); } catch { /* preserve validation failure */ }
    }
    throw error;
  }
}
