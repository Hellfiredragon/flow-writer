/**
 * Probe a llama-server endpoint with arbitrary text in exactly 1 + N
 * requests: one top-token probe for the top-N candidates, then a single
 * greedy continuation per candidate (temperature 0, up to --max-tokens),
 * cut client-side at the first sentence-ending punctuation. No branching —
 * each candidate follows one path. Reports performance metrics.
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
 *   --max-tokens <k>   n_predict per continuation request (default 10)
 */
import { readFileSync } from 'node:fs';
import { LlamaClient, type TokenProb, endsSentence } from '../src/llama.ts';

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
let maxTokens = 10;
const positional: string[] = [];

for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	const next = () => argv[++i] ?? fail(`missing value for ${a}`);
	if (a === '--endpoint') endpoint = next();
	else if (a === '--file') file = next();
	else if (a === '--n') n = Number(next());
	else if (a === '--cutoff') cutoff = Number(next());
	else if (a === '--max-tokens') maxTokens = Number(next());
	else if (a === '--help' || a === '-h') {
		console.log(
			'usage: npm run probe -- [--endpoint url] [--n 5] [--cutoff 0.01] [--max-tokens 10] ("text" | --file path | stdin)',
		);
		process.exit(0);
	} else positional.push(a);
}

let prompt: string;
if (file) prompt = readFileSync(file, 'utf8');
else if (positional.length > 0) prompt = positional.join(' ');
else if (!process.stdin.isTTY) prompt = readFileSync(0, 'utf8');
else fail('no prompt: pass text as an argument, --file, or pipe via stdin');

// Same normalization as the plugin: last 4000 chars before the cursor,
// trailing whitespace trimmed (a prompt ending in " " starves the real
// word tokens, which carry their own leading space).
prompt = prompt.slice(-4000).replace(/\s+$/, '');

// --- helpers -----------------------------------------------------------------
const ms = (v: number) => `${v.toFixed(0)}ms`;
const pct = (p: number) => `${(p * 100).toFixed(1)}%`;

/** Cut a continuation at the first sentence-ending word (kept inclusive). */
function cutAtPunctuation(text: string): string {
	const words = text.trim().split(/\s+/).filter(Boolean);
	const out: string[] = [];
	for (const w of words) {
		out.push(w);
		if (endsSentence(w)) break;
	}
	return out.join(' ');
}

// --- pipeline: 1 topTokens request + n continueText requests ------------------
// LlamaClient uses window.fetch (Obsidian renderer); alias it in node.
(globalThis as Record<string, unknown>).window ??= globalThis;
const client = new LlamaClient(() => endpoint);
const signal = () => AbortSignal.timeout(60_000);

console.log(`endpoint : ${endpoint}`);
console.log(`prompt   : …${JSON.stringify(prompt.slice(-80))}`);
console.log('');

const tStart = performance.now();
const tokens = await client.topTokens(prompt, n, signal());
const tProbe = performance.now();
if (tokens.length === 0) {
	fail(
		'no completion_probabilities in response — server too old, or n_probs unsupported',
	);
}

const seeds = tokens.filter((t) => t.prob >= cutoff).slice(0, n);
if (seeds.length === 0) {
	fail('no tokens above cutoff — the strip would stay hidden');
}

interface Expansion {
	seed: TokenProb;
	text: string;
	ms: number;
}

const expansions: Expansion[] = await Promise.all(
	seeds.map(async (seed) => {
		const t0 = performance.now();
		const rest = await client.continueText(prompt + seed.token, signal(), maxTokens);
		return {
			seed,
			text: cutAtPunctuation(seed.token + rest),
			ms: performance.now() - t0,
		};
	}),
);
const tEnd = performance.now();

for (const [i, e] of expansions.entries()) {
	console.log(`${i + 1}: (${pct(e.seed.prob)}) ${e.text}   [${ms(e.ms)}]`);
}

const times = expansions.map((e) => e.ms);
console.log('');
console.log('performance:');
console.log(`  requests     : ${1 + expansions.length} (1 top-token probe + ${expansions.length} expansions)`);
console.log(`  probe        : ${ms(tProbe - tStart)}`);
console.log(
	`  expansions   : ${ms(tEnd - tProbe)} wall (parallel), per request avg ${ms(times.reduce((a, b) => a + b, 0) / times.length)}, min ${ms(Math.min(...times))}, max ${ms(Math.max(...times))}`,
);
console.log(`  total        : ${ms(tEnd - tStart)}`);
