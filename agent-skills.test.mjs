import test, { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  createJunction,
  createSkillsService,
  deleteLocalSkill,
  deleteRepoSkill,
  deploy,
  diffDirs,
  diffLocalSkill,
  ensureFolderPickerHelper,
  hashDir,
  importSkill,
  listEndpoints,
  loadSkillsConfig,
  mergeLocalSkill,
  parseSkillFrontmatter,
  pickFile,
  pickFolder,
  readSkillBody,
  resolveConflictSkill,
  saveSkillsConfig,
  scanEndpoints,
  scanRepo,
  undeploy,
} from "./agent-skills.mjs";

// Temp-rooted fixture: a fake home dir (endpoint skills dirs live under it)
// plus a master repo with nested/container skills. Real junctions are created
// under %TEMP% — this suite is Windows-only by design.
function tempRoot(prefix = "anyswitch-skills-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeSkill(dir, { name, description = "desc", extra = "" } = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name ?? ""}\ndescription: ${description}\n${extra}---\n\nbody\n`,
  );
  writeFileSync(join(dir, "helper.txt"), `content of ${dir}`);
}

// A mock recycleBin that records the call and removes the directory (the real
// one sends it to the Recycle Bin; the observable postcondition is the same).
function mockRecycle(calls) {
  return async (p) => {
    calls.push(p);
    rmSync(p, { recursive: true, force: true });
  };
}

describe("parseSkillFrontmatter", () => {
  it("parses plain, quoted, and block-scalar fields and tolerates extras", () => {
    const fm = parseSkillFrontmatter([
      "---",
      "name: my-skill",
      'description: "quoted desc"',
      "trigger_words:",
      "  - foo",
      "  - bar",
      "compatibility: 'claude'",
      "---",
      "",
      "body",
    ].join("\n"));
    assert.equal(fm.name, "my-skill");
    assert.equal(fm.description, "quoted desc");
    assert.equal(fm.compatibility, "claude");
    // nested list collapses to an empty parent key; no crash, no garbage
    assert.equal(fm.trigger_words, "");
  });

  it("parses a multi-line description block scalar (|)", () => {
    const fm = parseSkillFrontmatter([
      "---",
      "name: blocky",
      "description: |",
      "  first line",
      "  second line",
      "metadata:",
      "  author: someone",
      "---",
    ].join("\n"));
    assert.equal(fm.name, "blocky");
    assert.equal(fm.description, "first line\nsecond line");
  });

  it("returns an empty map for missing or unterminated frontmatter", () => {
    assert.deepEqual(parseSkillFrontmatter("no frontmatter here"), {});
    assert.deepEqual(parseSkillFrontmatter("---\nname: x\n"), {});
    assert.deepEqual(parseSkillFrontmatter(null), {});
  });
});

describe("scanRepo", () => {
  it("finds nested/container skills, skips .git and non-skill dirs", () => {
    const { dir, cleanup } = tempRoot();
    try {
      const repo = join(dir, "repo");
      writeSkill(join(repo, "skill-a"), { name: "skill-a" });
      writeSkill(join(repo, "animate-skills", "skill-b"), { name: "skill-b" });
      writeSkill(join(repo, "skills", "skill-c"), { name: "skill-c" });
      writeSkill(join(repo, ".git", "hidden"), { name: "hidden" });
      mkdirSync(join(repo, "notes"), { recursive: true }); // no SKILL.md
      writeFileSync(join(repo, "notes", "readme.md"), "not a skill");

      const skills = scanRepo(repo);
      const names = skills.map((s) => s.name).sort();
      assert.deepEqual(names, ["skill-a", "skill-b", "skill-c"]);
      const b = skills.find((s) => s.name === "skill-b");
      assert.equal(b.dirName, "skill-b");
      assert.ok(b.relPath.replace(/\\/g, "/").endsWith("animate-skills/skill-b"));
    } finally {
      cleanup();
    }
  });

  it("falls back to the directory name when frontmatter has no name", () => {
    const { dir, cleanup } = tempRoot();
    try {
      const repo = join(dir, "repo");
      mkdirSync(join(repo, "noname"), { recursive: true });
      writeFileSync(join(repo, "noname", "SKILL.md"), "---\ndescription: only desc\n---\n");
      const skills = scanRepo(repo);
      assert.equal(skills.length, 1);
      assert.equal(skills[0].name, "noname");
      assert.equal(skills[0].description, "only desc");
    } finally {
      cleanup();
    }
  });

  it("returns [] for a missing repo path", () => {
    assert.deepEqual(scanRepo(join(tmpdir(), "definitely-not-here-xyz")), []);
  });
});

describe("hashDir / diffDirs", () => {
  it("identical trees hash equal; content change or file add/remove differs", () => {
    const { dir, cleanup } = tempRoot();
    try {
      const a = join(dir, "a");
      const b = join(dir, "b");
      writeSkill(a, { name: "x" });
      cpSync(a, b, { recursive: true });
      assert.equal(hashDir(a), hashDir(b));
      assert.deepEqual(diffDirs(a, b), []);

      writeFileSync(join(b, "helper.txt"), "changed");
      assert.notEqual(hashDir(a), hashDir(b));
      assert.deepEqual(diffDirs(a, b), [{ path: "helper.txt", kind: "different" }]);

      writeFileSync(join(b, "extra.txt"), "new");
      const kinds = Object.fromEntries(diffDirs(a, b).map((d) => [d.path, d.kind]));
      assert.deepEqual(kinds, { "extra.txt": "only-b", "helper.txt": "different" });
      rmSync(join(b, "extra.txt"));
      rmSync(join(b, "helper.txt"));
      assert.deepEqual(diffDirs(a, b), [{ path: "helper.txt", kind: "only-a" }]);
    } finally {
      cleanup();
    }
  });
});

describe("deploy / undeploy", () => {
  function setup() {
    const { dir, cleanup } = tempRoot();
    const home = join(dir, "home");
    const repo = join(dir, "repo");
    writeSkill(join(repo, "skill-a"), { name: "skill-a" });
    return { dir, home, repo, cleanup };
  }
  const claudeDir = (home) => join(home, ".claude", "skills");

  it("deploys as a junction, auto-creates the endpoint dir, and is idempotent", async () => {
    const { home, repo, cleanup } = setup();
    const calls = [];
    try {
      assert.equal(existsSync(claudeDir(home)), false);
      const r1 = await deploy(
        { endpointId: "claude", skillName: "skill-a", repoPath: repo },
        { homeDir: home, recycleDirFn: mockRecycle(calls) },
      );
      assert.equal(r1.ok, true);
      const link = join(claudeDir(home), "skill-a");
      assert.equal(lstatSync(link).isSymbolicLink(), true, "junction created");
      // the skill is readable through the link
      assert.equal(existsSync(join(link, "SKILL.md")), true);

      const r2 = await deploy(
        { endpointId: "claude", skillName: "skill-a", repoPath: repo },
        { homeDir: home, recycleDirFn: mockRecycle(calls) },
      );
      assert.equal(r2.idempotent, true);
      assert.equal(calls.length, 0, "idempotent deploy never recycles anything");
    } finally {
      cleanup();
    }
  });

  it("replaces an identical local directory via the recycle bin, no conflict", async () => {
    const { home, repo, cleanup } = setup();
    const calls = [];
    try {
      mkdirSync(claudeDir(home), { recursive: true });
      cpSync(join(repo, "skill-a"), join(claudeDir(home), "skill-a"), { recursive: true });
      const r = await deploy(
        { endpointId: "claude", skillName: "skill-a", repoPath: repo },
        { homeDir: home, recycleDirFn: mockRecycle(calls) },
      );
      assert.equal(r.ok, true);
      assert.equal(calls.length, 1, "identical local dir went to the recycle bin");
      assert.equal(lstatSync(join(claudeDir(home), "skill-a")).isSymbolicLink(), true);
    } finally {
      cleanup();
    }
  });

  it("returns a conflict with diffs for a diverged local directory, and force replaces it", async () => {
    const { home, repo, cleanup } = setup();
    const calls = [];
    try {
      mkdirSync(claudeDir(home), { recursive: true });
      cpSync(join(repo, "skill-a"), join(claudeDir(home), "skill-a"), { recursive: true });
      writeFileSync(join(claudeDir(home), "skill-a", "local-only.txt"), "mine");

      const conflict = await deploy(
        { endpointId: "claude", skillName: "skill-a", repoPath: repo },
        { homeDir: home, recycleDirFn: mockRecycle(calls) },
      );
      assert.equal(conflict.ok, false);
      assert.equal(conflict.conflict, true);
      assert.deepEqual(conflict.diffs, [{ path: "local-only.txt", kind: "only-b" }]);
      assert.equal(calls.length, 0, "conflict path recycles nothing");
      assert.equal(lstatSync(join(claudeDir(home), "skill-a")).isSymbolicLink(), false);

      const forced = await deploy(
        { endpointId: "claude", skillName: "skill-a", repoPath: repo, force: true },
        { homeDir: home, recycleDirFn: mockRecycle(calls) },
      );
      assert.equal(forced.ok, true);
      assert.equal(calls.length, 1);
      assert.equal(lstatSync(join(claudeDir(home), "skill-a")).isSymbolicLink(), true);
    } finally {
      cleanup();
    }
  });

  it("refuses unknown skills and unknown endpoints", async () => {
    const { home, repo, cleanup } = setup();
    try {
      await assert.rejects(
        deploy({ endpointId: "claude", skillName: "nope", repoPath: repo }, { homeDir: home }),
        /不存在/,
      );
      await assert.rejects(
        deploy({ endpointId: "nope", skillName: "skill-a", repoPath: repo }, { homeDir: home }),
        /unknown endpoint/,
      );
    } finally {
      cleanup();
    }
  });

  it("undeploy removes only the junction and refuses real directories", async () => {
    const { home, repo, cleanup } = setup();
    try {
      await deploy(
        { endpointId: "claude", skillName: "skill-a", repoPath: repo },
        { homeDir: home, recycleDirFn: mockRecycle([]) },
      );
      const link = join(claudeDir(home), "skill-a");
      const r = await undeploy(
        { endpointId: "claude", skillName: "skill-a", repoPath: repo },
        { homeDir: home },
      );
      assert.equal(r.ok, true);
      assert.equal(existsSync(link), false, "junction gone");
      assert.equal(existsSync(join(repo, "skill-a", "SKILL.md")), true, "repo target untouched");

      // idempotent when nothing is deployed
      const again = await undeploy(
        { endpointId: "claude", skillName: "skill-a", repoPath: repo },
        { homeDir: home },
      );
      assert.equal(again.idempotent, true);

      // real directory: refused, never deleted
      mkdirSync(join(claudeDir(home), "real-one"), { recursive: true });
      writeFileSync(join(claudeDir(home), "real-one", "SKILL.md"), "---\nname: real-one\n---\n");
      await assert.rejects(
        undeploy({ endpointId: "claude", skillName: "real-one", repoPath: repo }, { homeDir: home }),
        /实体目录/,
      );
      assert.equal(existsSync(join(claudeDir(home), "real-one", "SKILL.md")), true);
    } finally {
      cleanup();
    }
  });

  it("refuses a traversal skillName before any path is touched", async () => {
    const { home, repo, cleanup } = setup();
    try {
      // the path a traversal payload would escape to: home/.claude/other
      mkdirSync(join(home, ".claude"), { recursive: true });
      createJunction(join(home, ".claude", "other"), join(repo, "skill-a"));
      await assert.rejects(
        undeploy({ endpointId: "claude", skillName: join("..", "other"), repoPath: repo }, { homeDir: home }),
        (err) => err.statusCode === 400 && /skillName/.test(err.message),
      );
      assert.equal(
        lstatSync(join(home, ".claude", "other")).isSymbolicLink(), true,
        "escaped-to junction untouched",
      );
    } finally {
      cleanup();
    }
  });
});

describe("importSkill", () => {
  it("imports a valid skill and refuses duplicates / SKILL.md-less sources", () => {
    const { dir, cleanup } = tempRoot();
    try {
      const repo = join(dir, "repo");
      writeSkill(join(repo, "skill-a"), { name: "skill-a" });
      const external = join(dir, "external", "cool-tool");
      writeSkill(external, { name: "cool-tool", description: "imported" });

      const r = importSkill({ repoPath: repo, sourcePath: external });
      assert.equal(r.ok, true);
      assert.equal(r.skill.name, "cool-tool");
      assert.equal(existsSync(join(repo, "cool-tool", "SKILL.md")), true);
      assert.ok(scanRepo(repo).some((s) => s.name === "cool-tool"));

      assert.throws(() => importSkill({ repoPath: repo, sourcePath: external }), /同名/);
      const bare = join(dir, "bare");
      mkdirSync(bare, { recursive: true });
      assert.throws(() => importSkill({ repoPath: repo, sourcePath: bare }), /SKILL\.md/);
      assert.throws(() => importSkill({ repoPath: repo, sourcePath: join(dir, "ghost") }), /不存在/);
    } finally {
      cleanup();
    }
  });
});

// Real System32 bsdtar: available on this Windows host and exercised live
// below. The helper zips `sourceDir` into `zipName` using bsdtar itself.
const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
const tarPath = join(systemRoot, "System32", "tar.exe");
function zipDir(sourceDir, zipPath) {
  const r = spawnSync(tarPath, ["-a", "-c", "-f", zipPath, basename(sourceDir)], { cwd: dirname(sourceDir) });
  if (r.status !== 0) throw new Error(`zip fixture failed: ${r.stderr}`);
}

describe("importSkill (zip sources)", () => {
  before(function () {
    if (!existsSync(tarPath)) this.skip();
  });

  it("imports a zip whose archive root holds SKILL.md, stored as a folder", () => {
    const { dir, cleanup } = tempRoot("anyswitch-skills-zip-");
    try {
      const repo = join(dir, "repo");
      writeSkill(join(repo, "skill-a"), { name: "skill-a" });
      const src = join(dir, "pack");
      writeSkill(src, { name: "zipped-skill", description: "from zip" });
      const zipPath = join(dir, "pack.zip");
      zipDir(src, zipPath);

      const r = importSkill({ repoPath: repo, sourcePath: zipPath });
      assert.equal(r.ok, true);
      assert.equal(r.skill.dirName, "pack");
      assert.equal(r.skill.name, "zipped-skill");
      // zip 导入后以文件夹形式储存，保持统一
      assert.equal(existsSync(join(repo, "pack", "SKILL.md")), true);
      assert.equal(existsSync(join(repo, "pack", "helper.txt")), true);
      assert.equal(lstatSync(join(repo, "pack")).isDirectory(), true);
      assert.ok(scanRepo(repo).some((s) => s.name === "zipped-skill"));

      assert.throws(() => importSkill({ repoPath: repo, sourcePath: zipPath }), /同名/);
    } finally {
      cleanup();
    }
  });

  it("imports a zip with the skill nested in one wrapper directory", () => {
    const { dir, cleanup } = tempRoot("anyswitch-skills-zip-");
    try {
      const repo = join(dir, "repo");
      writeSkill(join(repo, "skill-a"), { name: "skill-a" });
      // GitHub "Download ZIP" shape: repo-main/skill files
      const inner = join(dir, "wrapper", "gh-repo-main");
      writeSkill(inner, { name: "nested-skill" });
      const zipPath = join(dir, "wrapper.zip");
      zipDir(join(dir, "wrapper"), zipPath);

      const r = importSkill({ repoPath: repo, sourcePath: zipPath });
      assert.equal(r.ok, true);
      assert.equal(r.skill.dirName, "gh-repo-main");
      assert.equal(r.skill.name, "nested-skill");
      assert.equal(existsSync(join(repo, "gh-repo-main", "SKILL.md")), true);
    } finally {
      cleanup();
    }
  });

  it("refuses ambiguous and SKILL.md-less zips and non-zip files", () => {
    const { dir, cleanup } = tempRoot("anyswitch-skills-zip-");
    try {
      const repo = join(dir, "repo");
      writeSkill(join(repo, "skill-a"), { name: "skill-a" });

      // two top-level skill dirs → ambiguous
      writeSkill(join(dir, "multi", "one"), { name: "one" });
      writeSkill(join(dir, "multi", "two"), { name: "two" });
      const multiZip = join(dir, "multi.zip");
      zipDir(join(dir, "multi"), multiZip);
      assert.throws(() => importSkill({ repoPath: repo, sourcePath: multiZip }), /无法确定/);

      // no SKILL.md anywhere
      mkdirSync(join(dir, "empty", "stuff"), { recursive: true });
      writeFileSync(join(dir, "empty", "stuff", "a.txt"), "x");
      const emptyZip = join(dir, "empty.zip");
      zipDir(join(dir, "empty"), emptyZip);
      assert.throws(() => importSkill({ repoPath: repo, sourcePath: emptyZip }), /未找到 SKILL\.md/);

      // a random file (not .zip) is refused before any extraction
      const txt = join(dir, "plain.txt");
      writeFileSync(txt, "x");
      assert.throws(() => importSkill({ repoPath: repo, sourcePath: txt }), /仅支持目录或 \.zip/);
      // and nothing leaked into the repo meanwhile
      assert.equal(scanRepo(repo).length, 1);
    } finally {
      cleanup();
    }
  });
});

describe("deleteRepoSkill", () => {
  it("removes referencing junctions first, then recycles the repo directory", async () => {
    const { dir, cleanup } = tempRoot();
    const home = join(dir, "home");
    const repo = join(dir, "repo");
    writeSkill(join(repo, "skill-a"), { name: "skill-a" });
    const order = [];
    try {
      await deploy(
        { endpointId: "claude", skillName: "skill-a", repoPath: repo },
        { homeDir: home, recycleDirFn: mockRecycle([]) },
      );
      await deploy(
        { endpointId: "kimi", skillName: "skill-a", repoPath: repo },
        { homeDir: home, recycleDirFn: mockRecycle([]) },
      );
      const recycle = async (p) => {
        order.push(`recycle:${p}`);
        // junctions must already be gone when the repo dir is recycled
        assert.equal(existsSync(join(home, ".claude", "skills", "skill-a")), false);
        assert.equal(existsSync(join(home, ".kimi-code", "skills", "skill-a")), false);
        rmSync(p, { recursive: true, force: true });
      };
      const r = await deleteRepoSkill(
        { repoPath: repo, skillName: "skill-a" },
        { homeDir: home, recycleDirFn: recycle },
      );
      assert.equal(r.ok, true);
      assert.deepEqual([...r.unlinked].sort(), ["claude", "kimi"]);
      assert.equal(order.length, 1);
      assert.equal(existsSync(join(repo, "skill-a")), false);
    } finally {
      cleanup();
    }
  });

  it("propagates a recycle failure and never hard-deletes", async () => {
    const { dir, cleanup } = tempRoot();
    const home = join(dir, "home");
    const repo = join(dir, "repo");
    writeSkill(join(repo, "skill-a"), { name: "skill-a" });
    try {
      const failing = async () => {
        throw new Error("recycle bin unavailable");
      };
      await assert.rejects(
        deleteRepoSkill({ repoPath: repo, skillName: "skill-a" }, { homeDir: home, recycleDirFn: failing }),
        /recycle bin unavailable/,
      );
      assert.equal(existsSync(join(repo, "skill-a", "SKILL.md")), true, "repo dir still in place");
    } finally {
      cleanup();
    }
  });
});

describe("mergeLocalSkill", () => {
  it("copies into the repo, recycles the local dir, then links it back", async () => {
    const { dir, cleanup } = tempRoot();
    const home = join(dir, "home");
    const repo = join(dir, "repo");
    writeSkill(join(repo, "skill-a"), { name: "skill-a" });
    const local = join(home, ".claude", "skills", "local-gem");
    writeSkill(local, { name: "local-gem" });
    const order = [];
    const recycle = async (p) => {
      order.push("recycle");
      assert.equal(existsSync(join(repo, "local-gem", "SKILL.md")), true, "copied before recycle");
      rmSync(p, { recursive: true, force: true });
    };
    try {
      const r = await mergeLocalSkill(
        { endpointId: "claude", skillName: "local-gem", repoPath: repo },
        { homeDir: home, recycleDirFn: recycle },
      );
      assert.equal(r.ok, true);
      assert.deepEqual(order, ["recycle"]);
      assert.ok(scanRepo(repo).some((s) => s.name === "local-gem"), "adopted into the repo");
      assert.equal(lstatSync(local).isSymbolicLink(), true, "local path is now a junction");
      assert.equal(existsSync(join(local, "SKILL.md")), true, "readable through the link");
    } finally {
      cleanup();
    }
  });

  it("reuses an identical repo copy and conflicts on divergence", async () => {
    const { dir, cleanup } = tempRoot();
    const home = join(dir, "home");
    const repo = join(dir, "repo");
    writeSkill(join(repo, "skill-a"), { name: "skill-a" });
    const local = join(home, ".claude", "skills", "skill-a");
    try {
      cpSync(join(repo, "skill-a"), local, { recursive: true });
      const calls = [];
      const r1 = await mergeLocalSkill(
        { endpointId: "claude", skillName: "skill-a", repoPath: repo },
        { homeDir: home, recycleDirFn: mockRecycle(calls) },
      );
      assert.equal(r1.ok, true);
      assert.equal(r1.reusedRepoCopy, true);
      assert.equal(lstatSync(local).isSymbolicLink(), true);
      assert.ok(scanRepo(repo).some((s) => s.name === "skill-a"));

      // diverged local copy -> conflict, nothing touched
      rmSync(local); // remove junction
      cpSync(join(repo, "skill-a"), local, { recursive: true });
      writeFileSync(join(local, "changed.txt"), "diverged");
      const calls2 = [];
      const r2 = await mergeLocalSkill(
        { endpointId: "claude", skillName: "skill-a", repoPath: repo },
        { homeDir: home, recycleDirFn: mockRecycle(calls2) },
      );
      assert.equal(r2.ok, false);
      assert.equal(r2.conflict, true);
      assert.deepEqual(r2.diffs, [{ path: "changed.txt", kind: "only-b" }]);
      assert.equal(calls2.length, 0);
      assert.equal(lstatSync(local).isSymbolicLink(), false, "local dir untouched");
    } finally {
      cleanup();
    }
  });

  it("refuses a traversal skillName before any file operation", async () => {
    const { dir, cleanup } = tempRoot();
    const home = join(dir, "home");
    const repo = join(dir, "repo");
    writeSkill(join(repo, "skill-a"), { name: "skill-a" });
    // the path a traversal payload would escape to: home/.claude/other
    writeSkill(join(home, ".claude", "other"), { name: "other" });
    const calls = [];
    try {
      await assert.rejects(
        mergeLocalSkill(
          { endpointId: "claude", skillName: join("..", "other"), repoPath: repo },
          { homeDir: home, recycleDirFn: mockRecycle(calls) },
        ),
        (err) => err.statusCode === 400 && /skillName/.test(err.message),
      );
      assert.equal(calls.length, 0, "nothing recycled");
      assert.equal(existsSync(join(home, ".claude", "other", "SKILL.md")), true, "escaped-to dir untouched");
      assert.equal(scanRepo(repo).length, 1, "repo unchanged");
    } finally {
      cleanup();
    }
  });
});

describe("deleteLocalSkill", () => {
  it("sends an endpoint-local real directory to the recycle bin", async () => {
    const { dir, cleanup } = tempRoot();
    const home = join(dir, "home");
    const local = join(home, ".claude", "skills", "local-gem");
    writeSkill(local, { name: "local-gem" });
    const calls = [];
    try {
      const r = await deleteLocalSkill(
        { endpointId: "claude", skillName: "local-gem" },
        { homeDir: home, recycleDirFn: mockRecycle(calls) },
      );
      assert.equal(r.ok, true);
      assert.deepEqual(calls, [local]);
      assert.equal(existsSync(local), false, "local dir gone after recycle");
    } finally {
      cleanup();
    }
  });

  it("refuses junctions, missing dirs, and path traversal", async () => {
    const { dir, cleanup } = tempRoot();
    const home = join(dir, "home");
    const repo = join(dir, "repo");
    writeSkill(join(repo, "skill-a"), { name: "skill-a" });
    const local = join(home, ".claude", "skills", "skill-a");
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    createJunction(local, join(repo, "skill-a"));
    writeSkill(join(home, ".claude", "other"), { name: "other" });
    const calls = [];
    try {
      await assert.rejects(
        deleteLocalSkill({ endpointId: "claude", skillName: "skill-a" }, { homeDir: home, recycleDirFn: mockRecycle(calls) }),
        /实体目录/,
      );
      assert.equal(lstatSync(local).isSymbolicLink(), true, "junction untouched");
      await assert.rejects(
        deleteLocalSkill({ endpointId: "claude", skillName: "nope" }, { homeDir: home, recycleDirFn: mockRecycle(calls) }),
        /实体目录/,
      );
      await assert.rejects(
        deleteLocalSkill({ endpointId: "claude", skillName: join("..", "other") }, { homeDir: home, recycleDirFn: mockRecycle(calls) }),
        /skillName/,
      );
      await assert.rejects(
        deleteLocalSkill({ endpointId: "unknown-ep", skillName: "other" }, { homeDir: home, recycleDirFn: mockRecycle(calls) }),
        /unknown endpoint/,
      );
      assert.equal(calls.length, 0, "nothing recycled on refusal");
      assert.equal(existsSync(join(home, ".claude", "other")), true, "sibling dir untouched");
    } finally {
      cleanup();
    }
  });

  it("propagates recycle failures without a hard-delete fallback", async () => {
    const { dir, cleanup } = tempRoot();
    const home = join(dir, "home");
    const local = join(home, ".claude", "skills", "local-gem");
    writeSkill(local, { name: "local-gem" });
    try {
      await assert.rejects(
        deleteLocalSkill(
          { endpointId: "claude", skillName: "local-gem" },
          { homeDir: home, recycleDirFn: async () => { throw new Error("recycle bin unavailable"); } },
        ),
        /recycle bin unavailable/,
      );
      assert.equal(existsSync(join(local, "SKILL.md")), true, "dir still in place");
    } finally {
      cleanup();
    }
  });
});

describe("resolveConflictSkill", () => {
  // Diverged pair fixture: repo has skill-a, endpoint has a same-named local
  // directory with an extra file so the two content hashes differ.
  function divergedPair(dir) {
    const home = join(dir, "home");
    const repo = join(dir, "repo");
    writeSkill(join(repo, "skill-a"), { name: "skill-a" });
    const local = join(home, ".claude", "skills", "skill-a");
    cpSync(join(repo, "skill-a"), local, { recursive: true });
    writeFileSync(join(local, "changed.txt"), "diverged-local");
    return { home, repo, local };
  }

  it('direction "repo" recycles the local dir and links the repo copy in place', async () => {
    const { dir, cleanup } = tempRoot();
    const { home, repo, local } = divergedPair(dir);
    const calls = [];
    try {
      const r = await resolveConflictSkill(
        { endpointId: "claude", skillName: "skill-a", repoPath: repo, direction: "repo" },
        { homeDir: home, recycleDirFn: mockRecycle(calls) },
      );
      assert.equal(r.ok, true);
      assert.deepEqual(calls, [local], "only the local dir is recycled");
      assert.equal(lstatSync(local).isSymbolicLink(), true, "local path is now a junction");
      assert.equal(existsSync(join(local, "SKILL.md")), true, "readable through the link");
      assert.equal(existsSync(join(local, "changed.txt")), false, "content is the repo version");
      assert.equal(hashDir(local), hashDir(join(repo, "skill-a")));
    } finally {
      cleanup();
    }
  });

  it('direction "local" recycles the repo copy first, then overwrites it with local content', async () => {
    const { dir, cleanup } = tempRoot();
    const { home, repo, local } = divergedPair(dir);
    // another endpoint already has a junction into the repo copy: it must keep
    // working and serve the new content afterwards (same path, new bytes)
    const zcode = join(home, ".zcode", "skills");
    mkdirSync(zcode, { recursive: true });
    createJunction(join(zcode, "skill-a"), join(repo, "skill-a"));
    const order = [];
    const recycle = async (p) => {
      order.push(p);
      rmSync(p, { recursive: true, force: true });
    };
    try {
      const r = await resolveConflictSkill(
        { endpointId: "claude", skillName: "skill-a", repoPath: repo, direction: "local" },
        { homeDir: home, recycleDirFn: recycle },
      );
      assert.equal(r.ok, true);
      assert.deepEqual(order, [join(repo, "skill-a"), local], "repo old copy recycled before the local dir");
      assert.equal(existsSync(join(repo, "skill-a", "changed.txt")), true, "repo now holds the local version");
      assert.equal(lstatSync(local).isSymbolicLink(), true, "local path is now a junction");
      assert.equal(existsSync(join(zcode, "skill-a", "changed.txt")), true, "pre-existing junction serves new content");
    } finally {
      cleanup();
    }
  });

  it("aborts when the repo copy cannot be recycled, leaving the repo untouched", async () => {
    const { dir, cleanup } = tempRoot();
    const { home, repo, local } = divergedPair(dir);
    const failing = async () => { throw new Error("recycle bin unavailable"); };
    try {
      await assert.rejects(
        resolveConflictSkill(
          { endpointId: "claude", skillName: "skill-a", repoPath: repo, direction: "local" },
          { homeDir: home, recycleDirFn: failing },
        ),
        /recycle bin unavailable/,
      );
      assert.equal(existsSync(join(repo, "skill-a", "SKILL.md")), true, "repo copy intact");
      assert.equal(existsSync(join(repo, "skill-a", "changed.txt")), false, "no local content copied in");
      assert.equal(lstatSync(local).isSymbolicLink(), false, "local dir untouched");
    } finally {
      cleanup();
    }
  });

  it("rejects bad direction, junction local paths, and skills missing from the repo", async () => {
    const { dir, cleanup } = tempRoot();
    const { home, repo, local } = divergedPair(dir);
    const calls = [];
    const deps = { homeDir: home, recycleDirFn: mockRecycle(calls) };
    try {
      await assert.rejects(
        resolveConflictSkill({ endpointId: "claude", skillName: "skill-a", repoPath: repo, direction: " sideways " }, deps),
        /direction/,
      );
      await assert.rejects(
        resolveConflictSkill({ endpointId: "claude", skillName: "ghost", repoPath: repo, direction: "repo" }, deps),
        /不存在本地实体目录/,
      );
      // local path replaced by a junction -> refused (re-click after success)
      rmSync(local, { recursive: true, force: true });
      createJunction(local, join(repo, "skill-a"));
      await assert.rejects(
        resolveConflictSkill({ endpointId: "claude", skillName: "skill-a", repoPath: repo, direction: "repo" }, deps),
        /不存在本地实体目录/,
      );
      // repo has no such skill but the local dir exists -> refused
      writeSkill(join(home, ".claude", "skills", "local-only"), { name: "local-only" });
      await assert.rejects(
        resolveConflictSkill({ endpointId: "claude", skillName: "local-only", repoPath: repo, direction: "local" }, deps),
        /repo 中不存在/,
      );
      assert.deepEqual(calls, [], "nothing recycled on any rejection");
    } finally {
      cleanup();
    }
  });

  it("refuses a traversal skillName after the direction check, touching nothing", async () => {
    const { dir, cleanup } = tempRoot();
    const { home, repo } = divergedPair(dir);
    // the path a traversal payload would escape to: home/.claude/other
    writeSkill(join(home, ".claude", "other"), { name: "other" });
    const calls = [];
    const deps = { homeDir: home, recycleDirFn: mockRecycle(calls) };
    try {
      // direction 校验优先：direction 和 skillName 都非法时先报 direction
      await assert.rejects(
        resolveConflictSkill({ endpointId: "claude", skillName: join("..", "other"), repoPath: repo, direction: "bad" }, deps),
        /direction/,
      );
      await assert.rejects(
        resolveConflictSkill({ endpointId: "claude", skillName: join("..", "other"), repoPath: repo, direction: "repo" }, deps),
        (err) => err.statusCode === 400 && /skillName/.test(err.message),
      );
      assert.equal(calls.length, 0, "nothing recycled");
      assert.equal(existsSync(join(home, ".claude", "other", "SKILL.md")), true, "escaped-to dir untouched");
      assert.equal(existsSync(join(repo, "skill-a", "SKILL.md")), true, "repo untouched");
    } finally {
      cleanup();
    }
  });
});

describe("diffLocalSkill", () => {
  it("returns the structural diff of a diverged pair", () => {
    const { dir, cleanup } = tempRoot();
    const home = join(dir, "home");
    const repo = join(dir, "repo");
    writeSkill(join(repo, "skill-a"), { name: "skill-a" });
    const local = join(home, ".claude", "skills", "skill-a");
    cpSync(join(repo, "skill-a"), local, { recursive: true });
    writeFileSync(join(local, "changed.txt"), "diverged");
    try {
      const r = diffLocalSkill({ endpointId: "claude", skillName: "skill-a", repoPath: repo }, { homeDir: home });
      assert.equal(r.ok, true);
      assert.deepEqual(r.diffs, [{ path: "changed.txt", kind: "only-b" }]);
      assert.throws(
        () => diffLocalSkill({ endpointId: "claude", skillName: "ghost", repoPath: repo }, { homeDir: home }),
        /不存在本地实体目录/,
      );
    } finally {
      cleanup();
    }
  });

  it("refuses a traversal skillName before any lookup", () => {
    const { dir, cleanup } = tempRoot();
    const home = join(dir, "home");
    const repo = join(dir, "repo");
    writeSkill(join(repo, "skill-a"), { name: "skill-a" });
    // the path a traversal payload would escape to: home/.claude/other
    writeSkill(join(home, ".claude", "other"), { name: "other" });
    try {
      assert.throws(
        () => diffLocalSkill({ endpointId: "claude", skillName: join("..", "other"), repoPath: repo }, { homeDir: home }),
        (err) => err.statusCode === 400 && /skillName/.test(err.message),
      );
      assert.equal(existsSync(join(home, ".claude", "other", "SKILL.md")), true, "escaped-to dir untouched");
    } finally {
      cleanup();
    }
  });
});

describe("readSkillBody", () => {
  it("returns the SKILL.md content plus name/dirName/relPath for a repo skill", () => {
    const { dir, cleanup } = tempRoot();
    try {
      const repo = join(dir, "repo");
      writeSkill(join(repo, "skill-a"), { name: "skill-a" });
      writeSkill(join(repo, "skills", "skill-b"), { name: "skill-b", description: "nested" });

      const a = readSkillBody(repo, "skill-a");
      assert.equal(a.name, "skill-a");
      assert.equal(a.dirName, "skill-a");
      assert.equal(a.relPath, "skill-a");
      assert.match(a.content, /^---\nname: skill-a\n/);
      assert.ok(a.content.endsWith("body\n"));

      const b = readSkillBody(repo, join("skills", "skill-b"));
      assert.equal(b.name, "skill-b");
      assert.equal(b.dirName, "skill-b");
      assert.match(b.content, /description: nested/);
    } finally {
      cleanup();
    }
  });

  it("rejects an unknown relPath and a directory without SKILL.md", () => {
    const { dir, cleanup } = tempRoot();
    try {
      const repo = join(dir, "repo");
      writeSkill(join(repo, "skill-a"), { name: "skill-a" });
      mkdirSync(join(repo, "notes"), { recursive: true }); // exists but not a skill

      assert.throws(() => readSkillBody(repo, "ghost"), /不存在/);
      assert.throws(() => readSkillBody(repo, "notes"), /SKILL\.md/);
      for (const relPath of ["ghost", "notes"]) {
        try {
          readSkillBody(repo, relPath);
          assert.fail("should have thrown");
        } catch (err) {
          assert.equal(err.statusCode, 404, `${relPath} maps to 404`);
        }
      }
    } finally {
      cleanup();
    }
  });

  it("refuses path traversal outside the repo", () => {
    const { dir, cleanup } = tempRoot();
    try {
      const repo = join(dir, "repo");
      writeSkill(join(repo, "skill-a"), { name: "skill-a" });
      writeSkill(join(dir, "outside"), { name: "outside" });

      assert.throws(() => readSkillBody(repo, join("..", "outside")), /越出|traversal|拒绝/i);
      assert.throws(() => readSkillBody(repo, join("skill-a", "..", "..", "outside")), /越出|traversal|拒绝/i);
      assert.throws(() => readSkillBody(repo, join(dir, "outside")), /越出|traversal|拒绝/i);
      try {
        readSkillBody(repo, join("..", "outside"));
        assert.fail("should have thrown");
      } catch (err) {
        assert.equal(err.statusCode, 400, "traversal maps to 400");
      }
    } finally {
      cleanup();
    }
  });

  it("is exposed on createSkillsService and gated on a configured repo", () => {
    const { dir, cleanup } = tempRoot();
    const repo = join(dir, "repo");
    writeSkill(join(repo, "skill-a"), { name: "skill-a" });
    const base = { LOCALAPPDATA: join(dir, "local"), USERPROFILE: join(dir, "user") };
    try {
      const svc = createSkillsService({ homeDir: join(dir, "home"), base, recycleDirFn: mockRecycle([]) });
      assert.throws(() => svc.readSkillBody("skill-a"), /尚未设置主仓库/);
      svc.setRepoPath(repo);
      const r = svc.readSkillBody("skill-a");
      assert.equal(r.name, "skill-a");
      assert.match(r.content, /name: skill-a/);
      assert.throws(() => svc.readSkillBody(join("..", "x")), /越出|traversal|拒绝/i);
    } finally {
      cleanup();
    }
  });
});

describe("scanEndpoints", () => {
  it("identifies junction / local / broken entries and matches repo content", async () => {
    const { dir, cleanup } = tempRoot();
    const home = join(dir, "home");
    const repo = join(dir, "repo");
    writeSkill(join(repo, "skill-a"), { name: "skill-a" });
    writeSkill(join(repo, "skill-b"), { name: "skill-b" });
    try {
      const claude = join(home, ".claude", "skills");
      mkdirSync(claude, { recursive: true });
      // junction into the repo
      createJunction(join(claude, "skill-a"), join(repo, "skill-a"));
      // local dir matching a repo skill by dirName, identical content
      cpSync(join(repo, "skill-b"), join(claude, "skill-b"), { recursive: true });
      // local skill unknown to the repo
      writeSkill(join(claude, "local-unknown"), { name: "local-unknown" });
      // broken junction
      const gone = join(dir, "gone-target");
      mkdirSync(gone, { recursive: true });
      createJunction(join(claude, "broken-link"), gone);
      rmSync(gone, { recursive: true, force: true });
      // VCS metadata is filtered out, not reported as a local skill
      mkdirSync(join(claude, ".git", "objects"), { recursive: true });
      // another endpoint holds a diverged same-named local dir
      const zcode = join(home, ".zcode", "skills");
      mkdirSync(zcode, { recursive: true });
      cpSync(join(repo, "skill-b"), join(zcode, "skill-b"), { recursive: true });
      writeFileSync(join(zcode, "skill-b", "helper.txt"), "diverged");

      const endpoints = scanEndpoints(repo, { homeDir: home });
      const entry = endpoints.find((e) => e.id === "claude");
      assert.equal(entry.dirExists, true);
      const byName = Object.fromEntries(entry.entries.map((e) => [e.name, e]));

      assert.equal(byName["skill-a"].kind, "junction");
      assert.equal(byName["skill-a"].broken, false);
      assert.equal(byName["skill-a"].repoSkill, "skill-a");

      assert.equal(byName["skill-b"].kind, "local");
      assert.equal(byName["skill-b"].matchesRepo, true);

      const zcodeEntry = endpoints.find((e) => e.id === "zcode");
      assert.equal(zcodeEntry.entries.find((e) => e.name === "skill-b").matchesRepo, false);

      assert.equal(byName["local-unknown"].matchesRepo, null);

      assert.equal(byName["broken-link"].kind, "junction");
      assert.equal(byName["broken-link"].broken, true);
      assert.equal(byName["broken-link"].repoSkill, null);

      assert.equal(byName[".git"], undefined, "dot entries are filtered out");

      // endpoints without a skills dir report dirExists:false, no entries
      const kimi = endpoints.find((e) => e.id === "kimi");
      assert.equal(kimi.dirExists, false);
      assert.deepEqual(kimi.entries, []);
      // agy reads ~/.gemini/skills (junction-compatible, verified live)
      const agy = endpoints.find((e) => e.id === "agy");
      assert.equal(agy.enabled, true);
      assert.equal(agy.dirExists, false);
    } finally {
      cleanup();
    }
  });
});

describe("skills config persistence", () => {
  it("round-trips { repoPath } through skills.json and survives a corrupt file", () => {
    const { dir, cleanup } = tempRoot();
    try {
      const base = { LOCALAPPDATA: dir, USERPROFILE: join(dir, "user") };
      assert.deepEqual(loadSkillsConfig({ base }), { repoPath: null });
      saveSkillsConfig({ repoPath: "C:\\somewhere\\skills" }, { base });
      assert.deepEqual(loadSkillsConfig({ base }), { repoPath: "C:\\somewhere\\skills" });
      writeFileSync(join(dir, "Anyswitch", "skills.json"), "not json{{{");
      assert.deepEqual(loadSkillsConfig({ base }), { repoPath: null });
    } finally {
      cleanup();
    }
  });
});

describe("createSkillsService", () => {
  it("gates operations on a configured repo and drives deploy through the service", async () => {
    const { dir, cleanup } = tempRoot();
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    const repo = join(dir, "repo");
    writeSkill(join(repo, "skill-a"), { name: "skill-a" });
    const base = { LOCALAPPDATA: join(dir, "local"), USERPROFILE: join(dir, "user") };
    try {
      const svc = createSkillsService({
        homeDir: home,
        base,
        recycleDirFn: mockRecycle([]),
      });

      // unconfigured: state reports it and mutations are refused
      let state = svc.getState();
      assert.equal(state.repoConfigured, false);
      assert.equal(state.repoValid, false);
      assert.deepEqual(state.skills, []);
      assert.equal(state.endpoints.length, 8);
      assert.throws(() => svc.setRepoPath(join(dir, "ghost")), /不存在/);
      assert.throws(() => svc.setRepoPath(home), /没有找到任何 skill/);
      await assert.rejects(svc.deploy({ endpointId: "kimi", skillName: "skill-a" }), /尚未设置主仓库/);

      // configure, then deploy through the service
      const set = svc.setRepoPath(repo);
      assert.equal(set.skillCount, 1);
      const r = await svc.deploy({ endpointId: "kimi", skillName: "skill-a" });
      assert.equal(r.ok, true);
      state = svc.getState();
      assert.equal(state.repoValid, true);
      const kimi = state.endpoints.find((e) => e.id === "kimi");
      assert.equal(kimi.dirExists, true, "endpoint dir auto-created by deploy");
      assert.equal(kimi.entries[0].kind, "junction");
      assert.equal(kimi.entries[0].repoSkill, "skill-a");

      await svc.undeploy({ endpointId: "kimi", skillName: "skill-a" });
      state = svc.getState();
      assert.equal(state.endpoints.find((e) => e.id === "kimi").entries.length, 0);
    } finally {
      cleanup();
    }
  });
});

describe("createSkillsService.importPickedSkill", () => {
  it("gates on a configured repo, imports a valid pick, refuses non-skills", async () => {
    const { dir, cleanup } = tempRoot();
    try {
      const repo = join(dir, "repo");
      writeSkill(join(repo, "skill-a"), { name: "skill-a" });
      const external = join(dir, "picked-skill");
      writeSkill(external, { name: "picked-skill" });
      const { base, csc64 } = pickerFixture(dir);
      const svc = createSkillsService({
        homeDir: join(dir, "home"),
        base,
        spawnFn: fakeSpawn(pickerHandler(csc64, `PICKED:${external}\r\n`)).spawnFn,
        recycleDirFn: mockRecycle([]),
      });

      // Repo must be configured before the dialog is ever opened.
      await assert.rejects(svc.importPickedSkill(), /尚未设置主仓库/);
      svc.setRepoPath(repo);

      const r = await svc.importPickedSkill();
      assert.equal(r.cancelled, false);
      assert.equal(r.skill.dirName, "picked-skill");
      assert.ok(existsSync(join(repo, "picked-skill", "SKILL.md")), "copied into the repo");

      // A picked directory without SKILL.md is refused, nothing copied.
      const bare = join(dir, "not-a-skill");
      mkdirSync(bare, { recursive: true });
      const svc2 = createSkillsService({
        homeDir: join(dir, "home"),
        base,
        spawnFn: fakeSpawn(pickerHandler(csc64, `PICKED:${bare}\r\n`)).spawnFn,
        recycleDirFn: mockRecycle([]),
      });
      await assert.rejects(svc2.importPickedSkill(), /SKILL\.md/);
      assert.equal(existsSync(join(repo, "not-a-skill")), false);
    } finally {
      cleanup();
    }
  });

  it("returns { cancelled: true } without touching the repo when the dialog is dismissed", async () => {
    const { dir, cleanup } = tempRoot();
    try {
      const repo = join(dir, "repo");
      writeSkill(join(repo, "skill-a"), { name: "skill-a" });
      const { base, csc64 } = pickerFixture(dir);
      const svc = createSkillsService({
        homeDir: join(dir, "home"),
        base,
        spawnFn: fakeSpawn(pickerHandler(csc64, "CANCELLED\r\n")).spawnFn,
        recycleDirFn: mockRecycle([]),
      });
      svc.setRepoPath(repo);
      assert.deepEqual(await svc.importPickedSkill(), { cancelled: true });
      assert.equal(scanRepo(repo).length, 1, "repo unchanged");
    } finally {
      cleanup();
    }
  });

  it("imports a .zip picked via importPickedZip as a folder, refuses non-zip picks", async () => {
    const { dir, cleanup } = tempRoot();
    try {
      const repo = join(dir, "repo");
      writeSkill(join(repo, "skill-a"), { name: "skill-a" });
      const { base, csc64 } = pickerFixture(dir);

      // The file dialog returns a .zip path → imported, stored as a folder.
      const src = join(dir, "zip-src");
      writeSkill(src, { name: "zip-via-picker" });
      const zipPath = join(dir, "zip-src.zip");
      const zr = spawnSync(tarPath, ["-a", "-c", "-f", zipPath, basename(src)], { cwd: dir });
      if (zr.status !== 0) throw new Error(`zip fixture failed: ${zr.stderr}`);
      const calls = [];
      const spawnFn = (file, args, opts) => {
        calls.push({ file, args });
        return fakeSpawn(pickerHandler(csc64, /folder-picker\.exe$/.test(file) ? `PICKED:${zipPath}\r\n` : "")).spawnFn(file, args, opts);
      };
      const svc = createSkillsService({
        homeDir: join(dir, "home"),
        base,
        spawnFn,
        recycleDirFn: mockRecycle([]),
      });
      svc.setRepoPath(repo);
      const r = await svc.importPickedZip();
      assert.equal(r.cancelled, false);
      assert.equal(r.skill.name, "zip-via-picker");
      assert.equal(existsSync(join(repo, "zip-src", "SKILL.md")), true, "stored as a folder");
      // The file dialog must run in --file mode.
      const exeCalls = calls.filter((c) => /folder-picker\.exe$/.test(c.file));
      assert.equal(exeCalls.length, 1);
      assert.deepEqual(exeCalls[0].args, ["--file", "选择要导入的 skill .zip 压缩包"]);

      // A picked non-zip file is refused before any extraction.
      const txtPath = join(dir, "plain.txt");
      writeFileSync(txtPath, "x");
      const svc2 = createSkillsService({
        homeDir: join(dir, "home"),
        base,
        spawnFn: fakeSpawn(pickerHandler(csc64, `PICKED:${txtPath}\r\n`)).spawnFn,
        recycleDirFn: mockRecycle([]),
      });
      svc2.setRepoPath(repo);
      await assert.rejects(svc2.importPickedZip(), /只支持 \.zip/);
      // Cancelling the file dialog is silent.
      const svc3 = createSkillsService({
        homeDir: join(dir, "home"),
        base,
        spawnFn: fakeSpawn(pickerHandler(csc64, "CANCELLED\r\n")).spawnFn,
        recycleDirFn: mockRecycle([]),
      });
      svc3.setRepoPath(repo);
      assert.deepEqual(await svc3.importPickedZip(), { cancelled: true });
    } finally {
      cleanup();
    }
  });
});

describe("endpoint registry", () => {
  it("maps all eight endpoints under the given home", () => {
    const endpoints = listEndpoints("C:\\fakehome");
    const byId = Object.fromEntries(endpoints.map((e) => [e.id, e]));
    assert.equal(byId.claude.skillsDir, join("C:\\fakehome", ".claude", "skills"));
    assert.equal(byId.zcode.skillsDir, join("C:\\fakehome", ".zcode", "skills"));
    assert.equal(byId.opencode.skillsDir, join("C:\\fakehome", ".config", "opencode", "skills"));
    assert.equal(byId.pi.skillsDir, join("C:\\fakehome", ".pi", "agent", "skills"));
    assert.equal(byId.kimi.skillsDir, join("C:\\fakehome", ".kimi-code", "skills"));
    assert.equal(byId.dsh.skillsDir, join("C:\\fakehome", ".dsh", "skills"));
    assert.equal(byId.agy.skillsDir, join("C:\\fakehome", ".gemini", "skills"));
    assert.equal(byId.reasonix.skillsDir, join("C:\\fakehome", ".reasonix", "skills"));
    for (const id of ["claude", "zcode", "opencode", "pi", "kimi", "dsh", "agy", "reasonix"]) {
      assert.equal(byId[id].enabled, true, `${id} enabled`);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// pickFolder: pre-compiled helper exe with PowerShell fallback
// ─────────────────────────────────────────────────────────────

// Minimal ChildProcess stub driven by a handler(file, args) script:
// { stdout, stderr, code } to close with, or { error } to fail the spawn.
function fakeSpawn(handler) {
  const calls = [];
  const spawnFn = (file, args, opts) => {
    calls.push({ file, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    const r = handler(file, args) ?? { code: 0 };
    setImmediate(() => {
      if (r.error) {
        child.emit("error", r.error);
        return;
      }
      if (r.stdout) child.stdout.emit("data", Buffer.from(r.stdout, "utf8"));
      if (r.stderr) child.stderr.emit("data", Buffer.from(r.stderr, "utf8"));
      child.emit("close", r.code ?? 0);
    });
    return child;
  };
  return { spawnFn, calls };
}

// A base env whose WINDIR contains a fake Framework64 csc.exe (only its
// existence is probed; the spawnFn stub stands in for running it).
function pickerFixture(dir) {
  const windir = join(dir, "win");
  const cscDir = join(windir, "Microsoft.NET", "Framework64", "v4.0.30319");
  mkdirSync(cscDir, { recursive: true });
  const csc64 = join(cscDir, "csc.exe");
  writeFileSync(csc64, "fake");
  return { base: { LOCALAPPDATA: join(dir, "local"), WINDIR: windir }, csc64 };
}

// Handler: csc "compiles" by writing the /out: exe; the helper exe replies
// with the given stdout.
function pickerHandler(csc64, helperStdout) {
  return (file, args) => {
    if (file === csc64) {
      const out = args.find((a) => a.startsWith("/out:")).slice("/out:".length);
      writeFileSync(out, "MZ");
      return { code: 0 };
    }
    return { stdout: helperStdout, code: 0 };
  };
}

describe("pickFolder", () => {
  it("compiles the helper on first use, then cache-hits and spawns only the exe", async () => {
    const { dir, cleanup } = tempRoot();
    try {
      const { base, csc64 } = pickerFixture(dir);
      const handler = pickerHandler(csc64, "PICKED:D:\\skills\r\n");

      const first = fakeSpawn(handler);
      const r1 = await pickFolder({ spawnFn: first.spawnFn, base });
      assert.deepEqual(r1, { cancelled: false, path: "D:\\skills" });
      assert.equal(first.calls.length, 2, "first run: csc compile + helper run");
      assert.equal(first.calls[0].file, csc64, "Framework64 csc probed first");
      assert.ok(first.calls[0].args.includes("/target:winexe"));
      const exePath = first.calls[1].file;
      assert.match(exePath, /folder-picker\.exe$/);

      const second = fakeSpawn(handler);
      const r2 = await pickFolder({ spawnFn: second.spawnFn, base });
      assert.deepEqual(r2, { cancelled: false, path: "D:\\skills" });
      assert.equal(second.calls.length, 1, "cache hit spawns only the helper exe");
      assert.equal(second.calls[0].file, exePath);
    } finally {
      cleanup();
    }
  });

  it("recompiles when the cached source is stale", async () => {
    const { dir, cleanup } = tempRoot();
    try {
      const { base, csc64 } = pickerFixture(dir);
      const first = fakeSpawn(pickerHandler(csc64, "CANCELLED\r\n"));
      await pickFolder({ spawnFn: first.spawnFn, base });
      assert.equal(first.calls.length, 2);

      // corrupt the cached source → next run must recompile
      const srcPath = join(base.LOCALAPPDATA, "Anyswitch", "bin", "folder-picker.cs");
      writeFileSync(srcPath, "// stale");
      const second = fakeSpawn(pickerHandler(csc64, "CANCELLED\r\n"));
      await pickFolder({ spawnFn: second.spawnFn, base });
      assert.equal(second.calls.length, 2, "stale source triggers a recompile");
      assert.equal(second.calls[0].file, csc64);
    } finally {
      cleanup();
    }
  });

  it("parses CANCELLED and treats protocol-less output as cancelled", async () => {
    const { dir, cleanup } = tempRoot();
    try {
      const { base, csc64 } = pickerFixture(dir);
      const cancelled = fakeSpawn(pickerHandler(csc64, "some noise\r\nCANCELLED\r\n"));
      assert.deepEqual(await pickFolder({ spawnFn: cancelled.spawnFn, base }), { cancelled: true });

      const garbage = fakeSpawn(pickerHandler(csc64, "unexpected output\r\n"));
      // Cache is warm from the previous call, so only the helper spawns;
      // output without a protocol line must map to cancelled.
      assert.deepEqual(await pickFolder({ spawnFn: garbage.spawnFn, base }), { cancelled: true });
      assert.equal(garbage.calls.length, 1);
    } finally {
      cleanup();
    }
  });

  it("falls back to powershell -STA when helper compilation fails", async () => {
    const { dir, cleanup } = tempRoot();
    try {
      const { base, csc64 } = pickerFixture(dir);
      const { spawnFn, calls } = fakeSpawn((file) => {
        if (file === csc64) return { code: 1, stderr: "error CS0000: boom" };
        if (file === "powershell.exe") return { stdout: "PICKED:E:\\repo\r\n", code: 0 };
        return { code: 0 };
      });
      const r = await pickFolder({ spawnFn, base });
      assert.deepEqual(r, { cancelled: false, path: "E:\\repo" });
      assert.equal(calls.filter((c) => c.file === csc64).length, 1);
      assert.ok(!calls.some((c) => /folder-picker\.exe$/.test(c.file)), "helper never ran");
      const ps = calls.find((c) => c.file === "powershell.exe");
      assert.ok(ps, "fell back to powershell");
      assert.ok(ps.args.includes("-STA"));
    } finally {
      cleanup();
    }
  });

  it("falls back to powershell -STA when no csc.exe exists", async () => {
    const { dir, cleanup } = tempRoot();
    try {
      // WINDIR without any Microsoft.NET compilers
      const base = { LOCALAPPDATA: join(dir, "local"), WINDIR: join(dir, "nowin") };
      const { spawnFn, calls } = fakeSpawn((file) =>
        file === "powershell.exe" ? { stdout: "CANCELLED\r\n", code: 0 } : { code: 0 },
      );
      const r = await pickFolder({ spawnFn, base });
      assert.deepEqual(r, { cancelled: true });
      const ps = calls.find((c) => c.file === "powershell.exe");
      assert.ok(ps, "fell back to powershell");
      assert.ok(ps.args.includes("-STA"));
    } finally {
      cleanup();
    }
  });

  it("falls back to powershell -STA when the helper exe fails to spawn", async () => {
    const { dir, cleanup } = tempRoot();
    try {
      const { base, csc64 } = pickerFixture(dir);
      const { spawnFn, calls } = fakeSpawn((file, args) => {
        if (file === csc64) {
          const out = args.find((a) => a.startsWith("/out:")).slice("/out:".length);
          writeFileSync(out, "MZ");
          return { code: 0 };
        }
        if (/folder-picker\.exe$/.test(file)) return { error: new Error("spawn ENOENT") };
        if (file === "powershell.exe") return { stdout: "CANCELLED\r\n", code: 0 };
        return { code: 0 };
      });
      const r = await pickFolder({ spawnFn, base });
      assert.deepEqual(r, { cancelled: true });
      const ps = calls.find((c) => c.file === "powershell.exe");
      assert.ok(ps, "fell back to powershell");
      assert.ok(ps.args.includes("-STA"));
    } finally {
      cleanup();
    }
  });

  it("passes the dialog title to the helper exe and the powershell fallback", async () => {
    const { dir, cleanup } = tempRoot();
    try {
      // Fast path: the title is argv[0] of the helper exe.
      const { base, csc64 } = pickerFixture(dir);
      const first = fakeSpawn(pickerHandler(csc64, "CANCELLED\r\n"));
      await pickFolder({ spawnFn: first.spawnFn, base, title: "选择要导入的 skill 目录（需包含 SKILL.md）" });
      const exeCall = first.calls.find((c) => /folder-picker\.exe$/.test(c.file));
      assert.deepEqual(exeCall.args, ["选择要导入的 skill 目录（需包含 SKILL.md）"]);

      // PowerShell chain: the title lands in both dialog calls, quote-escaped.
      const fallbackBase = { LOCALAPPDATA: join(dir, "local2"), WINDIR: join(dir, "nowin") };
      const second = fakeSpawn((file) =>
        file === "powershell.exe" ? { stdout: "CANCELLED\r\n", code: 0 } : { code: 0 });
      await pickFolder({ spawnFn: second.spawnFn, base: fallbackBase, title: "it's a title" });
      const ps = second.calls.find((c) => c.file === "powershell.exe");
      const script = ps.args[ps.args.indexOf("-Command") + 1];
      assert.ok(script.includes("Pick('it''s a title', $true)"), "C# chain title embedded and escaped");
      assert.ok(script.includes("$fbd.Description = 'it''s a title'"), "WinForms fallback title embedded");
    } finally {
      cleanup();
    }
  });

  it("pickFile runs the helper in --file mode and its powershell fallback uses OpenFileDialog", async () => {
    const { dir, cleanup } = tempRoot();
    try {
      const { base, csc64 } = pickerFixture(dir);
      const first = fakeSpawn(pickerHandler(csc64, "PICKED:D:\\tool\\skill.zip\r\n"));
      const r = await pickFile({ spawnFn: first.spawnFn, base, title: "选择要导入的 skill .zip 压缩包" });
      assert.deepEqual(r, { cancelled: false, path: "D:\\tool\\skill.zip" });
      const exeCall = first.calls.find((c) => /folder-picker\.exe$/.test(c.file));
      assert.deepEqual(exeCall.args, ["--file", "选择要导入的 skill .zip 压缩包"]);

      // PowerShell fallback: C# Pick(title, $false) + OpenFileDialog, no FolderBrowserDialog.
      const fallbackBase = { LOCALAPPDATA: join(dir, "local2"), WINDIR: join(dir, "nowin") };
      const second = fakeSpawn((file) =>
        file === "powershell.exe" ? { stdout: "CANCELLED\r\n", code: 0 } : { code: 0 });
      await pickFile({ spawnFn: second.spawnFn, base: fallbackBase, title: "选择要导入的 skill .zip 压缩包" });
      const ps = second.calls.find((c) => c.file === "powershell.exe");
      const script = ps.args[ps.args.indexOf("-Command") + 1];
      assert.ok(script.includes("Pick('选择要导入的 skill .zip 压缩包', $false)"));
      assert.ok(script.includes("OpenFileDialog"));
      assert.ok(!script.includes("FolderBrowserDialog"));
    } finally {
      cleanup();
    }
  });
});

describe("ensureFolderPickerHelper", () => {
  it("throws when no csc.exe can be found", async () => {
    const { dir, cleanup } = tempRoot();
    try {
      const base = { LOCALAPPDATA: join(dir, "local"), WINDIR: join(dir, "nowin") };
      await assert.rejects(ensureFolderPickerHelper({ spawnFn: fakeSpawn(() => ({ code: 0 })).spawnFn, base }), /csc\.exe not found/);
    } finally {
      cleanup();
    }
  });

  it("throws when csc exits non-zero without producing the exe", async () => {
    const { dir, cleanup } = tempRoot();
    try {
      const { base } = pickerFixture(dir);
      const { spawnFn } = fakeSpawn(() => ({ code: 1, stderr: "error CS0000" }));
      await assert.rejects(ensureFolderPickerHelper({ spawnFn, base }), /CS0000/);
    } finally {
      cleanup();
    }
  });
});
