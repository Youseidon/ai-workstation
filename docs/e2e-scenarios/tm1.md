# Scenario table: team track TM1, team and roster

Status: test-design pass, 2026-09-17, written before TM1 product implementation.
Review: jd accepted this table and the four defaults on 2026-09-17.

Specification sources:

- [Team track dev brief](../telegram-task-control/team-track-dev-brief.md): TM1 tasks T05 to T10, invariants and known traps.
- [Teammate design](../telegram-task-control/teammate-design.md): sections 4.2 to 4.4, 5.5, 8.4 and 10.
- [Engineering plan](../telegram-task-control/engineering-plan.md): section 3b, especially TM-T0-3 to TM-T0-5 and TM-T1-1.
- [TM0 scenario table](tm0.md): two-environment harness, shared fake Telegram and bare repository contract.

## Defaults accepted by jd

- Team action cards expire after 10 minutes.
- An item grant lasts until it is revoked, the item thread closes or handover starts.
- A join code is single use and expires after 24 hours.
- An item id is short and opaque. Its group tag is built from that id and follows C1's tag rules.

## How to read this table

TM1 uses the TM0 two-environment harness. Env A is jd-laptop and env B is
Yousef's workstation. They have separate app roots and bots, and share the fake
Telegram group and a private bare repository. The code and roster contain no
Telegram, Git or bot credential.

T0 rows exercise isolated persistence, codec and Git seams. T1 rows boot both
environments against the fake services. LT-3 is a deferred real check with jd
and Yousef, scheduled after TM1; it is not replaced by a fake test.

## Rows

| Scenario ID | Covers | Kind | Given / when / then | Tier and backend | Priority |
| --- | --- | --- | --- | --- | --- |
| TM-T0-3 | T07, join code | contract | Given a team id, group id, remote URL and unused invite id. When a workstation encodes then decodes an `awj1.` join code. Then the original fields and the 24-hour expiry round-trip, and no credential is present. Tampering, a wrong version, a wrong team, expiry and a reused invite id are rejected before roster mutation. | T0 fake | must |
| TM-T0-4 | T07, shared roster | race and recovery | Given two workstations read the same `refs/aw/team` head. When both add a member with distinct command ids and race compare-and-swap publication. Then one head wins, the loser fetches and re-validates rather than overwriting it, and an uncertain push is resolved by finding its command id in the fetched record. A non-fast-forward or rewritten record disables the team operation for inspection. | T0 fake Git | must |
| TM-T0-5-24 | T07, migration 24 | migration | Given a predecessor database with existing personal actors and C1 threads. When migration 24 runs. Then `team_roster` and the group-actor sentinel/index are present, personal rows and indexes remain intact, and a duplicate group actor is refused while a group actor is never eligible for personal notifications. | T0 SQLite | must |
| TM-T1-1 | T08, T09, roster | happy path and restart | Given jd creates a roster and then jd-laptop stops. When Yousef enters an unused valid join code, confirms the reachable remote and publishes their person, bot and workstation. Then both panels converge after jd-laptop returns, the code has no credential, and both panels show the manual instruction to add Yousef's bot as a group administrator. The one-member invite is issued only by jd's workstation after the roster change, and the fake records a single successful join. | T1 fake | must |
| TM-T1-1a | T08, team creation | happy path | Given jd is personally paired and his bot is a group administrator with Pin messages and Invite users. When the Agents page creates a team and `/team <code>` is observed in that group, then local confirmation publishes one roster with the group, jd's person, bot and workstation. A non-administrator bot, wrong group, stale code or declined confirmation creates no roster or group actor. | T1 fake + UI | must |
| TM-T1-1b | T09, join failure | failure path | Given a join code or remote check fails, a code is reused, or the candidate local workspace lacks the stated remote. When Yousef attempts Join team. Then no local team is enabled, no roster write occurs, no invite is created and the panel states the next corrective action without exposing a secret. | T1 fake + UI | must |
| LT-3 | TM1 real join | live evidence | Given jd and Yousef each have their own L1 setup and bot. When Yousef joins with a fresh code and jd manually adds their bot as an administrator, then stopwatch time, both panels and the roster show two people and two bots. | Human Telegram and Git | required after TM1; deferred by jd until full build |

## Burn-in and regression

TM-T1-1, TM-T1-1a and TM-T1-1b run three times at the project default once
implemented. TM1 keeps `team.enabled` off by default and reruns the affected
personal-control rows to prove that each private chat continues to be handled by
only its own bot.

## Skim

JD accepted the TM1 table and the four defaults on 2026-09-17. The live LT-3
check is intentionally parked until the full build at jd's direction.
