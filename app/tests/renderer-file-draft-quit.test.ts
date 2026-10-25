import { describe, expect, it, vi } from 'vitest';
import { prepareRendererFileDraftQuit } from '../src/main/services/renderer-file-draft-quit';
import { DraftQuitBlockedError } from '../src/main/services/renderer-draft-quit';
import type { MessageBoxOptions } from 'electron';
const summary = [{workspaceId:'workspace-a',path:'notes.txt',pending:false,writable:true}];
describe('metadata-only file quit summary', () => {
  it('does not prompt for untouched files', async () => {
    const choose=vi.fn(),executeJavaScript=vi.fn(async()=>[]);
    await prepareRendererFileDraftQuit([{isDestroyed:()=>false,executeJavaScript}],choose);
    expect(choose).not.toHaveBeenCalled();expect(executeJavaScript).toHaveBeenCalledTimes(1);
  });
  it.each([[0,'save'],[1,'retain'],[2,'discard']] as const)('routes choice %i through the original editing owner',async(response,choice)=>{
    const executeJavaScript=vi.fn().mockResolvedValueOnce(summary).mockResolvedValueOnce(undefined);
    const choose=vi.fn(async(_options:MessageBoxOptions)=>({response,checkboxChecked:false}));
    await prepareRendererFileDraftQuit([{isDestroyed:()=>false,executeJavaScript}],choose);
    expect(executeJavaScript.mock.calls[0]![0]).toContain('workspaceId:row.workspaceId,path:row.path');
    expect(executeJavaScript.mock.calls[1]![0]).toContain(`prepareQuit("${choice}",`);
    expect(choose.mock.calls[0]![0]).toMatchObject({defaultId:1,cancelId:3});
  });
  it('cancel never saves or discards and resumes editing',async()=>{
    const executeJavaScript=vi.fn().mockResolvedValueOnce(summary).mockResolvedValueOnce(undefined);
    await expect(prepareRendererFileDraftQuit([{isDestroyed:()=>false,executeJavaScript}],async()=>({response:3,checkboxChecked:false}))).rejects.toBeInstanceOf(DraftQuitBlockedError);
    expect(executeJavaScript.mock.calls[1]![0]).toContain('resumeAfterCancelledQuit');
    expect(executeJavaScript.mock.calls.flat().join(' ')).not.toContain('prepareQuit(');
  });
  it('a failed retain operation blocks destruction and resumes the owner',async()=>{
    const executeJavaScript=vi.fn().mockResolvedValueOnce(summary).mockRejectedValueOnce(new Error('disk unavailable')).mockResolvedValueOnce(undefined);
    await expect(prepareRendererFileDraftQuit([{isDestroyed:()=>false,executeJavaScript}],async()=>({response:1,checkboxChecked:false}))).rejects.toBeInstanceOf(DraftQuitBlockedError);
    expect(executeJavaScript.mock.calls[2]![0]).toContain('resumeAfterCancelledQuit');
  });
});
