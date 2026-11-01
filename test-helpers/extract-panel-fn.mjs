import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const panelJs = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "panel-ui", "panel.js"),
  "utf8",
);

// Extract a function's source from panel.js by name — the sampling convention
// shared by the panel test files. Pass `params` (a verbatim parameter-list
// string) to pin the exact signature; omit it to allow any signature.
//
// The end anchor is the first "\n  }". A template literal or block comment
// containing that sequence yields a truncated half-function, so the result is
// syntax-checked here: an anchor mismatch must surface at the extraction site
// as a clear failure, not later as a confusing SyntaxError (or not at all).
export function extractPanelFn(name, params) {
  // Only a verbatim string pins the signature; anything else (including the
  // index a bare `names.map(extractFn)` passes as the 2nd arg) means "any
  // signature", matching the single-argument extractFn form.
  const head = typeof params === "string"
    ? `(?:async )?function ${name}\\(${params.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\) \\{`
    : `(?:async )?function ${name}\\(`;
  const src = panelJs.match(new RegExp(`${head}[\\s\\S]*?\\n  \\}`))?.[0];
  assert.ok(src, `panel.js must contain function ${name}`);
  try {
    new Function(src);
  } catch {
    assert.fail(`extractPanelFn(${name}): 切到提前闭合的「\\n  }」半截源码，不是完整函数`);
  }
  return src;
}
