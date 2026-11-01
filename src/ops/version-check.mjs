export function parseVersion(value) {
  if (typeof value !== "string") return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match || match[0] !== value) return null;
  const prerelease = match[4] ? match[4].split(".") : [];
  if (prerelease.some((part) => /^0\d+$/.test(part))) return null;
  return { version: value, core: match.slice(1, 4), prerelease, build: match[5] ? match[5].split(".") : [] };
}

function compareIdentifier(a, b) {
  if (a === b) return 0;
  const numericA = /^\d+$/.test(a);
  const numericB = /^\d+$/.test(b);
  if (numericA && numericB) return a.length === b.length ? (a < b ? -1 : 1) : (a.length < b.length ? -1 : 1);
  if (numericA !== numericB) return numericA ? -1 : 1;
  return a < b ? -1 : 1;
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) {
    const order = compareIdentifier(left.core[i], right.core[i]);
    if (order) return order;
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length ? -1 : 1;
  }
  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
    if (i === left.prerelease.length) return -1;
    if (i === right.prerelease.length) return 1;
    const order = compareIdentifier(left.prerelease[i], right.prerelease[i]);
    if (order) return order;
  }
  return 0;
}
