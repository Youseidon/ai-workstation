# Security and tenancy

| | |
|---|---|
| Status | Baseline specification |
| Audience | Solution architect, developer, database administrator |
| Depends on | [Solution architecture](solution-architecture.md), [domain model](../domain/domain-model.md) |

Hydra is a local tool for trusted users of one machine. This document specifies the controls that sentence requires, and the controls it deliberately does not claim.

## 1. Trust boundaries

```text
[ Browser of account A ]
        |  cookie, HTTPS-or-localhost, allowed origin
        v
[ Gateway ] ----identity registry----
        |  gateway credential, never sent to a child
        v
[ Runtime of account A ] ----account database and settings----
        |  run-scoped credential
        v
[ agent-step and the provider child ]
        |
        v
[ Workspace directory, as the OS user that started Hydra ]
```

| Boundary | What crosses it | What shall not cross it |
|---|---|---|
| Browser to gateway | Account session cookie, application JSON, WebSocket messages | Provider keys, password hashes, session token hashes, bot token, run credentials, database paths |
| Gateway to runtime | Authenticated account id and the gateway credential | Another account's requests |
| Runtime to child | The task, the workspace path, the run credential for `agent-step`, the provider's own environment | `HYDRA_DB`, `HYDRA_DATA_DIR`, `HYDRA_DATABASE_PATH`, `HYDRA_WORKER_SECRET` |
| Runtime to Telegram | Summaries, states, errors, questions, confirmed-action tokens | Transcripts, diffs, file contents, keys |
| Account A to account B | Nothing through the API | Any row of B's database, any key in B's settings |

**Decision SEC-01.** The tenancy boundary is the account. The isolation mechanism is a separate database, a separate settings file, and a runtime that rejects unauthenticated application traffic. The operating-system user is shared unless the operator deploys separate OS users or containers themselves.

That deployment choice is outside the product. The product shall not pretend the account boundary is an OS boundary. Documentation shown to the operator says this in the same place it explains accounts.

## 2. Assets

| Asset | Where it lives | Sensitivity |
|---|---|---|
| Password | Identity registry, scrypt hash and salt only | The hash is still a secret. |
| Session token | Browser cookie. Registry stores SHA-256. | Possession is sign-in until expiry or revocation. |
| Gateway credential | Runtime environment, not the database | Possession admits traffic to a private runtime. |
| Run credential | Issued per agent run, hash stored on the run, short-lived | Possession allows that run's callback verbs only. |
| Provider API key | Account settings file, or the owner's settings file. Plain text. Mode `0600`. | A key is a provider credential. |
| CLI login | The host user's provider credential store | Shared by every account in that OS user. |
| Bot token | Identity registry | Possession of the token reads the bot's chats. |
| Transcripts and diffs | Account database and the workspace Git | The operator's source code and the agent's reasoning. |
| Telegram link | Identity registry | A route to the operator's private chat. |

**Decision SEC-02. Keys are write-only in the product UI.** A client can read a boolean "is set". It cannot read the value back. Settings files remain plaintext because the provider child must be able to use the key. Operators who do not want keys on disk use the provider's own CLI login. The specification prefers that path and does not build a second secret store.

## 3. Authentication

**Passwords.** Scrypt with a random 32-byte salt, parameters N = 32768, r = 8, p = 3, and a 64-byte output. Comparison is constant-time. The verifier still runs a derive when the account is missing, so a missing username does not return faster than a wrong password by skipping the hash. Passwords shorter than 12 or longer than 1024 characters are rejected.

**Sessions.** 32 random bytes, base64url, delivered in an HttpOnly, SameSite=Strict cookie. The registry stores only the SHA-256. Lifetime is seven days. Expired rows may be deleted when a new session is created. Sign-out deletes the presented session. Password change and password reset delete every session for that user.

**Secure cookie flag.** Off by default so a loopback HTTP deployment works. An operator who terminates TLS sets `HYDRA_SECURE_COOKIES`. The flag shall not be implied merely by a non-loopback bind.

**Rate limits.** Registration, sign-in, recovery request, and recovery submission shall be rate limited. The limit is per installation, not an honour system in the browser.

**Authorisation.** There is no role inside an account. The installation owner is a flag with two extra powers: ownership of the original database, and install or update of shared provider executables. Every other application operation is "this session's account, this account's rows".

## 4. Account lifecycle

| Event | Specified result |
|---|---|
| First-ever registration on an empty registry | A normal empty account. It does not become the owner and it does not attach the original database. |
| Registration when an owner already exists | Empty account, private database, private settings, built-in defaults. |
| Owner sign-in | The original database and `.hydra/settings.json`. |
| Demo creation | An account row plus a demo expiry. No password that can be used to return. No Telegram. |
| Demo expiry | Delete the identity, the private state, and the sample directory if and only if the demo marker is intact. |
| Password reset | Update hash and salt. Delete sessions and outstanding reset codes. Do not touch the application database. |

**Decision SEC-03.** Deleting or replacing the identity registry is not a recovery procedure. Recovery is the local reset command or the Telegram code. A restore is a restore of the registry together with the account databases it points at.

The local reset command opens the registry only, can run while the console is up, prompts twice without echo, and honours `HYDRA_DB` when state is not in the default place.

Telegram recovery: eight digits, 10-minute expiry, single success, five failures, resend no sooner than 60 seconds. The code is hashed at rest. The account must already have a Telegram link. The bot will only deliver it to that linked private chat.

## 5. Session and browser

- Application HTTP and the WebSocket require a live session. A missing or revoked session is an authentication failure, not an empty payload.
- Allowed origins are an explicit list, defaulting to the local web origins. A reflection of the request origin is not the policy.
- Browser storage keys are prefixed `hydra.` and are scoped so one account's drafts are not another's on a shared browser profile.
- The web application has no connection string.

## 6. Gateway and runtimes

Private runtimes shall refuse application traffic that arrives without the gateway credential. The credential is created for the installation and is scrubbed from every child environment.

Agent callbacks shall refuse a request whose run credential does not match the hashed credential of a live run, or whose verb is not in the allow-list, or whose run id does not match the credential. A callback cannot name a different account, a different workspace, or a different run and have the runtime honour it.

**Decision SEC-04. Scrub list is closed and shared.** The variables removed from child environments are `HYDRA_DB`, `HYDRA_DATA_DIR`, `HYDRA_DATABASE_PATH`, and `HYDRA_WORKER_SECRET`. Every spawn path that builds a child environment includes this list: the provider adapters that spawn, the shared spawn adapter, resource containment, and verification commands. A new variable that points at Hydra state or that authenticates a runtime is added to all of those paths in the same change. A new spawn path copies the list. It does not grow a shorter one.

## 7. Agents as a threat

The agent runs as the same OS user as Hydra, inside a directory the operator chose, with the permission mode that provider is configured for. From that position a hostile or confused agent can read files that OS user can read, including a settings file mode `0600`.

The product controls are:

| Control | What it is for |
|---|---|
| Workspace choice | The operator binds a directory on purpose. The console does not pick one. |
| Ask versus Run | Consultations are specified as read-only. Writable runs are explicit. |
| Writer lock and Git lock | Limits concurrent damage. Does not limit a single writer. |
| Permission mode and provider sandbox | Whatever that provider actually enforces. Hydra records the mode on the run. |
| Station capabilities | A station may forbid edits, builds, contract generation, or verification. For Cursor, a protected station requires the native sandbox and command hooks, and the run is refused if enforcement cannot be verified. |
| Budgets | Caps on wall clock, tool calls, repeated identical calls, tool output, and estimated spend. |
| Containment | Memory, swap, and process ceilings when the host can enforce them. |
| Checkpoint gate | A terminal handoff cannot land while the tree is dirty. The commit message is constrained. |
| Callback allow-list | The agent does not get a SQL prompt. |
| Environment scrub | The agent is not handed a path to the console's database. |

**Decision SEC-05.** These controls are not a claim that running an agent is safe. The operator manual and this specification both say: choose OS isolation to match the trust level required. The product shall not grow a banner that calls a prompt, a hook, or a memory limit a sandbox for arbitrary repository code.

Verification commands from a definition of done are server-run shell commands in the workspace. They are an operator-authored capability, equivalent to the operator running that command. They inherit the scrub list. They do not inherit a need to read Hydra's database.

## 8. Telegram

| Rule | Requirement |
|---|---|
| Transport | Outbound long polling. No inbound listener, no webhook URL, no extra open port. |
| Bot | One bot per installation, token stored in the registry, not redisplayed. |
| Binding | Single-use link code, 10 minutes, one Telegram user to one Hydra account. |
| Audience | The linked user, in that private chat. Groups and other users are ignored. |
| Default access | `notify`. `control` is opt-in. |
| Payload | Summaries and questions only. No transcripts, diffs, or file bodies. |
| Actions | Confirmation required. Executed as the linked account's runtime. Audited. Buttons expire after 15 minutes. |
| Poller | The live console only. A sandbox copy does not poll. Replacing the token drops every link. |

Telegram chats are not end-to-end encrypted by this product. The specification treats message bodies as visible to Telegram. That is why the payload rule exists.

## 9. Data at rest

- Identity registry, account databases, their WAL and SHM sidecars, and settings files are mode `0600`. Directories that hold them are mode `0700`.
- The default location is under `$XDG_STATE_HOME/hydra` or `~/.local/state/hydra`, outside the source checkout.
- A configured database path inside a workspace directory is refused.
- Backups are the operator's copies of those files. A backup is as sensitive as the database, because keys in settings are plaintext and transcripts are source-adjacent. Backup guidance is in the [data design](../data/data-design.md).

## 10. Abuse cases the design is required to resist

| Case | Required outcome |
|---|---|
| Guessing passwords | Slow hash, rate limit, no user-existence timing leak from skipping scrypt. |
| Stolen cookie from another site | SameSite=Strict and an explicit origin list. |
| Account B asks for account A's run id | The runtime for B has no such row. The gateway does not route B at A's database. |
| Agent prints the environment looking for the database path | The scrubbed variables are absent. |
| Agent calls the callback with another run's id | Credential mismatch. Refusal. |
| Forged Telegram update from a group | Ignored. |
| Replay of a spent recovery code | Rejected. |
| Pipeline resume after the operator pressed Stop | Does not happen. |
| Demo account reused after sign-out | No password, no session to resume. |
| Second process serving the same live database | Refused by the instance lock. |
| Model over the ceiling via fallback or author role | Refused. The ceiling is server-side. |

## 11. Abuse cases the design does not claim to resist

| Case | Why it is out of scope |
|---|---|
| A malicious agent reading the settings file as the same OS user | File mode does not stop the owner of the file. Use another OS user. |
| A malicious operator who already has a shell on the host | They can read state files they own. The product is not a defence against the host's administrator. |
| A malicious provider CLI | The CLI is trusted with the prompt and the workspace by the act of running it. |
| Supply chain of the checkout's dependencies | Ordinary maintenance. Not a Hydra product control. |
| Exfiltration through a tool the agent is allowed to run | The network path of an allowed tool is the operator's permission mode. |

## 12. Logging

- Server logs may contain operational errors and the tail of a child failure.
- Server logs shall not contain passwords, session tokens, provider keys, the bot token, gateway credentials, or run credentials.
- The browser's run transcript contains the agent's text and tool traffic, because that is the product. It is account data, not a log file shipped elsewhere.
- Database-access events in the transcript record the callback verb, the outcome, and a short summary. They are there so the operator can see what the agent asked Hydra to do.

## 13. Requirements trace

| Control | Requirements |
|---|---|
| Empty new account, owner flag | BR-01, BR-03, INV-24 |
| Session and reset | BR-02, BR-04, NFR-02, NFR-03 |
| Write-only secrets | BRULE-06, SEC-02 |
| Child scrub | BRULE-08, SEC-04 |
| Telegram payload and binding | BR-64 |
| Demo cannot return or link | BR-05, INV-23 |
| Callback confinement | ADR-13, SEC-04 |
