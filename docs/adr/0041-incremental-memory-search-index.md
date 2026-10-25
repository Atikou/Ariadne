# ADR 0041: Incremental, bounded memory search

Status: Accepted, 2026-10-06. T08 implementation and scoped acceptance complete.

LongMemory remains the sole content authority. Released authority Schema 1,
command fingerprints, original receipts, tombstones and nine frozen access
contracts remain unchanged. No retired execution or import system is restored.
The old full-scan recall/vector-cache production methods have been removed;
released authority vector rows remain preserved and audited as frozen data.

Search metadata, vectors, buckets and durable jobs belong to a disposable
derived owner at data/long-memory/search-index.db. Its new Schema 1 layout digest
is sha256:ef1da253ce969ea83d4fa192e4ed117349cc0ee4fe102e3c88df60256ef3996d.
Unknown/unversioned/future/drifted layouts are preserved and disabled, never
silently cleared. Only a known validated derived store can be rebuilt.

The authority's original long_memory_commands receipt commits with each
mutation and supplies the change stream. Cursor position is bound to command ID.
Restoration or a missing/repositioned receipt triggers bounded metadata
bootstrap, never business replay. Startup reads metadata by keyset pages of
256 and catches up receipt pages of 128 after its starting boundary.

Jobs coalesce by memory/version/embedding space, with durable retries and
model-wide backoff. Space identity includes provider, model/weight digest,
dimension, pooling and candidate algorithm. Separate metadata and computation
lanes allow instruction visibility while a native embedding is slow. One
native computation occupies capacity until its actual promise settles.
Publication checks authority version/status/review/expiry under its read fence
and checks derived scanTag, so an old in-flight call cannot alter new-generation
jobs. A success for one document does not clear another durable failed job.
Failure checks use a partial failed-job index rather than scanning pending work.
Deletion, inactivity and expiry exclude records immediately; physical cleanup
can follow in bounded jobs. Old embedding spaces never participate in queries.

Lexical candidates and instruction Top-N use indexed scope/status metadata.
Signed sparse LSH uses 4 tables, 12 bits, 16 sampled coordinates per bit and
52 indexed probes. Candidate IDs/scalars are grouped before LIMIT and JSON
reads. Queries decode at most 128 vectors or 131072 coordinates, whichever
is tighter. This approximate algorithm does not guarantee exhaustive nearest
neighbors or constant-time SQL collision grouping. Final hits and instructions
re-read current authority scope, version, review and expiry before returning.

Foreground queries never build document vectors. Cold indexes return actual
lexical evidence with complete=false. A five-second deadline and caller abort
end the caller wait without pretending to abort an adapter lacking an abort
API. Shutdown joins real native work before releasing owners. Source faults
remain strict and cannot be masked as deadline or index errors. Known derived
failures get bounded rebuild; unknown formats stay preserved/disabled.

The published reason enum remains frozen. Candidate cuts, deadlines and busy
queries use complete=false/degraded=true/reason=null. Actual index preparation
uses index_rebuild_required; actual model unavailability uses model_unavailable.
Lexical evidence is labelled lexical, never semantic.

Acceptance: Runtime 158 files/1185 tests, App 95/440/types/build, architecture
and unchanged access contracts pass. Actual SQLite 0/100/1000/10000 scale,
65536-dimensional coordinate limits, cancellation, version/model changes,
expiry, corruption and process death/reopening pass. In the latest full run,
10000 identical-vector memories build in 18341 ms, warm recall is 601 ms and
instruction Top-N 1.6 ms, with 80 lexical bodies/256 source reads/one query
embedding and zero background body reads during the query. Collision cuts
remain explicitly incomplete. Performance samples are not cold-cache guarantees.

Native electron-t08-failed-job-index-final passes original 70 fixture requests,
66 responses, four expected aborts, five Runtime kills, Main restart and actual
Renderer/Agent memory operations. Source and model health gates pass initial
and Main restart with source bytes retained. Separate native node-llama-cpp
acceptance uses pinned official Nomic Q4_K_M/768 dimensions and a small English
task-prefix sample, including immediate deletion exclusion. Tokenizer warnings
are retained. This does not establish Chinese/general quality; user config
remains lexical. See the [official model card](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/blob/main/README.md).

Detailed chronological evidence, intermediate failures, scheduling and failure
check regressions, and the overwritten-scale-file capture limitation are in
remediation-verification.md and artifacts/todo-remediation. Scoped memory UI
fixtures cover 15 checks; unrelated whole-module UI acceptance remains separate.
The first native notification synchronization warning is retained and does not
claim physical notification-click acceptance.
