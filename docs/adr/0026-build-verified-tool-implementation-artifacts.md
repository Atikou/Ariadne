# ADR 0026: build-verified first-party Tool implementation artifacts

- Status: accepted and implemented for the production first-party Tool Catalog
- Date: 2026-08-29
- Scope: Runtime-local JavaScript implementation authority and release verification

## Context

The immutable Tool Catalog already pinned schemas, permissions and lifecycle
semantics, but each registration supplied synthetic bytes derived from the Tool
name, Tool version and artifact role. That proved that the contract changed
when a developer remembered to change its version; it did not prove which
implementation bytes would actually run. A code-only change could therefore
leave the published Catalog digest unchanged.

Hashing `Function.toString()` at runtime would preserve the wrong boundary. It
is engine-dependent, omits imported code and is not the packaged JavaScript
that production executes.

## Decision

The Runtime build now generates
`runtime/config/first-party-tool-artifacts.json` after TypeScript emission. For
each explicit production Tool module root, the generator walks emitted relative
ESM imports, sorts the resulting Runtime-local module closure and records each
actual `dist/**/*.js` file's byte length and SHA-256. It then hashes one
canonical byte stream containing the algorithm identifier, every path, length
and exact file body.

Production registration identifies its implementation root with
`import.meta.url`. `FirstPartyToolArtifactAuthority` maps source and built module
URLs to the same manifest root, rejects non-canonical or escaping paths, reads
the emitted files and rechecks length, file digest and closure digest before it
returns implementation artifact bytes. The Tool Catalog digest therefore
covers the code closure as well as its existing contract fields. Catalog
revision 14 pins the resulting digest.

The four existing artifact roles use the same verified module-closure byte
stream. They do not claim that provider, normalizer, prepared validator and
execute are separately bundled when they live in one module graph. Injected
host services, external packages, model routes and sandbox providers remain
separate frozen capability authorities and are not misrepresented as Tool-local
bytes.

The compiled verifier CLI performs the same checks without constructing the
application. Packaging requires both the manifest and CLI and executes the
verifier against the packaged Runtime. The release-contract gate validates the
manifest schema and that at least one implementation module is declared.

## Consequences

- A code-only change in any covered Runtime-local Tool dependency changes the
  real Catalog digest. An unchanged protocol constant fails the Catalog gate;
  it cannot be hidden by a synthetic name/version marker.
- Missing, edited, reordered, oversized or path-escaping manifest content fails
  closed before Tool registration.
- The list of production Tool module roots is an explicit release allowlist.
  Adding a new Tool family requires adding its actual root to the generator.
- This decision does not make old Catalog revisions executable. Production
  still loads only the current snapshot; ADR-0027 now gives a nonterminal Run
  pinned to a retired revision an explicit durable retirement path rather than
  rebinding or blocking Runtime readiness. Exact continuation across binary
  upgrades would still require bounded signed historical bundles.

## Verification

Required coverage includes source/built URL equivalence, all declared module
roots, exact closure verification, tampered emitted-file rejection, Catalog
digest drift, the standalone CLI, release-contract inspection and packaged
Runtime execution of the verifier.
