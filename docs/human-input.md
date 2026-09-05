# Answering a waiting agent

Open **Review and respond** from the blocked Pipeline banner or the task's
Overview. **Tasks → Needs you** includes unanswered handoff questions, even when
an earlier answer reset the underlying task to TODO.

The panel shows the latest question and its required action. You can:

- **Answer question** and continue the owning pipeline.
- **Ask for clarification** without executing the task. The reply appears in
  the conversation and the pipeline stays paused.
- **Change instructions** to record an explicit correction that supersedes
  conflicting earlier task instructions.

Drafts are saved per workspace and task in this browser. Closing the panel does
not discard them. Conversation history is stored on the server. Keep credentials
in provider or project settings rather than in a draft.

When continuation cannot start, the answer stays saved and the panel provides
**Continue with saved answer**. Retries reuse the saved answer. Named and suite
pipelines retain their assigned agent; standalone tasks use the selected agent.
A pipeline interrupted by a server restart can also continue through this flow.

## Verification

`server/src/humanInput.test.ts` covers unanswered handoffs, named pipeline
continuation, restart recovery, duplicate submissions, and startup failure/retry.
Run database-backed tests in an isolated copy: the server database path is
relative to its repository root.

`scripts/verify-human-input.cjs` exercises the UI through an installed Playwright
module and a browser CDP endpoint. Supply a waiting prompt and its pipeline:

```sh
node scripts/verify-human-input.cjs --playwright /path/to/playwright \
  --cdp http://127.0.0.1:9227 --prompt 19 --pipeline 5 \
  --artifacts /tmp/human-input-checks
```

It reads the fixture from the running app and intercepts all API writes. It
checks both entry points, attention, drafts, clarification, instruction changes,
saved-answer retry, mobile layout, and keyboard dismissal without starting a
real agent.
