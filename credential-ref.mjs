// Global ApiCred credentialFile reference validator.
// Pure function only. No IO, no filesystem access.
// Contract: a credentialFile is a Store-root-relative
// bare filename that CANNOT escape the credentials directory. Absolute paths,
// drive letters/relative, UNC, parent traversal, any path separator, current-
// directory prefixes, NUL bytes, Windows trailing dot/space squashing and
// reserved device names are all rejected. DPAPI reads resolve the ref
// only under a fixed credentials root, so a hostile store can never steer a
// read outside that root.

// Allowed characters in a bare filename segment: letters, digits, '.', '_', '-'.
const ALLOWED = /^[A-Za-z0-9._-]+$/;

// Windows reserved device names (case-insensitive), with or without extension.
const RESERVED = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

function reject(reason) {
  return { valid: false, reason };
}

export function validateCredentialRef(ref) {
  if (typeof ref !== "string") return reject("credentialFile must be a string");
  if (ref.length === 0) return reject("credentialFile must not be empty");
  if (ref.includes("\u0000")) return reject("credentialFile must not contain a NUL byte");

  // Any path separator is forbidden: no subdirectories, no root-relative,
  // no UNC, no leading slash.
  if (ref.includes("/") || ref.includes("\\")) {
    return reject("credentialFile must not contain a path separator (no subdirectories, absolute, UNC or relative paths)");
  }

  // Drive-letter forms like "C:cred" or "C:\cred". The colon also blocks any
  // alternate data stream form "name:stream".
  if (ref.includes(":")) {
    return reject("credentialFile must not contain a drive letter or stream separator (absolute/drive-relative rejected)");
  }

  // Parent or current directory references.
  if (ref === "." || ref === "..") {
    return reject("credentialFile must not be a directory traversal segment");
  }

  // Trailing dot or space: Windows silently strips these, which would let two
  // distinct refs collapse to the same on-disk name.
  if (/[. ]$/.test(ref)) {
    return reject("credentialFile must not end with a dot or space (Windows name squashing)");
  }

  if (!ALLOWED.test(ref)) {
    return reject("credentialFile may only contain letters, digits, '.', '_', '-'");
  }

  // Reserved device name check on the base name (portion before the first dot).
  const base = ref.split(".")[0].toLowerCase();
  if (RESERVED.has(base)) {
    return reject("credentialFile must not be a reserved Windows device name");
  }

  return { valid: true, reason: "" };
}
