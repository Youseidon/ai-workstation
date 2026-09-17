# Scenario table: team track TM2, item threads

Status: test-design pass, 2026-09-17, written before TM2 product implementation.
Review: jd's standing instruction is to progress continuously through the Team track without pausing at task boundaries. On 2026-09-17 jd explicitly directed T11 to record that instruction as the skim authorization for this table. This satisfies the T11 skim stop point; no product default or design decision is added here.

Specification sources:

- [Team track dev brief](../telegram-task-control/team-track-dev-brief.md): T11 to T16, the invariants, and the migration, tag, administrator-delivery and harness traps.
- [Teammate design](../telegram-task-control/teammate-design.md): sections 4.2, 4.4 to 4.6, 5.1, 5.2, 5.5, 6 and 7.
- [Engineering plan](../telegram-task-control/engineering-plan.md): section 3b, especially TM2, TM-T0-1, the migration 25 case of TM-T0-5, and TM-T1-2, TM-T1-3, TM-T1-6 and TM-T1-7.
- [TM0](tm0.md) and [TM1](tm1.md): the two-environment harness, LT-1 broad administrator delivery, joined roster, explicit `team.enabled` setup and default-off contract.
- [L3 C1](l3-c1.md) and [L3 B](l3-b.md): the existing thread registry, anchor recovery, reply/tag mechanism and read-only view rules that TM2 reuses.

## Scope and fixed decisions

TM2 adds item subjects to C1; it does not add Telegram forum topics or a message relay. Env A is jd-laptop with jd's bot and env B is Yousef's workstation with Yousef's bot. Both bots are administrators in the one fake team group, so LT-1 delivery sends every group command, anchor reply and unanchored discussion update to both bot queues. Product correctness therefore comes from local roster, item-link and thread ownership checks.

The four defaults accepted with TM1 remain unchanged: team action cards expire after 10 minutes; grants end on revoke, thread close or handover; join codes are single use and expire after 24 hours; item ids are short and opaque, with C1-compatible tags built from the item id. This table deliberately does not choose an item-id length, alphabet or generator, a request expiry, a refresh interval, or any new fallback behaviour.

`team.enabled` stays false by default. Team scenarios enable it explicitly in both environments. Personal Telegram behavior is required to remain the same with Team either off or on.

## Observable layers

- **Phone/group:** messages, sender bot, reply relationship, tag, pin state, message identity and visible sanitized text.
- **Transport:** each bot's delivered update ids and Bot API calls, including `sendMessage`, `editMessageText`, `pinChatMessage` and `unpinChatMessage`. Message ids are compared only within the Bot API id space; the real client and Bot API id spaces are not assumed equal.
- **Durable:** migration schema and indexes, `telegram_thread`, `item_link`, inbox/outbox rows, action references and receipts. A read-only command must not create an action or receipt.
- **Repository:** no thread discussion is written to Git. Only records already assigned to the repository by the design may change; these rows assert no credential or Telegram update enters a ref.
- **Browser:** Team remains hidden while disabled; personal controls remain usable. TM2 adds no new browser workflow beyond an owner confirmation surface required by TM-T1-7.

## Focused T0 rows

| Scenario ID | Covers | Kind | Given / when / then (observable result per layer) | Tier and backend | Priority |
| --- | --- | --- | --- | --- | --- |
| TM-T0-1 | T14, LT-1, group routing invariant | table-driven routing and authorization | Given a joined two-person roster, one jd-owned item and one Yousef-owned item, both administrator bots receiving every group update under S-TM0-05, and a non-roster user. When each roster user sends `/task`, `/status`, `/access` and `/help` as a reply to each anchor; sends a command addressed to the other bot; names an unknown item; sends ordinary discussion replying to an anchor and to nothing; and the non-roster user repeats the same cases. Then **Transport:** both bot queues receive the broad-delivery updates, but exactly one owner bot sends each valid item view; both bots send nothing for addressed-to-another commands, ordinary anchor discussion, unanchored discussion and the non-roster user; only the typer's own workstation sends one sanitized unknown-item error. **Durable:** both inboxes may retain delivered updates locally, but the silent workstation creates no outbox row, action, receipt, actor, item link or repository write; recognized read-only views create no action or receipt. **Phone/group:** there is never a duplicate answer and the text `That message is not a task question` is never produced in the team group. | T0 fake | must |
| TM-T0-5-25 | T12, migration 25, item identity | migration and compatibility | Given a migration-24 database containing personal and group actors, C1 `task` and `workstation` thread rows in every C1 state, their indexes and referenced outbox anchors, plus pre-upgrade answer cards. When migration 25 runs and runs again on restart. Then **Durable:** `telegram_thread` is rebuilt once so its CHECK accepts `item`; every prior row, id, state, anchor reference and index definition is preserved; C1 resolves the same task/workstation rows after migration; `item_link(item_id PRIMARY KEY, prompt_id, role, epoch, control_head)` exists, maps requester or executor items to local prompts and rejects a duplicate item id; a new item subject uses C1's existing anchor/reply state machine. Applying each pre-upgrade card still records one receipt and resumes at most once. When either workstation starts a new item, one short opaque item id is minted once, persisted in `item_link`, and reused across restart; its group tag is deterministic from that item id, follows C1's tag constraints and is identical on both workstations even where local prompt ids differ. The id and tag contain no local path, user id, bot id, token or credential. | T0 SQLite + fake | must |

The `team` summary audience and `item` thread-registry subject are focused cases in the existing summary and registry test files, as required by engineering plan section 3b. They are implementation cases under TM-T0-5-25 and TM-T1-6, not additional scenario IDs.

## Two-environment T1 rows

| Scenario ID | Covers | Kind | Given / when / then (observable result per layer) | Tier and backend | Priority |
| --- | --- | --- | --- | --- | --- |
| TM-T1-2 | T14, private-chat isolation, default-off regression | authorization and regression | Given jd and Yousef are each paired privately with their own bot. First, with `team.enabled` false by default, when both use their personal question, answer and tap flow and group traffic is sent, then **Phone:** both private flows behave as before and no Team surface or group answer appears; **Durable/Transport:** Team API/runtime operations return the stable `team_disabled` result, neither Team path mutates state, and each private update exists only in its own bot's inbox. Second, with Team explicitly enabled on both, when both private chats block, answer and resume concurrently, then each bot answers only its own person, each answer and receipt applies only on its own workstation, neither inbox ever contains the other's private-chat update, and no private content appears in the group or repository. The affected L1/L3 personal rows pass unchanged in both settings. | T1 fake | must |
| TM-T1-3 | T13, T14, LT-1, read-only item views | group routing and views | Given both bots are administrators and receive all group updates, with open anchors owned separately by jd and Yousef. When either roster person replies to an anchor with `/task`, `/status`, `/access` and `/help`, sends the same commands addressed to the other bot, names an unknown item, writes ordinary anchor discussion and unanchored discussion, and a non-roster member sends all forms. Then **Phone/group:** the owning workstation answers each valid command exactly once from its own bot; `/task` matches the anchor's current team summary; `/status` shows execution, decision and receipt state plus the owning workstation; `/access` shows current access state; `/help` lists only commands available to that person in that item. The command addressed to another bot is ignored, the unknown item gets one sanitized error from the typer's own workstation, and all discussion and non-roster cases get no bot reply. **Durable:** read-only commands create no action, receipt, human response, run, provider spawn or repository write; the non-owner bot creates no outbox row; the forbidden task-question hint never enters an outbox or transport call. **Transport:** both bots demonstrably received each group update before ownership filtering. | T1 fake | must |
| TM-T1-6 | T13, thread lifecycle, team summary | lifecycle, recovery and restart | Given jd starts a thread for a local task. When the item opens, changes state, completes, reopens, and the active anchor is separately deleted before a later update. Then **Phone/group:** opening posts one anchor from jd's bot, pins it once and gives it the item-id tag; every later item message replies to that anchor and carries the same tag; state changes edit the same anchor message in place; completion edits it to the completed summary and unpins it once; reopening posts and pins a new anchor rather than reviving the completed one. In the deletion case, the permanent missing-message edit marks the anchor gone and the next item update posts and pins one replacement, after which later updates edit the replacement. **Durable:** one stable `item_link` survives restart; the active `telegram_thread` has subject kind `item`, the item id and the current anchor outbox row; C1 task/workstation threads are unchanged; failed anchor edits are terminal and do not loop. **Transport:** pin, edit and unpin calls have the owner bot, team chat and expected Bot API message ids, with no duplicate pin/unpin. Every anchor and `/task` rendering uses the `team` summary audience: it is sanitized, identifies the owning workstation and omits provider quota, absolute/local workspace paths, tokens and credentials while retaining the decision-relevant task summary. | T1 fake | must |
| TM-T1-7 | T15, D17, D19, other-person thread request | authorization and confirmation | Given Yousef can identify a jd-owned item but has no authority to publish jd's task summary. When Yousef starts a thread request. Then **Phone/group:** only a request card from Yousef's bot is posted initially; before owner confirmation there is no jd anchor, pin, task summary, local path, quota, question, answer or other item content in the group. **Durable/Repository:** no owner `item_link`, owner item thread, owner action receipt or item control publication exists before confirmation, and retries or duplicate delivery do not create a second request. When jd confirms through an owner-bound, revision-checked action, then jd-laptop mints or accepts the one item identity, creates its link, posts and pins exactly one anchor from jd's bot using the team summary, and the resulting request receipt applies once. A stale, declined, wrong-user or duplicate confirmation shares nothing and creates no anchor. | T1 fake | must |

## T12 to T16 acceptance map

| Task | Required evidence from this table |
| --- | --- |
| T12 migration 25 and item ids | TM-T0-5-25, including table rebuild, preserved C1 rows/indexes/anchors, `item_link`, stable item-id minting and item-derived tags. |
| T13 anchors and read-only views | TM-T1-6 lifecycle and recovery; TM-T1-3 `/task`, `/status`, `/access` and `/help`; focused summary/registry cases under the existing test files. |
| T14 group routing rules | TM-T0-1 and TM-T1-3 under LT-1 broad delivery, plus TM-T1-2 for private-chat isolation. |
| T15 starting another person's thread | TM-T1-7, including the pre-confirmation no-share boundary and applied-once owner confirmation. |
| T16 close-out | Focused T0 rows pass, the full T1 suite passes unchanged, all four TM2 T1 rows pass three repeats, and the implementation record gives exact commands and counts. |

## Burn-in and close-out

The TM2 burn-in is explicit and contains exactly the new T1 rows below. Each row runs three times in the two-environment fake harness; success is **12/12**, with no retries hidden as passes.

| Burn-in row | Repeats | Required result |
| --- | --- | --- |
| TM-T1-2 | 3 | 3/3 |
| TM-T1-3 | 3 | 3/3 |
| TM-T1-6 | 3 | 3/3 |
| TM-T1-7 | 3 | 3/3 |
| Combined TM2 burn-in | 12 tests | 12/12 |

Before T16 is complete, run the migration/routing T0 cases, the full server suite, the full T1 suite, the four-row burn-in and the Team-scoped coverage check available at that point. Record exact commands and counts in `implementation.md`. The tracked token sweep must find no credential in database state, API responses, logs, fake transcripts, repository refs or committed fixtures. No live Telegram check is due in TM2; LT-4 remains the real thread-and-grant check after TM3.

At T11, the repository coverage-matrix parser recognizes only `S-*` scenario ids. A `--scope TM --tiers T0,T1` static run therefore reports zero scenarios; it is not evidence that these rows are implemented. T11 separately checks the Markdown table structure and exact TM2 id set. T16 must not claim a matrix pass for `TM-*` unless the parser or an equivalent Team-aware check exists then.

## Skim authorization

JD's standing operator instruction is to continue through Team tasks without waiting at task boundaries, and the T11 task card explicitly directs that instruction to be recorded as this table's skim authorization. T11 may therefore become ready to merge after its documentation checks; this authorization does not approve a changed design or any new default.
