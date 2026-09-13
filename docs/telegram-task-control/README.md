# Telegram task control and teammate takeover

Design baseline: 2026-09-13. Status: local answer-control foundation implemented;
Telegram and teammate transfer are not implemented. See
[implementation status](implementation.md#0-current-implementation-status).

This enhancement lets a person control their own workstation tasks through
Telegram and ask a teammate to continue a task on the teammate's computer.
The first audience is one trusted internal team. Personal subscription allowance
is the requested execution source; availability of a supported delegation method
is a release gate, not an established capability.

## Read in this order

1. This document: scope, decisions, architecture and boundaries.
2. [User flows](user-flows.md): exact choices, waiting behaviour and exceptions.
3. [Protocol](protocol.md): identity, records, concurrency and runtime contracts.
4. [Implementation and acceptance](implementation.md): code mapping, rollout,
   failure tests and release gates.
5. [Executable engineering plan](engineering-plan.md): baseline classification,
   traceability and dependency-ordered milestones.
6. [Engineering standards](../engineering-standards.md): repository code-change
   standards and execution contract.

MUST and MUST NOT are requirements. Defaults are concrete implementation choices
selected to complete the design, not claims that the user supplied every value.
Changes to an accepted decision require a documented design revision. A release
gate MUST disable the affected capability until evidence satisfies it; an
implementer MUST NOT silently substitute a different product or weaker guarantee.
Protocol rules take precedence over illustrative UI wording.

## Accepted decisions

| ID | Decision |
| --- | --- |
| D01 | Keep the UI, backend, database, agent execution and LLM credentials local to each workstation. |
| D02 | No custom central relay is required in the baseline. Each workstation uses its own Telegram bot in a shared task conversation. |
| D03 | Telegram control covers personal tasks and pipelines, not just team handoffs. |
| D04 | Use one task topic in a private project group where the audience is appropriate. Link a separately created private group when task membership must be narrower. |
| D05 | Publish versioned project state and continuation context through a private Git remote. Do not use one network-mounted working directory or share a live SQLite file. |
| D06 | Keep packaging, publication, receipt and result return in one Task Transfer module. |
| D07 | A low-quota estimate, initially 5% remaining, prompts for direction. It MUST NOT automatically pause, switch provider, spend extra money or request takeover. |
| D08 | An invited receiver's acceptance authorizes the task to start on that receiver's workstation. No second approval from the requester. |
| D09 | Compare requested access with the receiving workspace's locally configured permissions. Continue within those permissions; ask locally only for additional access. |
| D10 | The requester owns requirement decisions; the executor owns local access, provider and allowance decisions. Discussion alone grants neither authority. |
| D11 | Provide Save answer and Answer and resume. Saving alone does not restart work. |
| D12 | The requester reviews and applies returned work before the original pipeline continues. |
| D13 | Keep the same shared conversation across blockers, revisions and subsequent takeovers. Preserve the original requester and task identity. |
| D14 | Personal-subscription execution is the first product objective. Do not silently replace it with paid API execution. |
| D15 | Internet-connected Telegram is not evidence that a workstation is online. Never label a request accepted, running or stopped without the corresponding durable acknowledgement. |

Superseded ideas: a centrally hosted full app, a mandatory relay, Git as the human
chat interface, automatic stopping at 5%, a mandatory second takeover approval,
and automatic application of returned changes are not this design.

## Architecture and service responsibilities

These are logical modules, not separate deployments.

```text
Requester workstation                         Executor workstation
  UI + local database                           UI + local database
  Telegram adapter <---- Telegram topic ----->  Telegram adapter
  Task control                                  Task control
  Quota advisor                                 Quota advisor
  Task transfer <------ Private Git -------->  Task transfer
  Local agent runner                            Local agent runner
```

| Block | Why it exists | How it works |
| --- | --- | --- |
| Telegram adapter | People can answer and control tasks away from the UI. | Receives its bot's updates, associates messages with decisions, and renders acknowledged state. |
| Task control | Chat messages do not establish valid execution transitions. | Checks actor, task revision, permission scope and command identity; stores questions, approvals and receipts locally. |
| Quota advisor | Warn before an unexpected provider stop. | Observes available quota telemetry, qualifies its freshness, and opens an advisory decision without changing execution. |
| Task transfer | Another computer needs both files and working context. | Creates and validates checkpoints, publishes shared control records, fetches assignments and returns reviewed results. |
| Existing execution engine | Continue using local provider installations. | Runs a linked local task in an isolated checkout under the recipient's effective permissions and reports observed outcomes. |

The Git remote supplies shared durable storage and ordered updates to each task's
control branch. Telegram supplies message delivery. Neither stores provider
credentials. Local apps implement the coordination rules. The design is
relay-free, not independent of shared infrastructure.

## What owns the truth

| Information | Authority |
| --- | --- |
| Personal task, decisions and pipeline | The existing local workstation database, extended with task-control records. |
| Shared assignment, revision, decisions and acknowledged return | The validated control history for that task in Git; local copies are caches. |
| Actual process state and current unpublished files | The current execution workstation. Remote displays report the last observation and its age. |
| Transferable files and context | The immutable published package referenced by the control history. |
| Original task acceptance and pipeline progression | The originating workstation, after the requester's Apply action. |
| Human discussion | Telegram; only explicitly submitted task answers/instructions enter execution context. |
| Local permissions and provider authorization | The receiving workstation's trusted configuration, never an incoming package. |

The original pipeline remains held during delegation. A receiver runs the one
linked task, not a copied pipeline or a second authoritative task database.

## First-release boundaries

- One trusted team; one named receiver per offer. A topic may be visible to other
  authorized teammates, but volunteering does not claim execution. Open bidding
  is a later feature, not a hidden second approval in the named-receiver path.
- One bot per registered workstation. Multiple devices for one person need
  explicit IDs and routing; do not clone bot tokens or workstation identities.
- Personal use requires no Git remote. Cross-workstation tasks require an
  enrolled private remote and published packages.
- Workstations use outbound Telegram polling and Git fetch/push. Do not expose
  the current unauthenticated local HTTP/WebSocket interface to the internet.
- Handoffs preserve an approved checkpoint, not every live keystroke, process
  memory, hidden model reasoning or an exact provider session.
- The requester's computer may go offline after the release/package is published.
  The executor can receive requirement answers through its own bot. Applying the
  result and advancing the original pipeline wait for the requester workstation.
- If a bot's workstation is offline, its buttons cannot be processed immediately.
  Durable shared records support recovery; Telegram history alone cannot.
- Ordinary Telegram chat and project topics are not confidential per-task access
  boundaries. All group members must be eligible to see the published summaries.

## Defaults chosen for this baseline

| Setting | Default and meaning |
| --- | --- |
| Feature enablement | Off until explicit local setup; notifications and execution controls configured separately. |
| Quota warning | 5% estimated remaining in any applicable reported limiting window; no automatic stopping. |
| Quota freshness | Older than 120 seconds is stale; do not claim a current percentage. |
| Approval validity | 24 hours to start or explicitly resume the approved revision. Expiry does not terminate an already running authorized attempt. |
| Telegram polling | 25-second long poll; save updates before advancing the polling offset. |
| Shared-record discovery | Every 5 seconds while team integration is enabled and online; failures back off with jitter to at most 60 seconds. |
| Shared status | Publish milestones immediately and an observation at most once per 60 seconds while active; older than 180 seconds displays status unknown. |
| Notifications | One quota warning per window/reset identity; update existing status messages; no periodic reminder escalation by default. |
| Telegram content | Locally approved task title/summary, structured questions and sanitized evidence. No automatic raw transcripts, source files, environment dumps or credentials. |
| Retention | No new automatic purge in the first release. Existing shared Git history persists; topic closure does not promise deletion. A team retention policy is required before an enterprise release. |

These intervals are product defaults, not uptime or delivery guarantees. Respect
provider/Telegram throttling. An offline worker does not automatically lose its
execution ownership. Runtime and spend limits remain the local approved limits;
the example 30-minute allowance discussed earlier was not an agreed universal cap.

## External constraints and unresolved release gates

The architectural decisions above are settled. These evidence-dependent matters
are deliberately not invented:

| Gate | Required evidence | Behaviour until resolved |
| --- | --- | --- |
| G01: subscription delegation | Provider-supported way for an owner-operated worker to perform another teammate's task under the applicable subscription; identify actual quota/billing bucket. | Disable that provider's teammate-sponsored execution. Personal notifications and same-owner control can still be built and tested. |
| G02: permissions and secrets | Selected provider/runtime can enforce required local limits and protect control-plane credentials from task tools. | Disable unattended team execution for an uncertified adapter/configuration; do not bypass controls or substitute API billing. |
| G03: remote integrity | Git host protects control refs from force updates/deletion; device identities and signatures are verified. | Disable cross-workstation execution; retain personal use and local package preview. |
| G04: governance | Team chooses acceptable data audience, storage location, retention and operational owner. | Use conservative previews during development; do not claim enterprise deployment readiness. |

Claude is the initial feasibility candidate because it motivated the request;
this does not establish Claude subscription delegation as supported. Anthropic's
consumer terms restrict sharing credentials and making an account available to
others. Its authentication documentation describes login methods, not approval
of this product's delegation model. Owner consent and a working login alone do
not satisfy G01. [Consumer terms](https://www.anthropic.com/legal/consumer-terms),
[authentication](https://code.claude.com/docs/en/authentication).

## Sources checked on 2026-09-13

- [Telegram updates](https://core.telegram.org/bots/api#getting-updates): pending
  bot updates are retained for no more than 24 hours.
- [Telegram polling](https://core.telegram.org/bots/api#getupdates): receive and
  acknowledge updates without exposing a webhook on a workstation.
- [Telegram callbacks](https://core.telegram.org/bots/api#callbackquery): button
  responses belong to the bot that emitted the relevant message.
- [Telegram topics](https://core.telegram.org/bots/api#createforumtopic): creation
  in a forum group requires the bot's topic-management administrator permission.
- [Group topics](https://telegram.org/blog/topics-in-groups-collectible-usernames#topics-in-groups):
  topic organization does not supply separate group membership.
- [Git push](https://git-scm.com/docs/git-push): competing non-fast-forward branch
  updates are rejected; server-side restrictions are needed against forced rewrites.

Implementation must recheck affected provider capabilities rather than treating
this date-stamped specification as perpetual upstream documentation.
