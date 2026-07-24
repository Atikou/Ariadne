import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitStatusSnapshot {
  branch: string;
  dirty: boolean;
  porcelain: string;
  signature: string;
}

/** 轮询 git 状态，仅在签名变化时回调。 */
export class GitStatusHub {
  private timer?: NodeJS.Timeout;
  private lastSignature = "";

  start(
    workspaceRoot: string,
    intervalMs: number,
    onChange: (snap: GitStatusSnapshot) => void,
  ): void {
    this.stop();
    const poll = () => {
      void readGitStatus(workspaceRoot)
        .then((snap) => {
          if (snap.signature === this.lastSignature) return;
          this.lastSignature = snap.signature;
          onChange(snap);
        })
        .catch(() => {
          /* 非 git 仓库时静默 */
        });
    };
    poll();
    this.timer = setInterval(poll, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.lastSignature = "";
  }
}

export async function readGitStatus(workspaceRoot: string): Promise<GitStatusSnapshot> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", workspaceRoot, "status", "--porcelain", "-b"],
    { windowsHide: true, timeout: 15_000 },
  );
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  let branch = "HEAD";
  const body: string[] = [];
  for (const line of lines) {
    if (line.startsWith("## ")) {
      branch = line.slice(3).split("...")[0]?.trim() ?? branch;
    } else {
      body.push(line);
    }
  }
  const porcelain = body.join("\n");
  const dirty = porcelain.length > 0;
  return {
    branch,
    dirty,
    porcelain,
    signature: `${branch}|${dirty}|${porcelain}`,
  };
}
