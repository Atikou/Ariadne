import { useRef, useState } from 'react';

/** A single user action stays pending until the authoritative service settles it. */
export function usePanelAction() {
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const execute = async (action: () => Promise<unknown>): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : '操作未完成，请检查任务状态后重试。');
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  return { pending, error, execute };
}
