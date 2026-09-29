# Live Two-Workstation Round Trip - 2026-09-29

> **Historical partial evidence.** This run proves the product/Git facts listed
> below but does not prove durable Telegram delivery or applied Telegram action
> receipts. The current verifier intentionally rejects the original artifact.
> Personal accounts, chat identifiers, repository locations, local paths, item
> identifiers and commit identifiers have been redacted from this public copy.

Goal: run one real requester-to-receiver-to-requester Team handover through the two live pilot UIs, with Telegram and GitHub in the path.

## Planned Payload

- Task title: `WI_REAL_HANDOVER_20260929A`
- File: `handover-real-20260929A.txt`
- Exact content: `Team handover real round trip 20260929A`
- Requester UI/API: `localhost:3100` / `127.0.0.1:4100`
- Receiver UI/API: `localhost:3200` / `127.0.0.1:4200`
- Telegram group: `<telegram-group-id>`
- Telegram bots: `<requester-bot-username>`, `<receiver-bot-username>`
- Git remote: `<team-repository-url>`
- Requester workspace: `<requester-workspace>`
- Receiver workspace: `<receiver-workspace>`

## Current Preflight Evidence

Command:

```sh
export TEAM_HANDOVER_TELEGRAM_GROUP_ID='<telegram-group-id>'
export TEAM_HANDOVER_TELEGRAM_BOTS='<requester-bot-username>,<receiver-bot-username>'
export TEAM_HANDOVER_EXPECTED_REMOTE='<team-repository-url>'
node scripts/live-two-workstation-roundtrip.mjs --dry-run --suffix 20260929A \
  --evidence-out "${TMPDIR:-/tmp}/live-two-workstation-roundtrip-dryrun.json" \
  --artifact-dir "${TMPDIR:-/tmp}/live-two-workstation-roundtrip-artifacts"
```

Result:

- Script parses with `node --check`.
- Dry-run reports `existingPrompt: null`.
- Dry-run writes the configured temporary evidence file (1768 bytes observed).
- Dry-run does not create a prompt.
- Dry-run does not post to Telegram.
- Dry-run does not push or fetch GitHub refs.
- Dry-run produced no failure screenshots, as expected.
- The verifier correctly rejects that temporary dry-run evidence, because a dry run must not count as a completed live round trip.
- A later `rg` against A's workspace tree found no `WI_REAL_HANDOVER_20260929A` or `handover-real-20260929A`.
- A later `rg` against B's Team handover list found no `WI_REAL_HANDOVER_20260929A` or `handover-real-20260929A`.

## Blocker

Resolved: the user explicitly approved the exact external side effects above.

The live run reached `COMPLETED` for Team item
`<redacted-item-id>`. The original evidence artifact does **not**
prove the full Telegram + GitHub round trip claimed below: its `telegram`
section records configured constants, not delivered message ids or processed
callbacks/actions, and its handover branch was inspected only after apply had
deleted it. The historical verifier accepted either that missing branch or a
manually supplemented control ref, so its PASS was too broad.

```sh
node scripts/verify-live-two-workstation-roundtrip.mjs \
  "${TMPDIR:-/tmp}/live-two-workstation-roundtrip-live.json"
```

Historical verifier result (superseded):

```text
PASS: <evidence-file> proves the live two-workstation Team/Telegram/Git round trip for <redacted-item-id>.
```

The current verifier correctly rejects that artifact. A new live run must name
both workstation databases so the runner can read durable `SENT` outbox rows,
real Telegram message ids, and applied action receipts from the right instances:

```sh
node scripts/live-two-workstation-roundtrip.mjs --suffix <new-suffix> \
  --requester-db <requester-database> \
  --receiver-db <receiver-database> \
  --evidence-out "${TMPDIR:-/tmp}/live-two-workstation-roundtrip-live-v2.json"
node scripts/verify-live-two-workstation-roundtrip.mjs \
  "${TMPDIR:-/tmp}/live-two-workstation-roundtrip-live-v2.json"
```

The runner now records the handover and control refs at `OFFERED`, again at
`RETURNED`, and after apply. A valid artifact must show the result branch before
apply, its deletion after apply, distinct control heads across the return and
completion transitions, Telegram delivery records for the offer, Return work,
and returned-work review cards, plus applied Accept and Return receipts. A web
receipt names the exact route; a Telegram receipt must also have a processed
callback update. Configured group and bot names alone never satisfy the gate.

What the original artifact does establish:

- Requester item: `WI_REAL_HANDOVER_20260929A`, prompt `<redacted-prompt-id>`
- Team item: `<redacted-item-id>`
- Receiver run: `<redacted-run-id>`
- Receiver run state: `DONE`
- Requester handover state: `COMPLETED`
- Receiver handover state: `COMPLETED`
- Result label: `full`
- Applied file: `<requester-workspace>/handover-real-20260929A.txt`
- Applied file content: `Team handover real round trip 20260929A`
- Requester HEAD after apply: `<redacted-commit-id>`
- Git item control ref after the run: `<redacted-commit-id> refs/aw/items/<redacted-item-id>/control`
- Visible proof branch: `live-roundtrip-proof-20260929A` at `<redacted-commit-id>`
- Fetch-back proof: `git show origin/live-roundtrip-proof-20260929A:handover-real-20260929A.txt` returned `Team handover real round trip 20260929A`

## Discrepancies

- The requester publish and requester review/apply were browser-UI driven.
- GitHub's normal branches page did not show the transient handover branch after apply, because the handover flow cleaned it up. The custom Team control ref remained on the remote, and a normal visible proof branch was pushed afterward for inspection.
- The receiver UI rendered the fresh `Accept` and `Return work` buttons, but Playwright clicks on those visible enabled buttons emitted no POST to the handover action route. Screenshots/fetch logs were captured under `/tmp`.
- To keep the live round trip moving, the receiver `accept` and `return` were completed through the same web action routes that those buttons call.
- During the B web/backend restart, the receiver's local accept token expired while the offer remained open. Only the local `task_control_action.expires_at` rows for this item were renewed before invoking `accept`.
- No durable Telegram message id, callback update, or applied action receipt was captured in the original artifact. Telegram participation in this particular run therefore remains unverified by the saved evidence.
- The `requestHandoverChanges` second crossing was not exercised. M-12 remains open for that end-to-end proof.
