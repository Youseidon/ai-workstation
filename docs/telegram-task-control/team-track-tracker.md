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
| T02 | TM0 | blocked: jd | `01a0aa07-9659-7fa0-9129-81b3b0710f2c` | `tm/T02-tm0-scenario-table` |  | `docs/e2e-scenarios/tm0.md` ready on branch `10c3ea0`; awaiting jd skim before merge. | 2026-09-16 |
| T03 | TM0 | pending |  |  |  | Two environments side by side. |  |
| T04 | TM0 | pending |  |  |  | Group features in the fake. |  |
| T05 | TM1 | pending |  |  |  | LG-1 script: repository refs. |  |
| T06 | TM1 | pending |  |  |  | TM1 scenario table and four defaults. |  |
| T07 | TM1 | pending |  |  |  | Migration 24 and roster model. |  |
| T08 | TM1 | pending |  |  |  | Create team. |  |
| T09 | TM1 | pending |  |  |  | Join team. |  |
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
