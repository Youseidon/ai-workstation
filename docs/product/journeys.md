# Journeys

| | |
|---|---|
| Status | Baseline specification |
| Audience | Product owner, business analyst, designer |
| Depends on | [Business requirements](business-requirements.md), [domain model](../domain/domain-model.md) |

Each journey is a specification of operator experience. The main path is what the product is for. The alternate paths are requirements, not edge-case notes. Acceptance is written so a product owner can watch the journey without reading code.

The actor is the **operator** unless a journey says otherwise. The machine is the host that runs Hydra. Provider logins happen on that host.

## JR-01 First task

**Trigger.** A new account, one provider already connected, no workspace yet.

**Main path.**

1. Every page offers workspace setup and does not pretend a project is selected.
2. The operator creates a workspace aimed at an existing directory and can read the absolute path before saving.
3. They open Chat, choose the provider and a model, choose Ask, and send a question.
4. Text arrives incrementally. Tool calls can be expanded. Elapsed time advances from the server.
5. They send a second turn in the same thread. The provider session resumes.
6. They switch to Run and send a small change with a clear finish. The agent works in that directory. The operator can open the resulting change from the run.

**Alternates.**

- The directory does not exist: save is refused and the path remains editable.
- The provider is unavailable: the composer says why, and send does not start a run that immediately fails in silence.
- The operator closes the laptop lid's worth of browser: the run continues. Reopening the console shows it.
- The operator presses Stop: the run ends as interrupted, and Telegram does not announce it as a failure.

**Acceptance.** A person who has never opened the provider's terminal can complete an Ask and a Run, and can point at the run that produced the edit.

## JR-02 Connect a provider

**Trigger.** The operator wants an agent that is not ready.

**Main path.**

1. Agents shows the provider, its enabled flag, its install state, its ready state, and its effective model.
2. If the executable is missing and Hydra can install it, the installation owner installs it. The screen shows the fixed source before installation. Closing the dialog does not cancel an install in progress.
3. The operator follows the connection instruction. A CLI login is run on the host. A website session alone does not count.
4. Alternatively they save an API key. The browser shows that a key is set and never shows the key again.
5. They refresh detection, enable the provider, and return to Chat. The provider can be selected.

**Alternates.**

- The operator is not the installation owner: install and update of shared executables are refused, with guidance to ask the owner or install on the host themselves.
- The provider has a live run: update is refused.
- Detection cannot see a credential store: the provider's "assume authenticated" setting is the explicit override, not a silent success.
- A brand-new account: keys in the owner's `.env` are not inherited. The new account saves its own.

**Acceptance.** After a successful connection the provider is selectable. After a failed connection the reason is on the card. Install does not flip the enabled flag by itself.

## JR-03 Author a program

**Trigger.** The operator has a brief and would rather not type every work item.

**Main path.**

1. They ask an agent to draft a program. The author run holds the workspace writer lock and is allowed to read the project. Its instruction to leave the project unchanged is a brief. It is not a sandbox promise, and the UI does not claim otherwise.
2. A draft appears: suites, work items, dependencies, verification blocks.
3. The operator renames, rewrites, reorders, and fixes dependencies. Nothing is in the library yet.
4. They choose Create program, and may also create a pipeline.
5. The program is in the workspace library. The draft is applied.

**Alternates.**

- The author run is stopped: the partial draft remains and a later run may continue it.
- The operator chooses Revise: the draft updates; the library does not.
- The operator discards: the library does not change.
- Validation fails on apply: nothing is inserted.
- They want a different agent's opinion later: a new draft, not an in-place mutation of an applied program, unless they are revising a draft that targets an existing program and then apply.

**Acceptance.** At no moment before Create program does the library contain the proposed suites. After Create program, a pipeline built from the draft can be opened and assigned.

## JR-04 Import a pack

**Trigger.** A prompt pack already exists as files.

**Main path.**

1. The operator submits the pack for inspection.
2. The preview shows manifest, suites, prompts, dependencies, and gates.
3. They apply. The stored content is a copy. Later edits to the source files do not change the library, and later edits in the library do not change the source files.

**Alternates.**

- The preview is wrong: they do not apply. The library is unchanged.
- Keys collide with existing external keys: apply is rejected with the collision identified.

**Acceptance.** Apply is one action. A failed apply does not leave half a suite.

## JR-05 Away from the desk

**Trigger.** A pipeline may need a decision while the operator is not at the console. Telegram is optional; this journey specifies the product when they turn it on.

**Main path.**

1. The installation owner creates a dedicated bot and saves the token once. The browser does not show the token again.
2. The operator connects Telegram, opens the single-use link within 10 minutes, and presses Start. Access is notifications only.
3. A station asks a question. Telegram delivers a summary and the question. The console's Needs-you list shows the same wait.
4. The operator enables full control, confirms an action from a button, and sees the action in recent Telegram activity. The action runs as their account.

**Alternates.**

- The link expires: they generate another. The old one does not work.
- The Telegram user is already linked to another Hydra account: the new link is refused.
- A message arrives in a group, or from an unlinked user: the bot ignores it.
- The operator only wanted notifications: they never enable full control, and previously imagined buttons do not exist. If they later lower access, old buttons stop working.
- They are in the development sandbox: the copied bot does not poll.
- The question was already waiting when the console started: `/gates` still lists it.

**Acceptance.** A notification contains no transcript, diff, or file body. A control action requires confirmation and appears in the audit list. An intentional Stop does not arrive as a failure notification.

## JR-06 Review the change

**Trigger.** A writable work-item run has finished or has checkpointed.

**Main path.**

1. The operator opens Changes for that run.
2. They see the base commit, the head, the commit list, and the file totals.
3. They read a unified or side-by-side patch.
4. Activity and the work item link to the same capsule.

**Alternates.**

- The agent tries to post done with a dirty tree: the handoff is refused and the agent is told to checkpoint.
- The operator had their own uncommitted edits before the run: those edits are not inside the agent's commit. If the tree was dirty at start, the run was refused (JR-01 alternate for saved work; a custom Run is specified separately in the execution model and still must not sweep stranger changes into its checkpoint).
- The branch was rewritten so the leftover work cannot be committed for the run: the pipeline waits with that reason. Hydra does not reset the branch.
- Git history is unavailable: the capsule state says so.

**Acceptance.** For a clean start, every commit in the capsule is reachable from the recorded head and descends from the recorded base. The operator can navigate from the work item to the patch and back.

## JR-07 Second account

**Trigger.** Another person, or the same person wearing another hat, needs a login on this installation.

**Main path.**

1. They register. The account is empty.
2. They create their own workspace and their own provider keys.
3. They cannot list the first account's workspaces, threads, pipelines, or settings.
4. Signing out of one browser session does not sign out the other account.

**Alternates.**

- They point a workspace at a directory the first account also uses: the application allows the binding, because accounts do not own OS directories. A writable run is refused while the other account holds the Git lock.
- They expect the owner's API keys: they are absent. The Agents screen is where this account sets its own.
- They are the installation owner signing into the original account: the original library is present. Ownership was not taken by the newer registration.

**Acceptance.** Account B's application database and settings file are distinct files from account A's. No screen in account B renders account A's run transcript.

## JR-08 Forgotten password

**Trigger.** The operator cannot sign in, and they are still the person at the machine or the person with the linked Telegram chat.

**Main path, at the host.**

1. They run the local reset command with the username.
2. They enter the new password twice. It is not echoed and not placed on the command line.
3. Other sessions of that account die. They sign in with the new password.

**Main path, from Telegram.**

1. On the sign-in screen they request a code for an account that has Telegram connected.
2. The eight-digit code arrives in the private chat, works once within 10 minutes, and fails closed after five bad guesses.
3. Setting the password revokes other sessions.

**Alternates.**

- They delete the identity registry hoping it will reset a password: that is not a recovery path. The specification forbids treating registry deletion as recovery, because it destroys the ownership mapping and every account.
- The demo account: there is no password to reset. Sign-out already abandoned it.
- They do not have the host and do not have Telegram: the product has no email reset. This is a boundary, not a missing screen.

**Acceptance.** Reset does not require stopping the console. The new password is not written to shell history by the command. The identity registry is still the same file afterwards.

## JR-09 A parked pipeline

**Trigger.** A station did not finish inside its allowance, or it is waiting on the operator.

**Main path.**

1. The board shows the pipeline waiting, with a reason in the language of the execution model (continuations exhausted, human question, provider unavailable, dirty tree, no provider, and the other stated reasons).
2. The operator opens the station, reads the conversation and the evidence, and decides.
3. Resume records that decision and, for an ordinary station parked on continuations, grants a fresh allowance. The same working tree is used.
4. If they need the run to stop, they use Stop. A sentence in the prompt is not a substitute.

**Alternates.**

- Pause: the current agent finishes; nothing new starts. Immediate pause is the policy that interrupts instead.
- Force-stop agent: the agent stops and the station pauses. Resume does not spend a continuation for that interruption.
- The operator presses Play on a new run after completion: finished stations stay finished. The new run picks up unfinished work.
- A fallback is desired: they enable automatic reassignment or assign another provider. With reassignment off, a cooling or exhausted provider waits.

**Acceptance.** The parked reason on screen matches the reason a later reader finds on the run. Resume does not mark the station done. Stop stays stopped across a server restart.

## JR-10 Supervised allowance

**Trigger.** One requirement is larger than a single station's ordinary continuation budget, and the operator wants a capped supervisor.

**Main path.**

1. They record the requirement, the done criteria, and limits for attempts, active time, tokens, and a deadline.
2. They start in shadow mode and read the decisions the supervisor would have taken.
3. They enable the supervisor and Play. Work units, accepted work, recovery, and deferred verification are tracked against the contract.
4. The allowance runs out. The pipeline parks with the work preserved. They approve a new allocation with a reason. Usage, accepted units, and recovery history remain.

**Alternates.**

- The provider reports no token count: the full worker reservation is consumed. The report does not pretend the usage was zero.
- They try to Resume an exhausted contract without a new allocation: Resume does not renew it.
- A replan is proposed: accepted units stay accepted. Targets still in scope are not dropped.

**Acceptance.** Shadow mode writes no live dispatch. A reviewed allocation is visible as an operator decision with a reason. The deadline, once past, refuses a policy that still claims it is in the future.

## JR-11 Ask while a writer runs

**Trigger.** A writable run holds the workspace, and the operator wants a second opinion.

**Main path.**

1. They open another conversation and choose Ask.
2. The consultation runs, up to three at a time, while the writer continues.
3. A fourth consultation, or a second writer, is refused with a reason that names the lock.

**Alternates.**

- The Ask is about the same Git repository from another account: the consultation may proceed as read-only, but a second writer is refused by the repository lock.
- They need the writer to hear the aside: they use `/btw` on the running thread, not a second Run.

**Acceptance.** The writer's lock is unchanged by an Ask. Refusal names the limit the operator hit.

## JR-12 Demo and tour

**Trigger.** A person wants to see the console before they trust it with a real repository, or a new account wants to be shown around.

**Main path.**

1. From sign-in they choose Try the demo, unless demos are disabled.
2. An account appears and fills while they watch: a real sample Git project, conversations, a stopped pipeline, a station waiting on them, activity, and committed changes.
3. The tour starts. Stops ask them to do the real gesture: open a thread, switch to Ask, open a diff.
4. Escape pauses the tour. The sidebar resumes it or jumps to a chapter. Progress is stored in the browser for that account.
5. They can also run a connected agent inside the sample project. That uses the host's real provider login and costs what that provider costs.

**Alternates.**

- They sign out: the demo cannot be signed back into.
- They remove the demo marker and keep the folder: expiry deletes the account and does not delete the folder.
- A normal new account: the tour is offered once and remains available from the sidebar.

**Acceptance.** The diffs in the demo are real commits in the sample repository, not painted text. The demo account never gains a Telegram connection.

## Journey index

| Id | Operator can say |
|---|---|
| JR-01 | "I pointed it at a repo and watched an answer arrive." |
| JR-02 | "I know why this agent is or is not ready." |
| JR-03 | "Nothing entered my library until I pressed create." |
| JR-04 | "I saw the pack before it was copied in." |
| JR-05 | "My phone told me, and it did not receive the diff." |
| JR-06 | "That commit belongs to that run, and my own edits were not in it." |
| JR-07 | "The other login started empty." |
| JR-08 | "I reset the password without deleting the registry." |
| JR-09 | "It parked for a reason I can read, and resume did not call it done." |
| JR-10 | "Shadow mode did not spend the allowance." |
| JR-11 | "I looked something up without starting a second writer." |
| JR-12 | "The sample was real Git, and leaving the demo abandoned it." |
