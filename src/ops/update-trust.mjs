import { createPublicKey, verify } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { parseVersion } from "./version-check.mjs";
const PUBLIC_KEY_MARKER = "__ANYSWITCH_UPDATE_PUBLIC_KEY__";
export const UPDATE_SIGNING_PUBLIC_KEY = PUBLIC_KEY_MARKER.startsWith("__ANYSWITCH_") ? null : PUBLIC_KEY_MARKER;

export const MANIFEST_KEYS = Object.freeze(["schema", "version", "channel", "platform", "asset", "sha256", "size"]);
export const isValidReleaseVersion = (value) => parseVersion(value) !== null;
export const desktopReleaseArchiveName = (version) => `anyswitch-v${version}-win-x64-desktop.zip`;
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function decodeBase64(value, length) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("invalid base64");
  const data = Buffer.from(value, "base64");
  if (data.length !== length || data.toString("base64") !== value) throw new Error("invalid base64 length");
  return data;
}

export function verifyReleaseManifest(manifestBytes, signatureBase64, {
  publicKey = UPDATE_SIGNING_PUBLIC_KEY,
  assetName,
  channel,
  prerelease,
  assetDigest,
  assetSize,
} = {}) {
  const bytes = Buffer.isBuffer(manifestBytes) ? manifestBytes : Buffer.from(manifestBytes);
  if (bytes.length === 0 || bytes.length > 16 * 1024) throw new Error("invalid manifest size");
  if (typeof publicKey !== "string" || !publicKey) throw new Error("release signing key unavailable");
  let doc;
  try { doc = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("invalid release manifest"); }
  if (!doc || Array.isArray(doc) || typeof doc !== "object" || JSON.stringify(Object.keys(doc)) !== JSON.stringify(MANIFEST_KEYS)) throw new Error("invalid manifest fields");
  const { schema, version, channel: signedChannel, platform, asset, sha256, size } = doc;
  const parsed = parseVersion(version);
  if (schema !== 1 || !parsed || platform !== "win-x64" || !["stable", "preview"].includes(signedChannel)) throw new Error("invalid manifest identity");
  if ((signedChannel === "preview") !== (parsed.prerelease.length > 0)) throw new Error("manifest channel does not match version");
  const expectedAsset = desktopReleaseArchiveName(version);
  if (asset !== expectedAsset || assetName !== expectedAsset) throw new Error("manifest asset mismatch");
  if (channel !== signedChannel || prerelease !== (signedChannel === "preview")) throw new Error("release channel mismatch");
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256) || !Number.isSafeInteger(size) || size <= 0) throw new Error("invalid manifest digest");
  if (assetDigest !== undefined && assetDigest !== null && assetDigest !== "sha256:" + sha256) throw new Error("release digest mismatch");
  if (assetSize !== undefined && assetSize !== null && assetSize !== size) throw new Error("release asset size mismatch");
  const canonical = Buffer.from(JSON.stringify({ schema, version, channel: signedChannel, platform, asset, sha256, size }), "utf8");
  if (!bytes.equals(canonical)) throw new Error("manifest is not canonical");
  const rawKey = decodeBase64(publicKey, 32);
  const signature = decodeBase64(signatureBase64, 64);
  const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, rawKey]), format: "der", type: "spki" });
  if (!verify(null, bytes, key, signature)) throw new Error("release signature invalid");
  return { schema, version, channel: signedChannel, platform, asset, sha256, size };
}

export function parseCurrentPointer(text) {
  let doc;
  try { doc = JSON.parse(String(text)); } catch { throw new Error("invalid current pointer"); }
  if (!doc || Array.isArray(doc) || typeof doc !== "object" || doc.schema !== 1 || typeof doc.version !== "string" || !isValidReleaseVersion(doc.version) || Object.keys(doc).sort().join(",") !== "schema,version") throw new Error("invalid current pointer");
  return { schema: 1, version: doc.version };
}

export function resolveInstallRoot({ appRoot, appDir, env = process.env } = {}) {
  const currentApp = appRoot ?? env.ANYSWITCH_APP_ROOT ?? appDir ?? env.ANYSWITCH_APP_DIR;
  if (typeof currentApp === "string" && currentApp) {
    const versionDir = dirname(resolve(currentApp));
    if (basename(dirname(versionDir)).toLowerCase() === "versions") return dirname(dirname(versionDir));
  }
  const fromEnv = env.ANYSWITCH_INSTALL_ROOT;
  return typeof fromEnv === "string" && fromEnv.trim() ? fromEnv : null;
}
