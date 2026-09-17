# Team track tracker

Created: 2026-09-16

Scope: T01 to T20, slices TM0 to TM3. TM4 and handover are out of scope.

Starting commits:

- main: `37236e0af1c68c0852f9ede90afeb0643b42a7c7`
- origin/main: `44ad5882fa792240860aff5468efd229a0b619c0`

Preconditions:

- L1 step 7a defects closed before Team start:
  - L1D1 Telegram-originated answers labelled in task timeline: `59fcfca`, `45ad02c`
  - L1D4 Telegram configured badge requires loaded token: `b39ae1c`, evidence close-out `37236e0`
  - L1D2 Agents header negative-zero display: `91197db`
  - L1D3 dev reload check not reproducible on current main: `9cd3885`
- `git status` clean at tracker creation.
- No harness/dev process found by `pgrep -af "npm run e2e|playwright|tsx.*e2e|vite|next dev|npm run dev"`.

| Id | Slice | Status | Worker agent id | Branch | Merged commits | Evidence summary | Date |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T01 | TM0 | done | `01a0a9ec-be3d-7911-9624-72e5406e2dd0` | `tm/T01-lt1-two-bots-group` | `0781cf1..b75077c` | `H-TM-LT1` PASS; live script recorded administrator delivery to both bots; jd chose to model broad administrator delivery in design/fake; typecheck and secret sweep passed. | 2026-09-16 |
| T02 | TM0 | done | `01a0aa07-9659-7fa0-9129-81b3b0710f2c` | `tm/T02-tm0-scenario-table` | `93c4e80..32fb000` | `docs/e2e-scenarios/tm0.md` committed; H-TM-LT1 administrator delivery included; jd skim recorded; `git diff --check` and `npm run typecheck` passed. | 2026-09-16 |
| T03 | TM0 | done | `01a0aa25-f416-7fd0-9c55-d62ca5d4f83e` | `tm/T03F-harness-selftest-fix` | `d448a4b..a395176` | Two environments, shared fake Telegram and one bare repository implemented and verified via T03F. | 2026-09-17 |
| T03F | TM0 | done | `01a0abf1-ded6-73c3-bc1c-f273659beff3` | `tm/T03F-harness-selftest-fix` | `d448a4b..a395176` | Focused TM0 self-test passed; workspace typecheck passed; inline fake-provider suite passed 4/4 after launcher permission fix; full T1 passed 113/113 in 16.5m. | 2026-09-17 |
| T04 | TM0 | done | direct | `tm/T04-group-fake` | `2f61ecb` | Group roster/admin rights, pinning, one-use invites and broad administrator delivery added; T04 contract passed, TM0 self-test passed, workspace typecheck passed. | 2026-09-17 |
| T05 | TM1 | done | direct | `tm/T05-lg1-repository-refs` | `5eefd4a` | LG-1 PASS on psyba96/contech-intel: custom refs accepted, divergent non-fast-forward rejected, handover branch accepted; both disposable probe refs deleted. | 2026-09-17 |
| T06 | TM1 | done | direct | `tm/T06-tm1-scenario-defaults` | `7841848` | TM1 scenario table committed; jd's four defaults and deferred LT-3 recorded in implementation evidence. | 2026-09-17 |
| T07 | TM1 | done | direct | `tm/T07-roster-model` | `68584cd` | Migration 24, sentinel-protected group actors, local roster cache, join codec and `refs/aw/team` CAS landed; T0 4/4, server 237/237 and workspace typecheck passed. | 2026-09-17 |
| T08 | TM1 | done | direct | `tm/T08-create-team` | `2c1cf47` | Create-team flow verifies group admin rights, awaits local confirmation, publishes the roster with CAS and creates a non-personal group actor; focused runtime 23/23, server 237/237, server/web typecheck passed. | 2026-09-17 |
| T09 | TM1 | done | direct | `tm/T09-join-team` | `ffe3cc7` | Join-code validation, single-use roster publish, runtime/API join path and Agents join panel landed; focused roster suite passed 5/5 after Git sandbox escalation; server/web typecheck passed. | 2026-09-17 |
| T10 | TM1 | pending |  |  |  | TM1 close-out and audit 1. |  |
| T11 | TM2 | pending |  |  |  | TM2 scenario table. |  |
| T12 | TM2 | pending |  |  |  | Migration 25 and item ids. |  |
| T13 | TM2 | pending |  |  |  | Anchors and read-only views. |  |
| T14 | TM2 | pending |  |  |  | Group routing rules. |  |
| T15 | TM2 | pending |  |  |  | Starting a thread on the other person's item. |  |
| T16 | TM2 | pending |  |  |  | TM2 close-out. |  |
| T17 | TM3 | pending |  |  |  | TM3 scenario table. |  |
| T18 | TM3 | pending |  |  |  | Migration 26 and grant model. |  |
| T19 | TM3 | pending |  |  |  | Grant cards and granted commands. |  |
| T20 | TM3 | pending |  |  |  | TM3 close-out and audit 2. |  |

## Notes

- 2026-09-16: Tracker created after L1 precondition cleanup. Next task is T01.
- 2026-09-16: T01 marked `blocked: jd` before spawning because its row has a known jd setup requirement: a second throwaway bot, its token placed by jd in `~/.config/ai-workstation/e2e-live.env`, and a group containing both bots. No push-notification tool was available in this session, so the request is recorded here and sent in chat.
- 2026-09-16: jd pasted a bot token in chat. The orchestrator treated it as compromised, did not use or store it, and asked jd to rotate it in BotFather. T01 remains blocked until a fresh rotated token is present only in `~/.config/ai-workstation/e2e-live.env` and the Telegram group contains both bots.
- 2026-09-16: jd confirmed the local env and group setup is done. T01 worker `01a0a9ec-be3d-7911-9624-72e5406e2dd0` started on `tm/T01-lt1-two-bots-group`.
- 2026-09-16: T01 worker reported BLOCKED after a real LT-1 check disproved design section 4.4 assumptions. Result summary: plain command reaches both bots confirmed; addressed command reaches at least the named bot confirmed; reply reaches only replied-to bot disproved; unanchored discussion reaches neither disproved. Worker question: should section 4.4 and the fake model administrator delivery, or should team setup avoid making bots administrators except when pin/invite operations are needed? No T01 branch merge yet.
- 2026-09-16: jd decided to update the design/fake to model administrator delivery. T01 worker was sent back to apply the approved design/spec correction and report again.
- 2026-09-16: T01 merged by fast-forward. Orchestrator verification: `npm run typecheck` passed; tracked-file secret sweep passed across 302 tracked files and 5 live secrets; branch `tm/T01-lt1-two-bots-group` deleted.
- 2026-09-16: T02 worker reported BLOCKED for jd skim. Question: does `docs/e2e-scenarios/tm0.md` cover the TM0 harness acceptance surface for T03/T04, including H-TM-LT1 administrator delivery, before implementation starts?
- 2026-09-16: jd answered yes on T02 skim. T02 merged by fast-forward after orchestrator verification: `git diff --check main...tm/T02-tm0-scenario-table` passed and `npm run typecheck` passed. Branch deleted.
- 2026-09-16: T03 worker first reported DONE at `65ac229`, but orchestrator rerun of `node --import tsx --test --test-concurrency=1 e2e/src/tm0.selftest.test.ts` failed with `ERR_TEST_FAILURE`; `npm run typecheck` passed. Worker was sent back once.
- 2026-09-16: T03 worker reported DONE again at `0cc1ed7`, but the same orchestrator rerun failed again with `ERR_TEST_FAILURE`; `npm run typecheck` passed. Per track rule, T03 is `blocked: review` after two verification failures. No merge performed.
- 2026-09-17: jd authorized T03F, a fresh bounded task to diagnose and fix the repeated self-test failure. T03 remains unmerged until T03F verifies.
- 2026-09-17: T03F worker exhausted service credits. jd authorized direct continuation from its preserved worktree. The focused self-test passed twice when loopback binding was permitted, and typecheck passed. The full T1 suite passed its first seven non-provider tests but then failed because the fake `grok` provider was unavailable; this is outside T03F's changed paths. T03F remains unmerged pending a green full suite.
- 2026-09-17: jd independently ran `h2-fake-provider-live.spec.ts`: all seven tests passed. The earlier provider failure was transient harness interference, not a provider setup defect. T03F resumed for final full-suite verification.
- 2026-09-17: T03F full T1 verification reached the inline fake-provider suite and failed because Grok was unavailable. The isolated `h2-fake-provider-inline.spec.ts` then failed identically (four failures). T03F is blocked after the repeated verification failure; no merge.
- 2026-09-17: jd explicitly authorized direct completion without a worker. T03F resumed to repair the inline fake-provider failure and complete verification.
- 2026-09-17: T03F merged by fast-forward. Root cause of the inline fake-provider failure was the non-executable launcher in its worktree; restoring its tracked executable mode made the inline suite pass. Final evidence: focused TM0 self-test, workspace typecheck, and full T1 113/113 in 16.5m.
- 2026-09-17: T04 started directly by the orchestrator under jd's standing authorization.
- 2026-09-17: T04 merged by fast-forward. `tm0.fake.contract.test.ts` passed S-TM0-03/04/05; TM0 two-environment self-test and workspace typecheck passed.
- 2026-09-17: jd approved psyba96/contech-intel for LG-1 and disposable `refs/aw/*` pushes, and accepted the four TM1 defaults. LG-1 passed; cleanup was retried explicitly and both probe refs were deleted.
- 2026-09-17: T06 started directly under jd's authorization. The four defaults are accepted: 10-minute team taps; grants end on revoke, thread close or handover; join codes are single use and expire after 24 hours; item ids are short and opaque and produce C1-compatible group tags.
- 2026-09-17: T06 merged by fast-forward. `git diff --check` passed; `tm1.md` records jd's skim and the deferred-until-full-build LT-3 decision.
- 2026-09-17: T07 started directly under jd's authorization.
- 2026-09-17: T07 merged by fast-forward. Focused roster suite passed 4/4, including a temporary bare-Git compare-and-swap; full server suite passed 237/237 and workspace typecheck passed.
- 2026-09-17: T08 started directly under jd's authorization.
- 2026-09-17: T08 merged by fast-forward. Focused live-runtime suite passed 23/23 including TM-T1-1a's group command, administrator-rights, local-confirmation and temporary bare-remote roster path; full server suite passed 237/237 and server/web typecheck passed.
- 2026-09-17: T09 started directly under jd's authorization; execution continues without slice-boundary pauses.
- 2026-09-17: T09 merged by fast-forward. The generated `package-lock.json` `hasInstallScript` line was absent from the final diff. Verification: `AGENT_CONSOLE_REPO_ROOT=/tmp/agent-console-t09-verify-escalated node --import tsx --test --test-concurrency=1 server/src/teamRoster.test.ts` passed 5/5 after the sandboxed rerun failed with `spawnSync git EPERM`; `npm run typecheck --workspace server` passed; `npm run typecheck --workspace web` passed.
