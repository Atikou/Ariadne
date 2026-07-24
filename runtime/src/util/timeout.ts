/**
 * 合并一个外部 AbortSignal 与一个超时，返回新的 signal 和清理函数。
 * 任意一方触发都会 abort 返回的 signal。
 */
export function withTimeout(
  timeoutMs: number,
  external?: AbortSignal,
): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort(new Error(`操作超时（${timeoutMs}ms）`));
  }, timeoutMs);

  const onExternalAbort = () => controller.abort(external?.reason);

  if (external) {
    if (external.aborted) {
      onExternalAbort();
    } else {
      external.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  const cancel = () => {
    clearTimeout(timer);
    external?.removeEventListener("abort", onExternalAbort);
  };

  return { signal: controller.signal, cancel };
}

/** 安全解析 JSON；失败时原样返回字符串。 */
export function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
