/**
 * Probe a llama-server endpoint with arbitrary text: print the top-5 next
 * words (plugin pipeline: topTokens → cutoff → completeWord →
 * mergeCandidates) and greedily extend each one — always following the
 * single most likely continuation, never branching — until punctuation
 * ends the sentence. Reports performance metrics (per-request latency,
 * per-phase wall clock) so strip latency can be judged offline.
 *
 * Usage (Node ≥ 22.6 runs TypeScript directly):
 *
 *   npm run probe -- "Joe walks on the street, when "
 *   npm run probe -- --file chapter.md
 *   echo -n "Once upon a time, " | npm run probe
 *
 * Options:
 *   --endpoint <url>   llama-server base URL (default http://127.0.0.1:8081,
 *                      or LLAMA_ENDPOINT)
 *   --file <path>      read the prompt from a file instead of argv/stdin
 *   --n <count>        number of candidates (default 5)
 *   --cutoff <prob>    min seed-token probability, e.g. 0.01 (default 0.01)
 *   --max-words <k>    safety cap per continuation (default 30)
 */
import { readFileSync } from 'node:fs';
import {
	type CompletionClient,
	LlamaClient,
	type TokenProb,
	completeWord,
	endsSentence,
	firstWord,
	mergeCandidates,
	type WeightedWord,
} from '../src/llama.ts';

function fail(msg: string): never {
	console.error(msg);
	process.exit(1);
}

// --- argument parsing -------------------------------------------------------
const argv = process.argv.slice(2);
let endpoint = process.env.LLAMA_ENDPOINT ?? 'http://127.0.0.1:8081';
let file: string | undefined;
let n = 5;
let cutoff = 0.01;
let maxWords = 30;
const positional: string[] = [];

for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	const next = () => argv[++i] ?? fail(`missing value for ${a}`);
	if (a === '--endpoint') endpoint = next();
	else if (a === '--file') file = next();
	else if (a === '--n') n = Number(next());
	else if (a === '--cutoff') cutoff = Number(next());
	else if (a === '--max-words') maxWords = Number(next());
	else if (a === '--help' || a === '-h') {
		console.log(
			'usage: npm run probe -- [--endpoint url] [--n 5] [--cutoff 0.01] [--max-words 30] ("text" | --file path | stdin)',
		);
		process.exit(0);
	} else positional.push(a);
}

let prompt: string;
if (file) prompt = readFileSync(file, 'utf8');
else if (positional.length > 0) prompt = positional.join(' ');
else if (!process.stdin.isTTY) prompt = readFileSync(0, 'utf8');
else fail('no prompt: pass text as an argument, --file, or pipe via stdin');

// Same windowing as the plugin: last 4000 chars before the cursor.
prompt = prompt.slice(-4000);

// --- timing instrumentation --------------------------------------------------
interface RequestStats {
	count: number;
	totalMs: number;
	minMs: number;
	maxMs: number;
}

const stats: Record<'topTokens' | 'continueText', RequestStats> = {
	topTokens: { count: 0, totalMs: 0, minMs: Infinity, maxMs: 0 },
	continueText: { count: 0, totalMs: 0, minMs: Infinity, maxMs: 0 },
};

async function timed<T>(kind: keyof typeof stats, run: () => Promise<T>): Promise<T> {
	const t0 = performance.now();
	try {
		return await run();
	} finally {
		const ms = performance.now() - t0;
		const s = stats[kind];
		s.count++;
		s.totalMs += ms;
		s.minMs = Math.min(s.minMs, ms);
		s.maxMs = Math.max(s.maxMs, ms);
	}
}

/** Wrap a client so every request is counted and timed. */
function instrument(inner: CompletionClient): CompletionClient {
	return {
		topTokens: (p: string, count: number, sig: AbortSignal): Promise<TokenProb[]> =>
			timed('topTokens', () => inner.topTokens(p, count, sig)),
		continueText: (p: string, sig: AbortSignal): Promise<string> =>
			timed('continueText', () => inner.continueText(p, sig)),
	};
}

const ms = (v: number) => `${v.toFixed(0)}ms`;
const statLine = (label: string, s: RequestStats) =>
	s.count === 0
		? `  ${label}: 0 requests`
		: `  ${label}: ${s.count} requests, avg ${ms(s.totalMs / s.count)}, min ${ms(s.minMs)}, max ${ms(s.maxMs)}`;

// --- pipeline ----------------------------------------------------------------
// LlamaClient uses window.fetch (Obsidian renderer); alias it in node.
(globalThis as Record<string, unknown>).window ??= globalThis;
const client = instrument(new LlamaClient(() => endpoint));
const signal = () => AbortSignal.timeout(30_000);
const pct = (p: number) => `${(p * 100).toFixed(1)}%`;

/**
 * Extend `words` greedily — top-1 continuation only, one path, no tree —
 * until a word ends the sentence, the model dries up, or `maxWords`.
 */
async function extendToPunctuation(words: string): Promise<string> {
	while (words.split(' ').length < maxWords) {
		if (endsSentence(words)) break;
		const rest = await client.continueText(`${prompt}${words} `, signal());
		const word = firstWord(rest);
		if (!word) break;
		words += ` ${word}`;
	}
	return words;
}

console.log(`endpoint : ${endpoint}`);
console.log(`prompt   : …${JSON.stringify(prompt.slice(-80))}`);
console.log('');

const tStart = performance.now();
const tokens = await client.topTokens(prompt, n, signal());
if (tokens.length === 0) {
	fail(
		'no completion_probabilities in response — server too old, or n_probs unsupported',
	);
}

const seeds = tokens.filter((t) => t.prob >= cutoff);
const words: WeightedWord[] = await Promise.all(
	seeds.map(async (t) => ({
		word: await completeWord(client, prompt, t.token, signal()),
		prob: t.prob,
	})),
);
const candidates = mergeCandidates(words, n);
const tStrip = performance.now();
if (candidates.length === 0) {
	fail('no candidates above cutoff — the strip would stay hidden');
}

for (const [i, c] of candidates.entries()) {
	const t0 = performance.now();
	const extended = await extendToPunctuation(c.word);
	const dt = performance.now() - t0;
	const grown = extended.split(' ').length - c.word.split(' ').length;
	console.log(
		`${i + 1}: (${pct(c.prob)}) ${extended}   [+${grown} words in ${ms(dt)}]`,
	);
}
const tEnd = performance.now();

console.log('');
console.log('performance:');
console.log(
	`  strip ready (top tokens + word completion): ${ms(tStrip - tStart)} — what the user waits for after the trigger keystroke`,
);
console.log(`  greedy extension of ${candidates.length} candidates: ${ms(tEnd - tStrip)}`);
console.log(`  total: ${ms(tEnd - tStart)}`);
console.log(statLine('topTokens   ', stats.topTokens));
console.log(statLine('continueText', stats.continueText));
