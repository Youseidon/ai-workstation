# Native streaming for all six providers

## Outcome

Render provider text and reported thinking as they arrive, before the turn ends. Keep each response attached to its prompt. Preserve exact final text, partial responses after Stop, session continuation, permission modes, resource containment and durable replay. Do not simulate token delivery by animating a completed response.

## Audit and implementation

| Provider | Existing interface | Required work |
| --- | --- | --- |
| Claude | Agent SDK with partial messages | Verify delta/final reconciliation and thinking. |
| Cursor | CLI stream-json with partial output | Verify terminal snapshots and message boundaries. |
| Copilot | CLI JSON with streaming on | Verify delta/final reconciliation and thinking. |
| Grok | CLI streaming-json | Verify incremental text and thought boundaries. |
| Codex | CLI exec JSON whole items | Use stdio App Server: initialize, start/resume thread, start turn, agent/reasoning deltas, item completion, usage, turn completion/interrupt. |
| Kilo | CLI run JSON completed parts | Use a per-run, authenticated loopback server and subscribe to SSE before starting the session prompt; normalize part deltas, snapshots, tools, usage and terminal state. |

Protocol references: [Codex App Server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md), [Kilo runtime](https://kilo.ai/docs/contributing/architecture/cli-runtime), and the installed binaries' generated protocol/schema. Initial local versions: Codex 0.169.0; Kilo 7.8.1.

## Sequence

1. Extend the existing managed spawn lifecycle to support interactive protocols. Keep the same environment sanitization, process-group/systemd containment, cancellation deadline and cleanup. Keep compatibility with existing one-way CLI adapters.
2. Implement Codex's request/notification handshake and native deltas. Apply workspace, model, reasoning effort and sandbox settings on fresh and resumed threads. Preserve the native thread ID. Reconcile final snapshots without repeating streamed text. Reject unsupported interactive requests visibly; never leave a run hanging.
3. Implement Kilo's loopback HTTP/SSE bridge. Bind only 127.0.0.1 with per-process authentication; obtain the assigned port from startup output. Establish SSE before prompting; isolate events to the selected session and current assistant messages. Keep model/variant, plan/code behavior, existing permission rules and session continuation. Abort through the provider before forced process cleanup.
4. Add common fixtures and subprocess tests proving text arrives before completion, not just mapper output after EOF. Cover split JSON/SSE frames, reasoning, tools between messages, duplicate final snapshots, error, Stop, resume and process exit. Reuse the browser checks for pairing, pending feedback, incremental rendering and scroll/collapse behavior.
5. Run affected adapter/process tests, shared and web tests, typechecks, targeted lint, contrast checks and a production build. Record verified behavior and any environmental limits here.

## Acceptance gates

- Each provider produces visible incremental reply text before a terminal event in the verified transport contract.
- Message identity includes provider run and source block; repeated final payloads do not duplicate text.
- Thinking appears only when reported by the provider. Tool activity and connection loss have distinct states.
- Stop preserves partial output, finishes once and cleans up the complete process tree.
- Resume uses the existing provider session and the current run's permission scope.
- SSE is connected before Kilo receives the prompt. Unrelated or historic session events cannot leak into the current reply.
- Credentials and server-control capabilities do not reach browser transcripts or child agents beyond what the provider itself requires.
- Old persisted transcripts remain readable. No automatic retry can duplicate a writable turn.

## Validation record

Implemented the five steps above. Codex and Kilo now use native incremental transports; Claude and Copilot also reconcile corrected terminal snapshots, and all mappers ignore post-completion data. No typewriter animation or completed-response buffering is used.

Verification completed:

- Shared six-provider contract: partial text before completion, distinct thinking, exact Markdown, one final answer, stable attribution and idempotent replay.
- Native subprocess integration: Codex JSON-RPC and Kilo authenticated loopback SSE deliver text before the fixture's completion marker. Covered native Stop, ignored Stop/forced cleanup, startup timeout, malformed JSON, premature exit, dropped SSE without retry, resume, plan-versus-code permissions, workspace cwd and server-only environment exclusion.
- The systemd path now forwards the selected cwd and environment by variable name, without credential values in argv. Server database/settings variables are explicitly removed from both direct children and managed services. Existing process-group fallback tests also pass.
- Full server suite: 379 tests passed before the final focused additions; affected native/contract/containment tests were rerun after final review. Shared and web suites, all workspace typechecks, targeted web lint, contrast checks and the Webpack production build passed.
- Chromium: all six provider rendering fixtures, pending echo, thinking/tools/partial text, final reconciliation, pairing and collapse, draft recovery, scrolling, three themes, mobile and desktop.
- Installed Codex 0.169.0 and Kilo 7.8.1 probes reached native session IDs and terminal error states using isolated temporary profiles with no credentials and intentionally invalid models. Their protocol definitions/local OpenAPI schema were inspected directly.
- Codex API-key compatibility was checked against a local dummy Responses endpoint with a fake key. The explicit `account/login/start` handshake forwarded the bearer credential; the `ephemeral` credential store wrote no `auth.json`. API-key runs use that memory-only store, while saved-login runs keep their existing credential-store settings. See [Codex authentication](https://learn.chatgpt.com/docs/auth).

Validation limit: no authenticated model generation was exercised. Protocol fixtures prove the transport/rendering contract; exact chunk cadence and optional reasoning content still depend on the selected provider and model. Cursor must use stream-json for partial output; its explicitly selected json compatibility mode remains whole-response output.

Compatibility note: Codex/Kilo extra arguments now target App Server/serve. Supported configuration/server flags are preserved; old run-only flags produce a clear migration error. Model, variant, reasoning effort and approval settings keep their dedicated controls.
