/**
 * PrivateRepo.ts — one gate for "may private material be posted to this GitHub repo?"
 *
 * The work-config loader (hooks/lib/work-config.ts) is the system's privacy
 * attestation for the work repo: it answers with a repo only after `gh` has
 * confirmed the repo private. This helper reuses that answer when the target IS
 * the work repo, and for any other target runs the same `gh repo view` check the
 * loader runs. Anything short of a confirmed PRIVATE repo (public, internal,
 * unreadable, gh missing, malformed name) is refused. There is no cache and no
 * override: a caller that gets `ok: false` does not post.
 */
import { loadWorkConfig } from "../../../hooks/lib/work-config";

export type RepoPrivacy =
  | { ok: true; repo: string; via: "work-config" | "gh" }
  | { ok: false; repo: string; reason: string };

export interface GhViewResult { exitCode: number; stdout: string; stderr: string }

export interface PrivateRepoDeps {
  workRepo: () => string | null;
  ghRepoView: (repo: string) => GhViewResult;
}

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const GH_TIMEOUT_MS = 20_000;

const liveDeps: PrivateRepoDeps = {
  workRepo: () => loadWorkConfig().repo,
  ghRepoView: (repo) => {
    const p = Bun.spawnSync(["gh", "repo", "view", repo, "--json", "visibility,isPrivate"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: GH_TIMEOUT_MS,
    });
    return { exitCode: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
  },
};

export function verifyPrivateRepo(repo: string, deps: PrivateRepoDeps = liveDeps): RepoPrivacy {
  if (!REPO_RE.test(repo)) return { ok: false, repo, reason: `malformed repo name "${repo}" (want owner/name)` };
  let workRepo: string | null;
  try {
    workRepo = deps.workRepo();
  } catch {
    workRepo = null; // a broken loader only loses the shortcut; the gh check below still decides
  }
  if (workRepo !== null && workRepo.toLowerCase() === repo.toLowerCase()) return { ok: true, repo, via: "work-config" };

  let view: GhViewResult;
  try {
    view = deps.ghRepoView(repo);
  } catch (err) {
    return { ok: false, repo, reason: `gh repo view failed to run: ${String(err).slice(0, 160)}` };
  }
  if (view.exitCode !== 0) return { ok: false, repo, reason: `gh repo view exit ${view.exitCode}: ${view.stderr.trim().slice(0, 160)}` };
  let data: unknown;
  try {
    data = JSON.parse(view.stdout);
  } catch {
    return { ok: false, repo, reason: "gh repo view returned non-JSON" };
  }
  const rec = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  if (rec.isPrivate === true && rec.visibility === "PRIVATE") return { ok: true, repo, via: "gh" };
  return { ok: false, repo, reason: `repo is not private (visibility=${String(rec.visibility ?? "unknown")}, isPrivate=${String(rec.isPrivate ?? "unknown")})` };
}
