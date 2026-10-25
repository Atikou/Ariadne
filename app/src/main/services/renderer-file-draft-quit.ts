import { z } from 'zod';
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import { workspaceDocumentPathSchema, publicProjectionCanonicalIdSchema } from '@ariadne/protocol/public';
import { DraftQuitBlockedError } from './renderer-draft-quit';

interface RendererContents { isDestroyed(): boolean; executeJavaScript(code: string): Promise<unknown> }
const ROOT = 'globalThis.__ariadneRendererCompositionRootV1';
const summariesSchema = z.array(z.object({ workspaceId: publicProjectionCanonicalIdSchema, path: workspaceDocumentPathSchema,
  pending: z.boolean(), writable: z.boolean() }).strict()).max(32);

/** Read only bounded metadata before asking the app user how to handle files.
 * User interaction is separate from the bounded Renderer persistence barrier. */
export async function prepareRendererFileDraftQuit(contents: readonly RendererContents[],
  choose: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>, timeoutMs = 5000): Promise<void> {
  const owners: RendererContents[] = [], summaries: z.infer<typeof summariesSchema> = [];
  try {
    for (const renderer of contents) if (!renderer.isDestroyed()) {
      const rows = summariesSchema.parse(await bounded(renderer.executeJavaScript(`(() => { const root=${ROOT}; return root ? root.services.documents.unsavedDrafts().map(row=>({workspaceId:row.workspaceId,path:row.path,pending:row.pendingMutation!==null,writable:row.writable})) : []; })()`), timeoutMs));
      summaries.push(...rows); owners.push(renderer);
    }
    if (!summaries.length) return;
    const lines = summaries.slice(0, 8).map(row => `${row.path}${row.pending ? '（原操作待核对）' : ''}${row.writable ? '' : '（只读）'}`);
    if (summaries.length > 8) lines.push(`另有 ${summaries.length - 8} 个文件；完整清单可在文件面板查看。`);
    const selected = await choose({ type: 'warning', title: '处理未保存文件', message: `${summaries.length} 个文件有未保存草稿或待核对操作`,
      detail: lines.join('\n') + '\n\n保留草稿只保护已确认落盘的修订，恢复时不会自动写入文件。保存失败或原操作未确认会取消退出。',
      buttons: ['保存全部并退出', '保留草稿并退出', '丢弃草稿并退出', '取消退出'], defaultId: 1, cancelId: 3, noLink: true });
    if (selected.response < 0 || selected.response > 2) throw new DraftQuitBlockedError();
    const choice = ['save', 'retain', 'discard'][selected.response];
    // Save-all is a separate bounded user operation. The final private flush
    // barrier retains its existing five-second deadline.
    const operationTimeout = choice === 'save' ? 30000 : timeoutMs;
    const deadline = Date.now() + operationTimeout;
    for (const renderer of owners) await bounded(renderer.executeJavaScript(`${ROOT}?.services.documents.prepareQuit(${JSON.stringify(choice)},${deadline})`), Math.max(1, deadline - Date.now()));
  } catch (error) {
    for (const renderer of owners) if (!renderer.isDestroyed()) await bounded(renderer.executeJavaScript(`${ROOT}?.services.documents.resumeAfterCancelledQuit()`), 1000).catch(() => undefined);
    if (error instanceof DraftQuitBlockedError) throw error;
    throw new DraftQuitBlockedError();
  }
}
async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new DraftQuitBlockedError()), timeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); }
}
