/**
 * Probe a llama-server endpoint with arbitrary text and print what the
 * suggestion strip would show — the plugin's real pipeline (topTokens →
 * probability cutoff → completeWord → mergeCandidates), outside Obsidian.
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
 *   --n <count>        number of candidates (default 10)
 *   --cutoff <prob>    min seed-token probability, e.g. 0.01 (default 0.01)
 *   --continue         also print the greedy 8-token continuation
 */
import { readFileSync } from 'node:fs';
import {
	LlamaClient,
	completeWord,
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
let n = 10;
let cutoff = 0.01;
let showContinuation = false;
const positional: string[] = [];

for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	const next = () => argv[++i] ?? fail(`missing value for ${a}`);
	if (a === '--endpoint') endpoint = next();
	else if (a === '--file') file = next();
	else if (a === '--n') n = Number(next());
	else if (a === '--cutoff') cutoff = Number(next());
	else if (a === '--continue') showContinuation = true;
	else if (a === '--help' || a === '-h') {
		console.log(
			'usage: npm run probe -- [--endpoint url] [--n 10] [--cutoff 0.01] [--continue] ("text" | --file path | stdin)',
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

// LlamaClient uses window.fetch (Obsidian renderer); alias it in node.
(globalThis as Record<string, unknown>).window ??= globalThis;
const client = new LlamaClient(() => endpoint);
const signal = () => AbortSignal.timeout(30_000);
const pct = (p: number) => `${(p * 100).toFixed(1).padStart(5)}%`;

console.log(`endpoint : ${endpoint}`);
console.log(`prompt   : …${JSON.stringify(prompt.slice(-80))}`);
console.log('');

const tokens = await client.topTokens(prompt, n, signal());
if (tokens.length === 0) {
	fail(
		'no completion_probabilities in response — server too old, or n_probs unsupported',
	);
}

console.log('top tokens (raw):');
for (const t of tokens) {
	const kept = t.prob >= cutoff ? '' : '   (below cutoff, dropped)';
	console.log(`  ${pct(t.prob)}  ${JSON.stringify(t.token)}${kept}`);
}
console.log('');

const seeds = tokens.filter((t) => t.prob >= cutoff);
const words: WeightedWord[] = await Promise.all(
	seeds.map(async (t) => ({
		word: await completeWord(client, prompt, t.token, signal()),
		prob: t.prob,
	})),
);
const candidates = mergeCandidates(words, n);

console.log('strip candidates:');
if (candidates.length === 0) console.log('  (none — the strip would stay hidden)');
for (const [i, c] of candidates.entries()) {
	console.log(`  ${(i + 1) % 10}: ${c.word}  (${pct(c.prob).trim()})`);
}

if (showContinuation) {
	const rest = await client.continueText(prompt, signal());
	console.log('');
	console.log(`greedy continuation: ${JSON.stringify(rest)}`);
}
