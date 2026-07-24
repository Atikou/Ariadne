interface DisposableLlamaSequence {
  dispose(): void;
}

interface DisposableLlamaChatSession {
  dispose(options: { disposeSequence: true }): void;
}

/**
 * Runs one chat operation with exclusive ownership of a context sequence.
 *
 * Acquiring a sequence transfers responsibility for returning it to this scope.
 * The sequence is therefore released on success, generation failure, cancellation,
 * and even when constructing the chat session throws.
 */
export async function withOwnedLlamaChatSession<
  Sequence extends DisposableLlamaSequence,
  Session extends DisposableLlamaChatSession,
  Result,
>(
  acquireSequence: () => Sequence,
  createSession: (sequence: Sequence) => Session,
  useSession: (session: Session) => Promise<Result>,
): Promise<Result> {
  const sequence = acquireSequence();
  let session: Session | undefined;

  try {
    session = createSession(sequence);
    return await useSession(session);
  } finally {
    if (session) session.dispose({ disposeSequence: true });
    else sequence.dispose();
  }
}
