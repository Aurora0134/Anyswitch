// 只读的 git 身份查询：先行轨道与「本地安装 vs 官方发布」一致性判定共用。
// 两条腿都是轻量只读——rev-parse 只碰本地仓库（镜像安装可能没有 .git，如实返回
// null，调用方按无身份降级）；ls-remote 不需要本地仓库，一次往返同时拿默认分支
// HEAD 与全部 v-tag 的提交 SHA，检查更新因此不占 GitHub API 限额、也不要求先 fetch。
import { execFile } from "node:child_process";
import { join } from "node:path";

const GIT_QUERY_TIMEOUT_MS = 20_000;

// 与 app-self-update.mjs 同一条 PATH 候选链：快捷方式拉起的进程 PATH 可能很窄。
function runGitOnce({ file, args, cwd = null, spawnFn, timeoutMs = GIT_QUERY_TIMEOUT_MS }) {
  return new Promise((done) => {
    spawnFn(file, args, { ...(cwd ? { cwd } : {}), timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
      done({
        ok: !error,
        missing: error?.code === "ENOENT",
        // merge-base --is-ancestor 以退出码作答（0＝是祖先、1＝不是、其余判不了），
        // 调用方需要区分「否」与「判不了」。
        exitCode: error ? (typeof error.code === "number" ? error.code : null) : 0,
        output: String(stdout ?? ""),
      });
    });
  });
}

async function runGit({ args, cwd, spawnFn, env, timeoutMs = GIT_QUERY_TIMEOUT_MS }) {
  const candidates = ["git", join(env.ProgramFiles ?? "C:\\Program Files", "Git", "cmd", "git.exe")];
  let last = { ok: false, missing: true, output: "" };
  for (const candidate of candidates) {
    const result = await runGitOnce({ file: candidate, args, cwd, spawnFn, timeoutMs });
    if (!result.missing) return result;
    last = result;
  }
  return last;
}

const SHA = /^[0-9a-f]{40}$/i;

// 本地 HEAD 身份。返回 { sha, short }（short 固定 7 位，与版本号后缀呈现同宽）；
// 无 .git、git 不可用或仓库空（无提交）都返回 null——调用方据此跳过身份维度。
export async function readLocalHead({ appDir, spawnFn = execFile, env = process.env }) {
  if (typeof appDir !== "string" || !appDir) return null;
  const r = await runGit({ args: ["rev-parse", "HEAD"], cwd: appDir, spawnFn, env });
  if (!r.ok) return null;
  const sha = r.output.split(/\r?\n/)[0]?.trim() ?? "";
  return SHA.test(sha) ? { sha, short: sha.slice(0, 7) } : null;
}

// 远端身份：默认分支 HEAD 与 v-tag → 提交 SHA 的映射。附注 tag 会有两行——tag
// 对象自身与 peeled 的 ^{} 行；peeled 行指向提交本体，优先采信，plain 行只在没有
// peeled 行时兜底（轻量 tag 只有 plain 行，其值本来就是提交 SHA）。
// 主干按 HEAD 问，不按分支名问：默认分支叫什么由上游决定，写死任何一个名字都会
// 在上游改名或换默认分支时静默查空。
// HEAD 缺失（远端空仓）或 ls-remote 失败/超时都返回 null。
export async function readRemoteRefs({ repoUrl, spawnFn = execFile, env = process.env }) {
  if (typeof repoUrl !== "string" || !repoUrl) return null;
  const r = await runGit({ args: ["ls-remote", repoUrl, "HEAD", "refs/tags/v*"], spawnFn, env });
  if (!r.ok) return null;
  let headSha = null;
  const tags = new Map();
  for (const rawLine of r.output.split(/\r?\n/)) {
    const match = /^([0-9a-f]{40})\t(\S+)$/.exec(rawLine.trim());
    if (!match) continue;
    const [, sha, ref] = match;
    if (ref === "HEAD") {
      headSha = sha;
    } else if (ref.startsWith("refs/tags/v")) {
      const name = ref.slice("refs/tags/".length);
      if (name.endsWith("^{}")) tags.set(name.slice(0, -3), sha);
      else if (!tags.has(name)) tags.set(name, sha);
    }
  }
  return headSha ? { headSha, tags } : null;
}

// 远端尖端提交与本地 HEAD 的关系（先行轨防倒退判定用）。只在远端尖端对象已在本仓时
// 判祖先后系；cat-file 缺席或 merge-base 异常都不强行下结论，交给调用方保持既有行为。
// 浅克隆边界之上的提交对象根本不在本仓，cat-file 这一道就把它们挡在 merge-base 之外，
// 所以不会踩「边界之外的历史 is-ancestor 恒 NO」的坑。返回：
//   "remote_older" —— 远端尖端是本地 HEAD 的祖先（本地不落后，更新邀请实为倒退）
//   "remote_newer" —— 本地 HEAD 是远端尖端的祖先（纯前进，换装安全）
//   "diverged"     —— 互不为祖先（换装会丢本地独有提交）
//   "absent"       —— 远端尖端对象不在本仓（标准安装常态：远端在新提交上前进）
//   null           —— git 不可用/超时等判不了的场合
export async function readRemoteHeadRelation({ appDir, remoteSha, spawnFn = execFile, env = process.env }) {
  if (typeof appDir !== "string" || !appDir) return null;
  if (typeof remoteSha !== "string" || !SHA.test(remoteSha)) return null;
  const present = await runGit({ args: ["cat-file", "-e", `${remoteSha}^{commit}`], cwd: appDir, spawnFn, env });
  if (!present.ok) return "absent";
  const remoteIsAncestor = await runGit({ args: ["merge-base", "--is-ancestor", remoteSha, "HEAD"], cwd: appDir, spawnFn, env });
  if (remoteIsAncestor.ok) return "remote_older";
  if (remoteIsAncestor.exitCode !== 1) return null;
  const localIsAncestor = await runGit({ args: ["merge-base", "--is-ancestor", "HEAD", remoteSha], cwd: appDir, spawnFn, env });
  if (localIsAncestor.ok) return "remote_newer";
  if (localIsAncestor.exitCode !== 1) return null;
  return "diverged";
}
