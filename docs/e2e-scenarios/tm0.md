# Scenario table: team track TM0, harness self-test

Status: test-design pass, 2026-09-16, written before implementation from the Team track design and T01 live evidence.
Review: jd skim approved 2026-09-16: yes, this table covers TM0 for T03/T04, including H-TM-LT1 administrator delivery.

Specification sources:

- [Team track dev brief](../telegram-task-control/team-track-dev-brief.md): sections 5 and 6, especially the no-regression invariants, harness hygiene and administrator-delivery trap.
- [Teammate design](../telegram-task-control/teammate-design.md): sections 4.4 and 8.4, including LT-1's recorded delivery rules and the TM0 harness additions.
- [Engineering plan](../telegram-task-control/engineering-plan.md): section 3b, TM0 and the crucial team scenarios that depend on it.
- [Human verification checklist](../telegram-task-control/human-verification.md): row H-TM-LT1, recorded 2026-09-16.
- Existing scenario tables in this directory for row shape and tier language.

## How to read this table

These rows are harness self-tests. They do not require product team features to exist yet; they prove that T03 and T04 can express later TM1 to TM3 product scenarios.

Tier T0 means a unit or contract test of the harness helper, fake Telegram or route/network seam, with no browser.
Tier T1 means a booted harness self-test with app environments using temporary roots, fake Telegram and a shared bare repository.
All rows are fake-backend rows. Real Telegram coverage for the administrator-delivery contract is H-TM-LT1 and is cited rather than repeated.

In the rows below, **env A** and **env B** are two independent app environments in the same Playwright test process. They have separate temporary `AGENT_CONSOLE_REPO_ROOT` values, app ports and web ports, but share one fake Telegram instance and one bare Git repository created for that test.

## Findings from T01 and the design

- H-TM-LT1 recorded that both administrator bots reported `can_read_all_group_messages=false`, yet both received plain commands, addressed commands, replies to either bot's message and unanchored discussion in the group.
- TM0 must model that broad administrator delivery in the fake. Correctness is not provided by privacy mode; later product rows must prove local ownership filtering and quiet drops.
- Bots cannot add bots on real Telegram, but the fake may provide harness setup helpers for membership and administrator state so later scenarios can start from a known group roster.
- `network.cutGit()` must be scoped per environment: cutting Git for env A cannot silently cut env B or the shared fake Telegram.

## Rows

| Scenario ID | Covers | Kind | Given / when / then | Tier and backend | Priority |
| --- | --- | --- | --- | --- | --- |
| S-TM0-01 | TM0, T03, ports | happy path | Given `startTeamHarness()` is asked for env A and env B in the same test. When both app environments start. Then they use offset server and web ports, both health checks pass, their base URLs differ, each API reports its own temporary root, and disposing one environment leaves the other reachable until it is disposed. Failure case: if a requested base port is occupied, the error names the port and no half-started environment remains. | T1 fake | must |
| S-TM0-02 | TM0, T03, fake sharing | happy path | Given env A and env B use one shared fake Telegram with bot A, bot B, user A and user B. When each environment boots with its own bot token and calls `getMe`, sends a private message and polls. Then each bot sees only its own private updates, the fake transcript distinguishes bot tokens without exposing token values, user ids are stable, and both environments can poll at the same time without one consuming the other's bot updates. | T0 fake + T1 fake | must |
| S-TM0-03 | TM0, T04, membership, admin, `getChatMember` | happy path | Given the fake creates one private group containing user A, user B, bot A and bot B, with both bots promoted to administrator with pin-message and invite-user rights. When each bot calls `getChatMember` for itself, the other bot, both users and a stranger. Then the Bot API shapes match the recorded contract fields used by the app; administrators show the granted rights, members show membership without admin rights, and the stranger is absent or left with a stable fake-Telegram result. Failure cases cover demoting a bot and removing a user. | T0 fake | must |
| S-TM0-04 | TM0, T04, pinning, invite links | happy path | Given both bots are administrators in the shared group. When bot A sends and pins a message, bot B sends and pins another message, bot A creates a one-use `createChatInviteLink`, user B leaves and rejoins by that invite, then the invite is reused. Then the fake records both pin calls with the correct bot and chat, group membership changes only on the join, the first join succeeds, the reused one-use invite is refused, and `getChatMember` reflects the final membership. Failure case: a non-admin bot or user cannot pin or create an invite link. | T0 fake | must |
| S-TM0-05 | H-TM-LT1, TM0, T04, administrator delivery | happy path | Given bot A and bot B are administrators in the group and both `getMe` results have `can_read_all_group_messages=false`. When user A sends a plain `/status`, `/status@bot_a`, `/status@bot_b`, a reply to bot A's message, a reply to bot B's message and an unanchored discussion message. Then both bot update queues receive every one of those group updates, including addressed commands for the other bot and discussion, with stable update ids per bot. The row asserts delivery only; product ownership decisions are covered by later TM2 scenarios. | T0 fake | must |
| S-TM0-06 | 4.4, section 5 invariant, T04 support | harness contract | Given S-TM0-05 has delivered the same group update to both bots. When a test consumes the updates through env A and env B. Then the harness exposes enough metadata for later product assertions to distinguish plain commands, addressed commands, anchor replies, replies to either bot and unanchored discussion, including original message ids and reply ids in the bot id space. The self-test also includes a fixture expectation for later TM2: owner handles, non-owner stays silent, addressed-to-another is ignored, unknown item is answered once by the typer's workstation, and unanchored discussion is quietly dropped unless it is a recognized team-level command. | T0 fake | must |
| S-TM0-07 | TM0, T03, bare repository | happy path | Given env A and env B are started for one test with a shared bare repository and separate working roots. When env A writes a commit and pushes a test ref, env B fetches it, then env B writes and pushes another test ref. Then both environments talk to the same bare repository, refs are visible across environments after fetch, no refs leak into another test's bare repository, and repository paths are under that test's temporary directory. | T1 fake | must |
| S-TM0-08 | TM0, T03, `network.cutGit()` | failure path | Given env A and env B share the bare repository. When `envA.network.cutGit()` is active, env A's fetch or push fails with a sanitized harness-network error, while env B can still fetch and push and fake Telegram calls still work for both environments. When env A restores Git, its next Git operation succeeds. The symmetric env B case is also covered. | T1 fake | must |
| S-TM0-09 | TM0, T03/T04, cleanup and isolation | restart | Given a test starts env A, env B, one fake Telegram, one shared group and one bare repository. When the test disposes them and starts a second test. Then no ports, pending Telegram updates, group membership, invite links, pinned-message state, Git refs or cut-network state leak from the first test into the second. Failure case: disposal while Git is cut or a Telegram long poll is pending still completes within the harness timeout. | T0 fake + T1 fake | should |

## Skim

JD skim response received 2026-09-16: yes, `docs/e2e-scenarios/tm0.md` covers TM0 for T03/T04, including H-TM-LT1 administrator delivery.
