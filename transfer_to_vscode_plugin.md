# Transfer brief: Flow Writer → VS Code extension

This document tells a fresh Claude Code instance everything it needs to
re-create the Flow Writer Obsidian plugin as a VS Code extension. Read it
together with the source of this repo — `src/llama.ts` and
`src/controller.ts` are the authoritative, portable core.

## What the project is

Flow Writer is a **local writing assistant that keeps a novelist in flow**.
It never writes for the user — it offers. After a trigger keystroke (space
or punctuation) it shows a quiet strip of the ~10 most likely next words
below the cursor line, predicted by a **local llama.cpp server**
(`llama-server`, raw `/completion` endpoint, **base non-instruct model**,
prompt = document text before the cursor, no template). The user picks a
suggestion explicitly (keyboard or click) or just keeps typing.

## What the project wants to achieve

The goal is *flow*, not autocomplete. The strip must feel like a whisper,
never an interruption:

1. **Never insert text automatically** — only an explicit pick or the
   user's own typing changes the document.
2. **One-beat lifetime** — exactly one live suggestion set. Letters typed
   right after the trigger *refine* it (select the matching candidate);
   any other keystroke, cursor move, or edit discards it and aborts all
   in-flight requests.
3. **Depth, not width** — idle deepening extends each candidate along a
   single greedy path (one word per second); it never branches into a tree.
4. **Instant & abort-safe** — the strip appears in ~100ms; stale results
   never render.
5. **Quiet UI** — low-contrast, theme-native, never pushes the user's text
   around, no flicker or reordering when candidates deepen.
6. **Fully local** — the llama server is the only network call. Endpoint,
   trigger chars, idle interval, max depth, candidate count, and
   probability cutoff are user settings.

## Architecture: what ports as-is, what must be rebuilt

### Portable, editor-agnostic core (copy nearly verbatim)

- **`src/llama.ts`** — llama.cpp client + pure helpers. Two request
  shapes: top-token probe (`n_predict: 1, n_probs, temperature: 0`) and
  greedy continuation (`n_predict: 8` default, `temperature: 0`).
  Helpers: `parseTopTokens` (tolerates several llama.cpp response
  layouts), `firstWord`, `mergeCandidates` (dedupe by summing probs),
  `endsSentence`, `completeWord` (currently unused by the flow but kept +
  tested). Only Obsidian-ism: it calls `window.fetch` — in a VS Code
  extension host use global `fetch` (Node ≥ 18).
- **`src/controller.ts`** — `SuggestionController`, fully DOM-free.
  Owns the single live session (id-guarded staleness checks +
  AbortController), LRU cache (32 entries, keyed by prompt), idle
  deepening, `refine(typed)` prefix selection, and the pure
  `planPick(before, candidate, typed)` insertion planner. It renders
  through an injected `StripRenderer` interface and takes a
  `CompletionClient` — inject VS Code implementations and it works
  unchanged.
- **`tests/*.test.ts`** — vitest, pure logic, no DOM. Port them; they
  encode the product rules. `tests/llama-live.test.ts` runs against a real
  server when `LLAMA_ENDPOINT` is set — keep it, it is the first stop
  whenever suggestions look like garbage.
- **`scripts/probe.ts`** — CLI to test any text against the endpoint
  (1 + N requests, prints candidates with probabilities + latency
  metrics). Editor-independent; copy it.

### Obsidian-specific, must be rebuilt for VS Code

| Concern | Obsidian implementation | VS Code equivalent |
|---|---|---|
| Edit/trigger detection | CM6 `EditorView.updateListener`, `tr.isUserEvent('input.type')` / `'delete.backward'` | `workspace.onDidChangeTextDocument` + `window.onDidChangeTextEditorSelection`; distinguish typing via `contentChanges` (single-char insert at cursor) |
| Suggestion UI | `src/strip.ts`: fixed-position DOM overlay, repositioned at cursor coords, mutates text nodes in place | No free-floating DOM. Options: (a) `TextEditorDecorationType` with `after` attachment on the line below (closest to the quiet-strip feel), (b) an `InlineCompletionItemProvider` (changes the interaction model — ghost text is single-suggestion), (c) a webview is overkill. Recommend (a) with a status-bar fallback. |
| Pick keys | CM6 keymap `Prec.highest`: Alt+1..0, Ctrl+Space (selected), Escape | `contributes.keybindings` in package.json with `"when": "flowWriter.active"` custom context (set via `commands.executeCommand('setContext', …)`); commands `flowWriter.pick1..0`, `flowWriter.pickSelected`, `flowWriter.dismiss` |
| Insertion | `view.dispatch({changes, selection, userEvent: 'input.type'})` | `TextEditor.edit()` then reposition selection; guard the change handler so the plugin's own edit re-triggers like a typed space (Obsidian gets this for free — replicate deliberately) |
| Settings | `src/settings.ts` (`PluginSettingTab`, saved via `saveData`) | `contributes.configuration`; read with `workspace.getConfiguration('flowWriter')` — keep the same keys: endpoint, triggerChars, maxCandidates, maxDepth, idleIntervalMs, minProbPercent |
| Styling | `styles.css` with Obsidian theme vars (`--text-faint`, `--background-primary`) | ThemeColor tokens (`editorGhostText.foreground` etc.) in decoration options |

## Hard-won lessons a new instance must not re-learn

These cost real debugging time; they are encoded in code + tests:

- **Trim trailing whitespace from the prompt.** BPE word tokens carry
  their leading space (`" the"`). A prompt ending in `" "` — which every
  space-trigger produces — starves all real word tokens and surfaces junk
  (bare numbers, `<strong>`/`<em>` tags, quotes). Trim before sending;
  tokens come back with the space built in and `firstWord` strips it.
  This single fix turned garbage suggestions into usable prose.
- **The endpoint must serve a BASE model.** Instruct/chat tunes fed raw
  untemplated text produce garbage next-token distributions (Korean
  tokens, markup). The live test logs top tokens to make this visible.
- **One request per beat.** The initial strip renders raw top-token
  fragments above the probability cutoff (default 1%) — no per-token
  completion requests. A fragment may be a partial word ("Fr" for
  "France"); accepted tradeoff for ~100ms strip latency. The cutoff also
  prunes a base model's multilingual tail before any money is spent.
- **Glue tokens.** A token without a leading space (`'s`, `,`) must
  attach directly to the previous word. Candidates carry `glue: boolean`;
  `planPick` consumes trailing spaces before the cursor and inserts with
  or without a separating space (adds one after punctuation even if the
  user typed none; never at line start). Deepening joins
  `prompt + (glue ? '' : ' ') + candidate` to match.
- **Staleness via session id + AbortController.** Every async
  continuation re-checks `session.id` before touching state; aborts
  cancel the fetches themselves. Any port must keep both layers.
- **Pace deepening sequentially.** Next round is scheduled only after the
  previous round's requests returned (cadence = round duration + idle
  interval). A local llama-server processes requests serially (~250ms per
  10-token continuation on the reference setup, unless started with
  `--parallel N`) — never flood it with overlapping rounds.
- **Prompt = last 4000 chars before the cursor** — bounds latency and
  cache keys.
- **Probabilities are first-class.** Candidates carry the seed-token
  probability end to end; the UI shows `(NN%)`, sorted descending;
  duplicates merge by summing.

## Suggested build order for the VS Code port

1. Scaffold (`yo code` or manual), copy `llama.ts`, `controller.ts`,
   tests, `scripts/probe.ts`; get `npm test` green.
2. Implement the trigger/refine/dismiss detection on
   `onDidChangeTextDocument` — this is the subtlest part; port the
   decision logic from `src/main.ts` (`handleEdit`, `tryRefine`,
   `typedPrefix`, `triggerHead` tracking).
3. Implement `StripRenderer` with an after-line decoration; keep the
   in-place-update contract (no flicker, order never changes).
4. Wire commands + keybindings with a `flowWriter.active` context key.
5. Settings, then verify end-to-end against a local llama-server with the
   probe script as the reference for what the strip should show.

## Reference environment

- llama.cpp `llama-server` on `http://127.0.0.1:8081`, base model, no
  chat template. Health check: `GET /health`.
- Probe: `npm run probe -- "Paris is"` → top-5 candidates with
  probabilities and latency; `--file`, stdin, `--n`, `--cutoff`,
  `--max-tokens` supported.
- Reference timings (single-threaded server): top-token probe ~60–110ms,
  10-token continuation ~200–250ms, requests serialize.
