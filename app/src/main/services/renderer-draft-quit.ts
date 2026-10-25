export class DraftQuitBlockedError extends Error {
  constructor() { super('chat_draft_quit_blocked'); }
}
interface DraftRendererContents {
  isDestroyed(): boolean;
  executeJavaScript(code: string): Promise<unknown>;
}
const ROOT = 'globalThis.__ariadneRendererCompositionRootV1';

/** Only Main's existing privileged Renderer can own editable drafts. Flush it
 * before removing any IPC handlers or disposing desktop services. */
export async function flushRendererDraftsBeforeQuit(contents: readonly DraftRendererContents[], timeoutMs = 5000): Promise<void> {
  for (const renderer of contents) {
    if (renderer.isDestroyed()) continue;
    try {
      await bounded(renderer.executeJavaScript(`(async () => { const root = ${ROOT}; if (root) { await root.services.drafts.flushAndClose(); await root.services.documents.flushAndClose(); } return true; })()`), timeoutMs);
    } catch {
      for (const owner of contents) if (!owner.isDestroyed()) {
        await bounded(owner.executeJavaScript(`{ const root=${ROOT}; if(root) { root.services.drafts.resumeAfterCancelledQuit(); root.services.documents.resumeAfterCancelledQuit(); } }`), 1000).catch(() => undefined);
      }
      throw new DraftQuitBlockedError();
    }
  }
}
async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new DraftQuitBlockedError()), timeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); }
}
