import { useEffect, useState } from 'react';
import type { ChatDraftAttachment, ChatDraftOwner } from '@shared/chat-drafts';
import { chatDraftOwnerKey } from '@shared/chat-drafts';
import type { EncodedImageAttachment } from '@ariadne/protocol/public';
import type { ChatDraftStore } from './chat-draft-store';

/** Private UI image bodies are loaded only for current explicit references;
 * window/owner changes fence every late read. Store snapshots stay metadata-only. */
export function useChatDraftImages(store: ChatDraftStore, owner: ChatDraftOwner, references: readonly ChatDraftAttachment[]) {
  const key = JSON.stringify([chatDraftOwnerKey(owner), references.map(row => row.attachmentId)]);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; bodies: ReadonlyMap<string, EncodedImageAttachment>; failed: ReadonlySet<string> }>({ key: '', bodies: new Map(), failed: new Set() });
  useEffect(() => {
    let current = true;
    const bodies = new Map<string, EncodedImageAttachment>();
    const failed = new Set<string>();
    const publish = () => setLoaded({ key, bodies: new Map(bodies), failed: new Set(failed) });
    publish();
    for (const reference of references) void store.attachment(owner, reference).then(body => {
      if (!current) return; bodies.set(reference.attachmentId, body); publish();
    }).catch(() => {
      if (!current) return; failed.add(reference.attachmentId); publish();
    });
    return () => { current = false; };
  }, [store, key, attempt]);
  return { bodies: loaded.key === key ? loaded.bodies : new Map<string, EncodedImageAttachment>(),
    failed: loaded.key === key ? loaded.failed : new Set<string>(), retry: () => setAttempt(value => value + 1) };
}
