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
| T01 | TM0 | pending |  |  |  | LT-1 script: two bots in one group. |  |
| T02 | TM0 | pending |  |  |  | TM0 scenario table. |  |
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
