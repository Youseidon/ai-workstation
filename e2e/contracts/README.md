# Recorded provider and Telegram shapes

Contract fixtures that the harness fakes are checked against (docs/e2e-harness-plan.md 4.3 and 4.2).

- `grok-1.0.5-streaming-json.ndjson`: the `grok -p --output-format streaming-json` event shapes documented in `server/src/adapters/grok.ts`, which were verified against grok 1.0.5.
  Grok is not installed on the operator's machine, so this is the adapter's recorded sample rather than a fresh capture; re-record it with a real `grok` when one is available.
