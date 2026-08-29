# ADR 0023: durable Conversation image attachments

- Status: accepted and implemented
- Date: 2026-08-29
- Scope: image upload, Conversation authority, Agent Turn input and exact Provider requests

## Context

The legacy `ResourceRegistry` is not part of the v3 Conversation transaction or
Run admission path. Reusing it would create a second ownership boundary: a
Message could reference an unavailable object, or an object could be published
without a Message owner. Browser object URLs, local paths and remote bearer URLs
also cannot be durable inference inputs.

## Decision

The v3 path accepts only bounded PNG, JPEG and WebP uploads. A dedicated local
store fully decodes the source, checks media identity, dimensions, pixel count,
per-image and aggregate byte limits, applies orientation and bounded
normalization, then atomically commits the result under its SHA-256 identity.
Only after those objects exist may Conversation authority commit the ordered
attachment references with the user Message. The Message digest covers both
text and ordered references; legacy text-only digests retain their old identity.

Durable refs contain only content identity, media type, normalized byte count,
dimensions and an optional basename. They contain no path, URL or image bytes.
Public Projection publishes the safe metadata and redacts its optional name.
The Renderer may hold base64 only while composing the command; projection and
UI state never retain it.

Agent Turn input stores the exact Message owner plus the immutable reference.
Immediately before inference, `ProductionConversationAttachmentReader` reloads
that exact Message version and proves it owns the exact ref. The content store
then verifies the object digest and decoded metadata again. Only this ephemeral,
verified read becomes a Provider-neutral image block. OpenAI-compatible adapters
emit an image data URL; Anthropic emits a native base64 image source. Local text
models reject image blocks instead of silently dropping them. Admission requires
a model binding declared as vision-capable, including automatic routing.

Image-only user Messages are valid. Assistant and system Messages cannot own
image refs. Caption and images are coalesced as one long-context group; token
estimation uses normalized dimensions rather than base64 length.

## Consequences

- Conversation remains the only durable owner of a user attachment reference.
- Copying a ref to another Message does not grant read authority.
- Invalid media, corrupt content-addressed objects and mismatched metadata fail
  before Provider I/O.
- A failed Message CAS may leave an unreachable immutable object. Reference-aware
  garbage collection is intentionally deferred; it must scan Conversation
  authority and must not delete an object merely because one Session is removed.
- The current public UI shows durable metadata after reload. A future thumbnail
  route must preserve the same exact-owner check and must not journal base64.

## Verification

Required coverage includes media normalization/deduplication, corruption and
owner-copy rejection, image-only protocol and Conversation acceptance, safe
Projection metadata, vision-binding selection, OpenAI/Anthropic serialization,
no Provider I/O on digest mismatch, full Runtime tests, type checks and the
architecture gate.
