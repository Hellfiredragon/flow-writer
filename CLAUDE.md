# Flow Writer — Obsidian Plugin

A local writing assistant that keeps a novelist in flow. It never writes for the user — it offers. After a trigger keystroke (space/punctuation) it shows a quiet strip of the ~10 most likely next words below the cursor line, predicted by a local llama.cpp server (`/completion`, base non-instruct model, prompt = document text before cursor). Pick with Alt+1..0 or click; while idle, candidates deepen by one word per second along a single path each.

## Hard rules (product)

1. Never insert text automatically — only explicit pick or user typing.
2. One-beat lifetime: exactly one live suggestion set; any keystroke/cursor move/edit discards it and aborts all in-flight requests.
3. Depth, not width: idle deepening extends candidates, never branches.
4. Instant & abort-safe: strip updates fast; stale results never render.
5. Quiet UI: low-contrast, theme variables, never pushes user text, no flicker/reorder on deepening.
6. Fully local: llama-server is the only network call; endpoint/triggers/idle interval/max depth configurable.

## Working directives

- ALWAYS treat source code, type definitions, and test files as the authoritative source of truth. If documentation conflicts, follow the code and flag the docs as stale
- NEVER proactively create or update documentation files (e.g., README.md) unless explicitly requested
- ALWAYS check if the added feature needs more tests and add them accordingly
- ALWAYS run the project's test suite after any code change — rely on execution results, not documentation
- ALWAYS write the commit message into `.gitmessage` after completing work (including doc-only changes)
- ALWAYS use semantic commit prefixes: `feat(topic):`, `fix(topic):`, `chore(topic):`, `refactor(topic):`, `test(topic):`, `docs(topic):`
- ALWAYS run `git add -A && git commit -F .gitmessage && git push` when work is done. Do NOT ask for confirmation. You work on a branch — push freely with `--set-upstream origin <branch>` on first push if needed
- ALWAYS keep Key Design Decisions updated
- ALWAYS after completing work, reflect and suggest: (1) new Key Design Decisions to note, (2) new directives to add, (3) new scripts that could help codebase organization & discovery

## Commands

- `npm test` — vitest suite (pure logic, no DOM/Obsidian needed)
- `npm run build` — typecheck + esbuild bundle to `main.js`
- `npm run lint` — eslint

## Architecture

- `src/llama.ts` — llama.cpp `/completion` client + pure parsing helpers (`parseTopTokens`, `firstWord`, `mergeCandidates`). Two request shapes: top-token probe (`n_predict:1, n_probs`) and greedy continuation (`n_predict:8, temperature:0`) used both to complete token fragments into whole words and to deepen.
- `src/controller.ts` — `SuggestionController`: owns the single live session (id-guarded against staleness), AbortController per session, LRU cache keyed by prompt suffix, idle-deepening timer. DOM-free; renders through an injected `StripRenderer` interface so it's fully unit-testable.
- `src/strip.ts` — DOM overlay strip (implements `StripRenderer`), fixed-positioned at cursor coords, updates candidate spans in place.
- `src/settings.ts` — settings model + tab.
- `src/main.ts` — plugin wiring: CM6 update listener (trigger/clear detection), Alt+1..0 keymap (`Prec.highest`), pick → `view.dispatch` insert with trailing space (which itself re-triggers).

## Key Design Decisions

- **Controller is DOM-free.** All lifecycle logic (trigger, clear, abort, cache, deepen) lives in `SuggestionController` behind a `StripRenderer` interface → testable with fake client + fake timers.
- **Staleness via session id.** Every async continuation re-checks `session.id === current.id` before touching state or rendering; AbortController cancels the fetches themselves.
- **Word completion = greedy continuation.** llama tokens are fragments; each top token is completed by a temperature-0 continuation, cut at the first whitespace boundary. Duplicates merged, capped at N.
- **Deepening reuses the same continuation call** with prompt = prefix + candidate text; a candidate is `done` at max depth, sentence end (`.?!`), or when the model yields no word.
- **Deepening is paced sequentially, not on a fixed interval.** The next round is scheduled (setTimeout) only after the previous round's requests have all returned: cadence = previous round duration + idle interval. The local server never sees overlapping rounds.
- **Prompt = last 4000 chars before cursor** — bounds latency and cache keys.
- **Cache stores live candidate arrays** (LRU 32), so revisiting a position restores the deepened state instantly.
- **Strip is a fixed-position overlay** appended to the view DOM, repositioned on geometry changes — it never reflows the document (hard rule 5). Deepening mutates candidate text nodes in place; order never changes.
- **Pick re-triggers naturally:** inserted text ends with a trailing space, and the trigger detector treats it like any typed space.
