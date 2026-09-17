# Scenario table: team track TM3, item grants

Status: test-design pass, 2026-09-18, written before TM3 product implementation.
Review: jd's standing instruction is to progress continuously through the Team
track without pausing at task boundaries. It authorizes the T17 skim and does
not add a product default or change the design of record.

Specification sources:

- [Team track dev brief](../telegram-task-control/team-track-dev-brief.md): T17
  to T20, migration 26, grant commands, close-out and audit requirements.
- [Teammate design](../telegram-task-control/teammate-design.md): sections 3.2,
  4.4 to 4.6, 5.2, 5.3, 5.5, 6, 7 and 8.4.
- [Engineering plan](../telegram-task-control/engineering-plan.md): section
  3b, especially TM3, TM-T0-2, the migration 26 case of TM-T0-5, TM-T1-4 and
  TM-T1-5.
- [TM0](tm0.md), [TM1](tm1.md) and [TM2](tm2.md): the two-environment harness,
  joined roster, explicit `team.enabled` setup, item ownership, group routing,
  owner anchor and default-off contract.
- [L1](l1.md) and [L3 B](l3-b.md): the existing action-reference, receipt,
  revision, saved-answer and start-ownership behavior reused by granted actions.

## Scope and fixed decisions

TM3 adds grants on an existing owner-controlled item thread. It does not add
handover, remote execution on the teammate's workstation, provider selection,
permission or access decisions, Git control records, a third team member, or a
message relay. A granted resume always starts on the item's owning workstation
with that task's last provider and model under the owner's settings and
allowance.

The accepted defaults remain unchanged. A Team action expires after 10 minutes.
A grant lasts until it is revoked, the thread closes, the item completes, a
handover starts, or that teammate is removed. Each capability (`context`,
`answer`, `resume`) enables separately; `all` is input shorthand, not a stored
capability. Answer and resume requires both `answer` and `resume` at tap time.
The owner does not need a grant to act on their own item.

`team.enabled` stays false by default. TM3 scenarios enable it explicitly in
both environments. Personal Telegram behavior must remain unchanged with Team
off or on. LT-4 remains a real-phone check and is not replaced by fake evidence.

## Observable layers

- **Phone/group:** sender bot, anchor reply, access-message identity and edits,
  command refusal, action card, allowance text and result.
- **Transport:** broad delivery to both administrator bots, exactly one owner
  response, edit-in-place calls and no output from the non-owner workstation.
- **Durable:** migration schema and indexes, action binding, active and revoked
  grant rows, receipts, question revision, saved answer, start intent and run.
- **Execution:** only the owner's workspace starts, once, with the owner's last
  provider/model and settings; a refusal starts nothing.
- **Repository/browser:** grants do not touch Git. Team UI remains hidden while
  disabled and personal controls remain available.

## Focused T0 rows

| Scenario ID | Covers | Kind | Given / when / then (observable result per layer) | Tier and backend | Priority |
| --- | --- | --- | --- | --- | --- |
| TM-T0-2 | T18/T19, design 5.3, authorization | table-driven grant matrix | Given a joined two-person roster, an active jd-owned item thread with an open question, owner jd, teammate Yousef, a stranger and independent `context`, `answer` and `resume` grants. When every actor issues `/context`, `/answer` and `/resume`, then taps Save answer, Answer and resume or Resume with saved answer across these states: no grant, each single grant, answer+resume, all grants, revoked grant, closed/completed thread, removed teammate and handover started. Then **authorization:** jd may use owner actions without a grant; Yousef receives only the named capability; Answer and resume needs both capabilities; the stranger and wrong bot/chat/message actor are rejected; owner-only grant/revoke/close actions never apply for Yousef. **Tap-time order:** reference and bot/chat/message binding, expiry, issued actor, current grant, expected revision, then save/resume. Revocation or lifecycle change after card display rejects the tap. **Effects:** context is sanitized/read-only with no action or receipt; a denied command gives one `Ask jd to grant <capability> on this item.` response; an applied state change writes one receipt and a duplicate returns it; simultaneous answers leave one applied answer and one changed-question rejection; resume uses jd's last provider/model and starts jd's workspace once. **Durable/transport:** rejected cases change no task, grant, receipt, start intent or run, and the broadly delivered non-owner bot stays silent. | T0 SQLite + fake Telegram/start | must |
| TM-T0-5-26 | T18, migration 26 | migration, compatibility and idempotency | Given a migration-25 database containing representative personal actions for `save_human_response` and `answer_and_resume`, action content, applied and unapplied receipts, message bindings, indexes, actors, C1 and item threads and item links. When migration 26 runs and the database boots twice. Then `task_control_action` is rebuilt with its rows, foreign keys, message bindings and indexes preserved; its action check accepts the old actions plus `resume_saved`, `grant`, `revoke` and `close_thread` and rejects unknown actions; `subject_kind` accepts only `task` or `item`; `item_id` and `payload_json` are present; `item_grant` has the specified columns and permits only one active row per item/person/capability while retaining revoked history. C1 and migration-25 item data remain byte-for-byte equivalent. A pre-upgrade Save answer card and Answer and resume card still each apply exactly once after upgrade, with duplicate delivery returning the original receipt; no boot duplicates grants or indexes. | T0 SQLite migration from version 25 | must |

## Two-environment T1 rows

| Scenario ID | Covers | Kind | Given / when / then (observable result per layer) | Tier and backend | Priority |
| --- | --- | --- | --- | --- | --- |
| TM-T1-4 | T19, happy path | grant, answer and resume | Given Team is enabled in env A (jd-laptop) and env B (yousef-desktop), both administrator bots receive group updates, an active jd-owned item thread has one pinned anchor, one access message saying `Yousef: read only`, and jd's task is waiting on a current question with a saved last provider/model. When jd sends `/grant answer`, taps the owner-bound grant card, then grants `resume`; Yousef sends `/answer <text>`, taps Save answer, and then taps Resume with saved answer (with the equivalent Answer and resume path also covered). Then **phone/transport:** the access message is edited in place after each grant, not reposted; `/access` and `/help` show only current capabilities; the action card is issued by jd's bot to Yousef and says `Uses jd's <provider> allowance`; env B stays silent. **Durable/execution:** grants name the item, Yousef and capability; the answer binds to the current question; exactly one APPLIED receipt and one run exist for the resume action on jd-laptop; duplicate callback delivery returns the first receipt and creates no second run; no Git record or provider/access setting changes. | T1 fake Telegram + fake provider/start, two environments | must |
| TM-T1-5 | T19, revocation, expiry and removal | failure, offline and recovery | Given Yousef has answer and resume grants and an open action card on jd's item. First, jd revokes resume through an owner-bound card after Yousef's card is visible; Yousef then taps the old card. Second, a fresh card is displayed, jd-laptop stops until its short fixture TTL has expired, Yousef taps, and jd-laptop returns. Yousef must issue `/resume` again to create a new card; expired or stale buttons are never renewed automatically. Third, Yousef is removed from the roster while the new card is open. Then **phone/transport:** revoke edits the same access message; each late tap is rejected with the specific current reason; expiry says the action expired and produces no replacement until Yousef retriggers the command; removal produces no teammate action. **Durable/execution:** the revoked row records the revoking command, no active duplicate remains, teammate removal disables that person's group actor and revokes all their grants, all three old cards create no answer or run, and duplicate delivery remains idempotent. Personal control and the other person's actor are unchanged. | T1 fake Telegram + two environments with env A restart | must |
| LT-4 | TM3 real thread and grant | live evidence | Given jd and Yousef have completed their real two-person join and use a throwaway workspace with the fake agent. When jd starts a thread, Yousef's ungranted `/resume` is refused, jd grants answer and resume, and Yousef answers and resumes from their phone. Then exactly one run starts on jd-laptop; both phones show the expected anchor, one access message edited in place, owner-bound grant controls, jd allowance text and clear success/refusal toasts. No credential or identifier is recorded. | Human Telegram, two phones | required after TM3; scheduled/deferred by operator until the full build |

## Burn-in and regression

TM-T1-4 and TM-T1-5 run three times at the project default after implementation.
TM-T0-2 is one table-driven scenario, not separate tests that can omit a matrix
cell. Migration 26 is exercised from a real version-25 fixture and on a second
boot. Full server and T1 suites prove existing personal actions, C1/TM2 thread
lifecycle and default-off behavior remain unchanged. The tracked-file token
sweep, database/API/log sweep fixtures and `team.enabled` fallback check remain
release gates.

## Skim

JD's standing continuous-progression instruction authorizes this T17 skim. The
table adds no default or behavior beyond the design of record. LT-4 is recorded
as scheduled/deferred and must not be marked PASS until jd and Yousef perform
the real-phone check.
