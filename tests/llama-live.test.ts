import { beforeAll, describe, expect, it } from 'vitest';
import { LlamaClient, completeWord } from '../src/llama';

/**
 * Integration tests against a REAL llama-server. Skipped unless
 * LLAMA_ENDPOINT is set:
 *
 *   LLAMA_ENDPOINT=http://127.0.0.1:8081 npm test
 *
 * Useful to check what the model actually returns for a prompt (e.g. when
 * the strip shows garbage) and that our parsing matches the server version.
 */
const endpoint = process.env.LLAMA_ENDPOINT;
const signal = () => AbortSignal.timeout(30_000);
const PROMPT = 'Joe walks on the street, when ';

describe.skipIf(!endpoint)('llama-server live integration', () => {
	let client: LlamaClient;

	beforeAll(() => {
		// LlamaClient uses window.fetch (Obsidian renderer); alias it in node.
		(globalThis as Record<string, unknown>).window ??= globalThis;
		client = new LlamaClient(() => endpoint!);
	});

	it('returns top tokens sorted by probability, in [0,1]', async () => {
		const tokens = await client.topTokens(PROMPT, 10, signal());
		console.log('top tokens:', tokens);
		expect(tokens.length).toBeGreaterThan(0);
		for (const t of tokens) {
			expect(t.prob).toBeGreaterThanOrEqual(0);
			expect(t.prob).toBeLessThanOrEqual(1);
			expect(t.token.length).toBeGreaterThan(0);
		}
		const probs = tokens.map((t) => t.prob);
		expect(probs).toEqual([...probs].sort((a, b) => b - a));
		// A sane base model puts real mass on the head of the distribution.
		expect(probs[0]).toBeGreaterThan(0.01);
	});

	it('completes fragments into whole words', async () => {
		const tokens = await client.topTokens(PROMPT, 5, signal());
		const words = await Promise.all(
			tokens
				.filter((t) => t.prob >= 0.01)
				.map((t) => completeWord(client, PROMPT, t.token, signal())),
		);
		console.log('completed words:', words);
		expect(words.some((w) => w.length > 0)).toBe(true);
		for (const w of words) expect(w).not.toMatch(/\s/);
	});

	it('greedy continuation returns text', async () => {
		const rest = await client.continueText(PROMPT, signal());
		console.log('continuation:', JSON.stringify(rest));
		expect(typeof rest).toBe('string');
		expect(rest.length).toBeGreaterThan(0);
	});
});
