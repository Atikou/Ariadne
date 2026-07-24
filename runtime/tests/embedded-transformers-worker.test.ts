import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('项目内 Transformers Worker', () => {
  it('使用 Ariadne 自带的离线 JSONL Worker，不依赖外部模型服务', async () => {
    const workerPath = join(process.cwd(), 'scripts', 'model-runtime', 'transformers_worker.py');
    const worker = await readFile(workerPath, 'utf8');

    expect(worker).toContain('local_files_only=True');
    expect(worker).toContain('trust_remote_code=False');
    expect(worker).toContain('use_safetensors=True');
    expect(worker).toContain('for raw in sys.stdin:');
    expect(worker).toContain('json.loads(raw)');
    expect(worker).not.toMatch(/\b(?:flask|fastapi|uvicorn|http\.server)\b/i);
  });

  it('由 Runtime 直接启动项目内 Worker', async () => {
    const runtimePath = join(process.cwd(), 'src', 'model', 'local', 'TransformersRuntime.ts');
    const runtime = await readFile(runtimePath, 'utf8');

    expect(runtime).toContain('"scripts", "model-runtime", "transformers_worker.py"');
    expect(runtime).toContain('new PythonRuntimeProcess(');
    expect(runtime).not.toMatch(/ollama|lm\s*studio|vllm/i);
  });
});
