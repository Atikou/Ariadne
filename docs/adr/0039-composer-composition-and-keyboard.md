# ADR 0039: Composition-aware composer shortcuts

Status: Accepted, 2026-10-06. T06 implementation and scoped Windows acceptance.

The production ChatPanel has one keyboard policy and one existing draft delivery entry. Owned composition state and native `isComposing` take priority over all submission shortcuts. Ordinary Enter submits `next_turn`, Ctrl or Meta Enter submits `next_step`, and Shift Enter leaves the browser newline behavior intact. Repeated or disabled submission keys do not dispatch. Composition keys retain their native default action even when sending is disabled. No timeout or key-code exception suppresses the next ordinary Enter.

This follows the [UI Events composition key sequence](https://w3c.github.io/uievents/#events-composition-key-events): keyboard events can occur during composition, so checking Enter alone is insufficient. The spec informs the policy; the Windows event trace determines actual platform acceptance.

Each window-private draft entry has an editor identity. Explicit owner changes remount the textarea and reset composition state; immutable submission and new-to-session migration keep its identity. This identity is not saved to Main or exposed through Public Projection. Textarea resize observers and height synchronization follow the current editing element.

Evidence:

- `artifacts/todo-remediation/t06-keyboard-full-app.log`: 90 files, 407 tests. Includes composition precedence, first Enter after composition, Shift/Ctrl/Meta, repeat/disabled rules, and private identity preservation across submission/migration.
- `artifacts/todo-remediation/t06-final-keyboard-types.log` and `t06-keyboard-architecture.log`: types and architecture/hotspot checks.
- `artifacts/todo-remediation/electron-t06-physical-ime-confirmation/composer-keyboard.json`: owned TEMP profile, production ChatPanel/Core, qualified local HTTPS model fixture, real Windows input-method candidate UI and Sky keyboard actions. Space committed Chinese `在`; Enter ended a subsequent `h` composition without sending. At the candidate checkpoint Core had zero sessions/messages and the sealed input outbox was empty. Physical Shift Enter added a newline without sending; the subsequent ordinary Enter accepted exactly one user message in one session and produced `ARIADNE_SMOKE_DIRECT_OK`.

The observed Windows IME reported trusted `Process` key events with an empty code and `compositionend.isTrusted=false`. The trace preserves these values. Key identity comes from the observed external Sky Return operation recorded in `confirm-candidate`; Main does not inject the candidate-confirmation key. Acceptance does not claim all composition events were trusted, or that Enter selected a Chinese word: the actual Enter operation committed phonetic `h`. The first two failed probe records remain available and were corrected at the test-observation boundary, without changes to production policy or deadlines.

Ctrl/Meta submission semantics have policy tests; this Windows gate does not prove a macOS physical Meta key or live external Provider behavior. The full normal T05 gate continues to cover the underlying original-command delivery owner. Agent status layout remains an independent T09A failure, and whole-project completion is still pending.
