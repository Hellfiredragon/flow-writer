/**
 * Client for a local llama.cpp `llama-server` raw /completion endpoint.
 * Base (non-instruct) model, no template: prompt = document text before cursor.
 */

export interface Candidate {
	/** Whole words accumulated so far, joined by single spaces. */
	text: string;
	/** Probability of the seed token (duplicate words merged by summing). */
	prob: number;
	/** No further deepening (max depth, sentence end, or model dried up). */
	done: boolean;
}

export interface TokenProb {
	token: string;
	/** Probability in [0, 1]. */
	prob: number;
}

/**
 * Extract the top-N next tokens with probabilities from a llama-server
 * /completion response, tolerating the several field layouts llama.cpp
 * has shipped. Result is sorted by probability, descending.
 */
export function parseTopTokens(json: unknown, n: number): TokenProb[] {
	const root = json as Record<string, unknown>;
	const cp = root?.completion_probabilities;
	if (!Array.isArray(cp) || cp.length === 0) return [];
	const first = cp[0] as Record<string, unknown>;
	const probs = (first.probs ?? first.top_probs ?? first.top_logprobs) as
		| Array<Record<string, unknown>>
		| undefined;
	if (!Array.isArray(probs)) return [];
	const out: TokenProb[] = [];
	for (const p of probs) {
		const tok = (p.token ?? p.tok_str ?? p.content) as string | undefined;
		if (typeof tok !== 'string' || tok.length === 0) continue;
		let prob = typeof p.prob === 'number' ? p.prob : NaN;
		if (Number.isNaN(prob) && typeof p.logprob === 'number') {
			prob = Math.exp(p.logprob);
		}
		if (Number.isNaN(prob)) prob = 0;
		out.push({ token: tok, prob });
	}
	out.sort((a, b) => b.prob - a.prob);
	return out.slice(0, n);
}

/** First whitespace-delimited word of `s` (leading whitespace ignored), or ''. */
export function firstWord(s: string): string {
	const m = /^\s*(\S+)/.exec(s);
	return m?.[1] ?? '';
}

export interface WeightedWord {
	word: string;
	prob: number;
}

/**
 * Merge duplicate words by summing their probabilities, drop empties,
 * sort by probability descending, cap at `max`.
 */
export function mergeCandidates(
	words: WeightedWord[],
	max: number,
): WeightedWord[] {
	const merged = new Map<string, number>();
	for (const { word, prob } of words) {
		if (!word) continue;
		merged.set(word, (merged.get(word) ?? 0) + prob);
	}
	return [...merged.entries()]
		.map(([word, prob]) => ({ word, prob }))
		.sort((a, b) => b.prob - a.prob)
		.slice(0, max);
}

/** Does a word end a sentence? */
export function endsSentence(word: string): boolean {
	return /[.!?…]["'”’)]*$/.test(word);
}

export interface CompletionClient {
	/** Top-N most likely next tokens after `prompt`, sorted by prob desc. */
	topTokens(
		prompt: string,
		n: number,
		signal: AbortSignal,
	): Promise<TokenProb[]>;
	/** Greedy short continuation of `prompt` (raw text, may start mid-word). */
	continueText(prompt: string, signal: AbortSignal): Promise<string>;
}

export class LlamaClient implements CompletionClient {
	constructor(private getEndpoint: () => string) {}

	private async post(
		body: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown> {
		const base = this.getEndpoint().replace(/\/+$/, '');
		// window.fetch, not Obsidian's requestUrl: abort-safety (hard rule 4)
		// needs AbortSignal, which requestUrl does not support. Local endpoint only.
		const res = await window.fetch(`${base}/completion`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal,
		});
		if (!res.ok) throw new Error(`llama-server ${res.status}`);
		return res.json();
	}

	async topTokens(
		prompt: string,
		n: number,
		signal: AbortSignal,
	): Promise<TokenProb[]> {
		const json = await this.post(
			{ prompt, n_predict: 1, n_probs: Math.max(n + 5, 15), temperature: 0 },
			signal,
		);
		return parseTopTokens(json, n + 5);
	}

	async continueText(prompt: string, signal: AbortSignal): Promise<string> {
		const json = (await this.post(
			{ prompt, n_predict: 8, temperature: 0 },
			signal,
		)) as Record<string, unknown>;
		return typeof json?.content === 'string' ? json.content : '';
	}
}

/**
 * Complete a raw token fragment into a whole word: greedily continue
 * prompt+token and cut at the first whitespace boundary.
 * Returns '' if no word emerges.
 */
export async function completeWord(
	client: CompletionClient,
	prompt: string,
	token: string,
	signal: AbortSignal,
): Promise<string> {
	// A token that is pure whitespace/newline can't start a word.
	if (!/\S/.test(token) && token !== '') {
		return '';
	}
	// If the token already contains an internal boundary (" the "), the word
	// is complete without another request.
	const inner = /^\s*(\S+)[\s]/.exec(token);
	if (inner?.[1]) return inner[1];
	const rest = await client.continueText(prompt + token, signal);
	return firstWord(token + rest);
}
