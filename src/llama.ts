/**
 * Client for a local llama.cpp `llama-server` raw /completion endpoint.
 * Base (non-instruct) model, no template: prompt = document text before cursor.
 */

export interface Candidate {
	/** Whole words accumulated so far, joined by single spaces. */
	text: string;
	/** No further deepening (max depth, sentence end, or model dried up). */
	done: boolean;
}

/**
 * Extract the top-N next-token strings from a llama-server /completion
 * response, tolerating the several field layouts llama.cpp has shipped.
 */
export function parseTopTokens(json: unknown, n: number): string[] {
	const root = json as Record<string, unknown>;
	const cp = root?.completion_probabilities;
	if (!Array.isArray(cp) || cp.length === 0) return [];
	const first = cp[0] as Record<string, unknown>;
	const probs = (first.probs ?? first.top_probs ?? first.top_logprobs) as
		| Array<Record<string, unknown>>
		| undefined;
	if (!Array.isArray(probs)) return [];
	const out: string[] = [];
	for (const p of probs) {
		const tok = (p.token ?? p.tok_str ?? p.content) as string | undefined;
		if (typeof tok === 'string' && tok.length > 0) out.push(tok);
		if (out.length >= n) break;
	}
	return out;
}

/** First whitespace-delimited word of `s` (leading whitespace ignored), or ''. */
export function firstWord(s: string): string {
	const m = /^\s*(\S+)/.exec(s);
	return m?.[1] ?? '';
}

/** Dedupe candidate words in order, drop empties, cap at `max`. */
export function mergeCandidates(words: string[], max: number): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const w of words) {
		if (!w || seen.has(w)) continue;
		seen.add(w);
		out.push(w);
		if (out.length >= max) break;
	}
	return out;
}

/** Does a word end a sentence? */
export function endsSentence(word: string): boolean {
	return /[.!?…]["'”’)]*$/.test(word);
}

export interface CompletionClient {
	/** Top-N most likely next tokens after `prompt`. */
	topTokens(prompt: string, n: number, signal: AbortSignal): Promise<string[]>;
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
	): Promise<string[]> {
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
