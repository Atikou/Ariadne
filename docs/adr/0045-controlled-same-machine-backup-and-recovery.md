# ADR 0045: Controlled same-machine backup and recovery

Status: Proposed, 2026-10-06. T11 is in progress; foundations do not constitute
an accepted backup/restore product.

Main owns location selection, admission, private stores, encryption, progress and
the eventual directory switch. Runtime owns current database paths, schema
validation, producer shutdown and the storage snapshot adapter. Backups cover
current-system same-machine recovery for the same Windows user. They exclude
model weights and original workspace files. Retired formats are rejected, without
conversion or changes to their originals.

The existing Runtime shutdown handshake provides the maintenance boundary.
RuntimeSupervisor.withOfflineMaintenance blocks new requests, starts and
configuration changes. It requires shutdown_complete and an actual clean child
exit before invoking the offline operation. An unacknowledged/forced exit cannot
authorize a backup. Operation failure resumes the original Runtime without
replaying the operation. Main additionally freezes its IPC/background
mutations and flushes settings, preferences, drafts, input outbox, notification
stores, credential/keyring queues and window state. The original-owner
integration verifies this coordination; full Electron restore remains pending.

Current database paths are shared through the private Main/Runtime protocol.
The original persistence signatures remain frozen. A storage-only child acquires
all seven SQLite owner leases before capturing the first file. It uses SQLite
VACUUM INTO, including committed WAL, then checks integrity and physical
schema metadata and hashes the copied bytes. It never boots Agent, inference,
tools or schedulers. The Main bridge requires both the correctly bound response
and clean process exit before resuming Runtime. Failure cannot authorize a
half-completed snapshot.

The closed inventory includes the seven current Runtime databases, canonical
conversation attachment objects, Main state/settings/drafts/outbox, credential
vault and Agent persistence keyring, both notification bookkeeping stores,
terminal metadata and Chromium sessionData Local State. Optional absence is
explicit. Derived task/search indexes are rebuilt; backups never recursively
include every userData or workspace file. Unpublished attachment temporary files
are counted separately. Unknown source objects, aliases, broken object hashes,
unavailable owner leases and inventory capacity violations fail the operation.

Backup objects use Node AES-256-GCM with a fresh nonce and authenticated backup
ID, source identity, byte count, digest and SQLite metadata. Streams keep bounded
buffers, use exclusive destination creation, verify source identity/digest and
flush new files. Failed authentication removes only the operation's unpublished
output and preserves original files and pre-existing destinations. The manifest
is also encrypted and authenticated, including the per-object seals and explicit
count of unpublished attachments excluded from capture. Only fully flushed
objects and header are published by a same-volume directory rename. Extraction
authenticates every object in a fresh private root, rejects unexpected contents
and never merges into live data. Container integrity does not establish current
owner formats or protected-payload decryption.

One Application MainMaintenanceGate now owns persistence admission for state,
settings, private drafts/outbox, notification ledgers, OAuth vault, key rotation,
terminal metadata, mutating IPC and MCP connect/send/callback transactions. An
accepted async operation may finish its nested writes during drain. Expired async
contexts cannot bypass a subsequent freeze. Capture capabilities expire with
their coordinator; admission waits for a started capture even if its coordinator
returns or fails early. PTY exits and window geometry events defer their commits
until reopening, rather than lose observed facts during capture.

The original notification consumer pauses, drains its reader and ignores delayed
native receipts before capture, then resumes with the same ledgers. Main waits
for accepted writes before the Runtime lifecycle freeze, flushes all original
Main queues and captures notification SQLite through its existing connection.
DataBackupService then resumes Runtime before encrypting private snapshot copies.
Application binds actual renderer draft barriers and queues to this coordinator;
its location selection remains in Main. The service is not yet exposed by the
Settings UI. A production Runtime/Main SQLite integration validates these owner
boundaries; renderer/notification hooks and protected-key bytes in that test are
fixtures, not proof of full Electron recovery.

The random backup data key is wrapped directly using Windows CurrentUser DPAPI,
independently of Chromium's profile key. This avoids requiring an already restored
Local State to open a backup containing that same file. The original Chromium
wrapped profile key and Agent keyring still belong in the encrypted backup so
restored protected payloads remain decryptable. Windows PowerShell invokes a
fixed .NET operation, receives bytes through stdin and never takes keys in command
arguments or forwards secret diagnostics. There is no plaintext or machine-wide
fallback. The Windows API and user-scope semantics are documented by
[Microsoft ProtectedData](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.protecteddata?view=windowsdesktop-9.0).
This is a same-machine recovery design, not a supported cross-machine migration.

Restore must authenticate and validate all files in an isolated directory, reject
unsupported layouts and prove protected-data/attachment availability. The original
Runtime layout validation now reuses the seven original owners' schema and
authority validators with readonly business connections and their original
leases. The private worker rejects old schema versions without migration and
does not start execution or background submission. Integration checks confirm
the seven restored database files remain byte-identical after validation.
Agent key-anchor verification also has a readonly entry that does not install
metadata for an empty store. A sequential payload audit reuses original Core
recovery readers and AES codec, including historical artifacts; wrong-key
rejection and unchanged source rows are tested. The private recovery operation
now binds the original keyring to its operation ID, retains all owner leases
through sequential decryption and destroys its codec/key buffers before release.
Conversation validation reuses original immutable message digest readers and
the original image store to verify every referenced attachment.

Main current-format validators run without initialization, migration or repair.
An IPC-owned Electron child loads a separate copy of the original Local State,
uses the original safeStorage cipher and Main readers, and delegates Runtime
validation to the private Node worker. Chromium may write its auxiliary profile;
authenticated restore files are not used as that profile. Main waits for actual
child exit and verifies the original OS profile key remains the same.

The independent native gate created a Windows-sealed keyring, settings, OAuth
vault and drafts, used a production Runtime and original Core/Conversation
commands with explicit synthetic inputs, and published an 18-file authenticated
backup through DataBackupService. A separate Electron process unsealed and
validated nine Main files, five protected Core artifacts and one normalized
message image after authenticated extraction. Valid restored files and the
retained source stayed byte-identical. Corrupt sealed-key material and Agent
schema 7 were rejected without repair. This is not a Provider/model-quality or
Renderer-maintenance-hook assertion; those fixture hooks have no window.
The earlier T10 development profile correctly failed key-anchor validation
because it used strict-json-v1 and had no production key anchor.
Switching requires all owners stopped, a recoverable switch journal and a retained
original directory. Recovery cannot blindly replay Shell/network effects with
unknown outcomes. The implementation and current evidence are described below;
full Application recovery acceptance remains incomplete.

## Directory handoff and user interface, 2026-10-07

Main consumes an authenticated, current-format preview ticket once, assembles
only its validated closed inventory into a new same-volume sibling, synchronizes
each file and binds an authenticated manifest receipt by SHA256. The journal
records exact physical directory identities and permits explicit original or
replacement settlement after process interruption, including interruption
between a rename and its recorded phase. It never merges, overwrites or removes
the retained directories. Hardware power-loss durability is not claimed.

The standalone Node helper is detached from the original Electron process. A
private IPC arm, an actual process handle proving Main exit code zero, and an
exclusive Windows original-root lease are all required. It rechecks the journal
and candidate bytes under ownership, settles and archives the journal, waits
for its own OS lease-holder process to close, then launches the application.
Nonzero Main exit leaves the original root and recovery evidence intact.
Normal startup detects unsettled recovery before constructing Application or
Actors and uses a separate Chromium profile for the explicit recovery choice.
That complete native startup choice still needs acceptance.

Strict assembly exposed a readiness metadata defect: Public Projection was
reported as base Schema 3 after its original store had upgraded to Schema 4.
The original readiness source now reports the current owner schema; backup
publication verifies all seven measured database versions against its Runtime
boundary. An old inconsistent bundle is rejected and retained, never rewritten.

Settings uses trusted Main location selection, strict metadata-only preload
contracts, a fifteen-minute one-use ticket and explicit restoration confirmation
with cancel initially focused. Unmount, cancellation, expiry, expired commit and
normal shutdown release only the owned validation stage. Failed assembly consumes
the ticket and retains its partial candidate as evidence. No source owner is
closed until candidate assembly and private helper readiness succeed.

Main measures exact current owner files, database WAL/SHM, published attachment
objects and unpublished temporary files. The UI explicitly labels sampled
logical lengths; these are neither physical allocated bytes nor a consistent
backup boundary. Workspace files, model weights and sibling recovery directories
are excluded; missing required inventory, aliases or unknown objects fail.

Independent native clean/nonzero Electron exits prove authenticated 18-file
switching and original-root preservation. Native preview lifecycle validation
passes using original OS protection, Main readers and read-only Runtime payload
validation. Thirteen OS lease/journal checks pass, and App serial regression
passes 108 files/504 tests before the later usage implementation. Usage has three
filesystem checks and the hidden Electron data page has fourteen DOM/layout
checks. The latest App build includes the standalone helper and typed usage UI.
These fixtures do not prove the complete ApplicationController owner handoff,
restored cold startup, native picker or physical Windows interactions. Session
export, versioned cleanup, packaged asset checks and the full restore drill remain
unfinished. T11 and this ADR remain Proposed/incomplete.

## Explicit attachment cleanup and current regression, 2026-10-07

Text-only authorized same-C Session export and exact-version orphan/unpublished attachment cleanup are now implemented. Cleanup audits every immutable message version and preserves archived/lineage references. The storage-only worker validates all seven original owners, encrypted payloads and referenced images before inspecting or settling candidates while holding every lease. Candidate paths and keys stay private. Each atomic claim is durably recorded before exact-byte verification and deletion; uncertain claimed bytes and all receipts remain evidence, without automatic replay. Main uses the same original-owner maintenance coordinator for backup and cleanup. Its one-use fifteen-minute metadata preview binds version and selected categories; the UI requires explicit category selection and a cancel-focused irreversible-deletion confirmation.

Current full serial Runtime regression passes 164 files/1229 tests; App passes 112 files/523 tests with three native opt-in skips, before the subsequently added packaged cold-start smoke. Nine attachment plan/execution checks, six private protocol checks, 31 original Runtime/shared-barrier checks and six ticket lifecycle checks pass. Hidden data/cleanup/export Renderer checks pass 33 cases including both widths, and both cleanup screenshots were reviewed. Architecture and frozen nine access/two extension contracts pass. Existing Sandbox distribution is development_unsigned and release trust requirements remain unchanged. Full packaged Application recovery, native picker/interrupt-choice and release asset acceptance remain incomplete; this ADR stays Proposed.
