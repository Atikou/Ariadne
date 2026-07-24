import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const UV_VERSION = "0.11.28";
const PYTHON_VERSION = "3.12";
const REQUIREMENTS = [
  "torch==2.13.0",
  "transformers==4.57.6",
  "safetensors==0.8.0",
  "accelerate==1.14.0",
];
const ARTIFACTS = {
  "win32-x64": ["uv-x86_64-pc-windows-msvc.zip", "0a23463216d09c6a72ff80ef5dc5a795f07dc1575cb84d24596c2f124a441b7b"],
  "win32-arm64": ["uv-aarch64-pc-windows-msvc.zip", "3248109afad3ec59baad299d324ff53de17e2d9a3b3e21580ffd26744b11e036"],
  "linux-x64": ["uv-x86_64-unknown-linux-gnu.tar.gz", "e490a6464492183c5d4534a5527fb4440f7f2bb2f228162ad7e4afe076dc0224"],
  "linux-arm64": ["uv-aarch64-unknown-linux-gnu.tar.gz", "03e9fe0a81b0718d0bc84625de3885df6cc3f89a8b6af6121d6b9f6113fb6533"],
  "darwin-x64": ["uv-x86_64-apple-darwin.tar.gz", "2ad79983127ffca7d77b77ce6a24278d7e4f7b817a1acf72fea5f8124b4aac5e"],
  "darwin-arm64": ["uv-aarch64-apple-darwin.tar.gz", "33540eb7c883ab857eff79bd5ac2aa31fe27b595abecb4a9c003a2c998447232"],
};

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = path.join(packageRoot, ".runtime");
const environmentPath = path.join(runtimeRoot, "transformers");
const markerPath = path.join(environmentPath, ".ariadne-runtime.json");
const marker = JSON.stringify({ python: PYTHON_VERSION, requirements: REQUIREMENTS }, null, 2);

if (process.env.ARIADNE_SKIP_TRANSFORMERS_SETUP === "1") {
  console.log("model-runtime: skipped by ARIADNE_SKIP_TRANSFORMERS_SETUP=1");
  process.exit(0);
}

if (isReady()) {
  console.log("model-runtime: Transformers environment is ready");
  process.exit(0);
}

mkdirSync(runtimeRoot, { recursive: true });
const uvPath = await ensureUv();
const uvEnvironment = {
  ...process.env,
  UV_CACHE_DIR: path.join(runtimeRoot, "cache"),
  UV_PYTHON_INSTALL_DIR: path.join(runtimeRoot, "python"),
  UV_PYTHON_PREFERENCE: "only-managed",
  UV_PYTHON_NO_REGISTRY: "1",
};

rmSync(environmentPath, { recursive: true, force: true });
run(uvPath, ["venv", environmentPath, "--python", PYTHON_VERSION, "--python-preference", "only-managed"], uvEnvironment);
const pythonPath = venvPython();
run(uvPath, ["pip", "install", "--python", pythonPath, ...REQUIREMENTS], uvEnvironment);
verify(pythonPath);
writeFileSync(markerPath, `${marker}\n`, "utf8");
console.log(`model-runtime: installed Transformers runtime in ${environmentPath}`);

function isReady() {
  if (!existsSync(markerPath) || readFileSync(markerPath, "utf8").trim() !== marker.trim()) return false;
  const pythonPath = venvPython();
  if (!existsSync(pythonPath)) return false;
  const result = spawnSync(
    pythonPath,
    ["-c", "import torch, transformers, safetensors, accelerate"],
    { stdio: "ignore", windowsHide: true },
  );
  return result.status === 0;
}

function venvPython() {
  return process.platform === "win32"
    ? path.join(environmentPath, "Scripts", "python.exe")
    : path.join(environmentPath, "bin", "python");
}

async function ensureUv() {
  const executableName = process.platform === "win32" ? "uv.exe" : "uv";
  const target = path.join(runtimeRoot, "tools", executableName);
  if (existsSync(target)) return target;

  const artifact = ARTIFACTS[`${process.platform}-${process.arch}`];
  if (!artifact) throw new Error(`不支持自动安装 Transformers 运行时的平台：${process.platform}/${process.arch}`);
  const [filename, expectedHash] = artifact;
  const downloadDir = path.join(runtimeRoot, "downloads");
  const extractDir = path.join(downloadDir, `uv-${UV_VERSION}`);
  const archivePath = path.join(downloadDir, filename);
  mkdirSync(downloadDir, { recursive: true });
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });

  const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${filename}`;
  console.log(`model-runtime: downloading verified uv ${UV_VERSION} (${process.platform}/${process.arch})`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`uv 下载失败：HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== expectedHash) {
    throw new Error(`uv 校验失败：expected=${expectedHash}, actual=${actualHash}`);
  }
  writeFileSync(archivePath, bytes);
  run("tar", ["-xf", archivePath, "-C", extractDir], process.env);

  const extracted = readdirSync(extractDir, { recursive: true })
    .map((entry) => path.join(extractDir, String(entry)))
    .find((entry) => path.basename(entry) === executableName);
  if (!extracted) throw new Error(`uv 压缩包中缺少 ${executableName}`);
  mkdirSync(path.dirname(target), { recursive: true });
  renameSync(extracted, target);
  if (process.platform !== "win32") chmodSync(target, 0o755);
  rmSync(archivePath, { force: true });
  rmSync(extractDir, { recursive: true, force: true });
  return target;
}

function verify(pythonPath) {
  run(
    pythonPath,
    ["-c", "import torch, transformers, safetensors, accelerate; print('model-runtime: python packages verified')"],
    process.env,
  );
}

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} 失败（exit=${String(result.status)}）`);
  }
}
