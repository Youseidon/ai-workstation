# Load these stations into the console

Do **not** re-import the `backend-transition` program pack (it already exists).
Do **not** resume S8-01 (prompt id 63).

The live database is `~/.local/state/agent-console/console.sqlite`. Copy it before
mutating (`HANDOFF.md` hazard 2). `POST /api/suites/:id/prompts` does not set
`external_key`.

## 1. Create the prompts

Suite ids: S6 = 7, S8 = 9. Workspace program `backend-transition` id 1.

For each `prompts/S6-XX.md` (and `S8-01b.md`):

1. Title = the heading without `# ` (e.g. `S6-16 — Drop true dual-write…`).
2. Content = the file body after the heading.
3. Paste as a new prompt on suite 7 (S6-16…S6-49) or suite 9 (S8-01b).
4. Set `prompt.external_key` to `S6-16` / `S8-01b` / etc.

If pasting via API:

```
POST /api/suites/7/prompts   { "title": "…", "content": "…" }
```

then SQL (on a copy first):

```
UPDATE prompt SET external_key = 'S6-16' WHERE suite_id = 7 AND title LIKE 'S6-16 —%' AND external_key IS NULL;
```

`S8-01b` is suite_id 9.

## 2. Dependencies

`prompt_dependency (prompt_id, depends_on_prompt_id)`. Insert after every new
row has an id. Edges from `INDEX.md`:

```
S6-18 → S6-17
S6-19 → S6-18
S6-20 → S6-18
S6-21 → S6-18
S6-22 → S6-18
S6-23 → S6-20
S6-24 → S6-23
S6-25 → S6-18
S6-26 → S6-25
S6-27 → S6-25
S6-28 → S6-25
S6-29 → S6-25
S6-30 → S6-29
S6-31 → S6-25
S6-32 → S6-25
S6-33 → S6-32
S6-34 → S6-32
S6-35 → S6-32
S6-36 → S6-32
S6-37 → S6-32
S6-38 → S6-32
S6-39 → S6-38
S6-40 → S6-25
S6-41 → S6-40
S6-42 → S6-16
S6-43 → S6-16
S6-44 → S6-18
S6-46 → S6-16
S6-48 → every S6-16…S6-47
S6-49 → S6-48
S8-01b → S6-48
```

S6-16, S6-17, S6-45, S6-47 have no new dependencies.

Do not add a dependency on S8-01. Its status is UNREPORTED and would block the
remainder forever.

S8-02 already depends on S8-01. After S8-01b is the real deploy proof, add
`S8-02 → S8-01b` as well so delete-mock cannot start on a never-deployed tree.

## 3. Park S8-01

Leave station 63 UNREPORTED, or mark DONE from the operator UI with the already
banked strangler evidence (one-container task def, compose without mock,
`--target mock` exit 2, unmatched 404). Do not put native-port work back into
its content.

## 4. Do not run generate-prompts.py against materio-forge

That script only rewrites files in this folder.
