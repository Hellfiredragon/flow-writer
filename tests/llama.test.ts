import { describe, expect, it } from 'vitest';
import {
	completeWord,
	CompletionClient,
	endsSentence,
	firstWord,
	mergeCandidates,
	parseTopTokens,
} from '../src/llama';

describe('parseTopTokens', () => {
	it('parses modern llama-server shape (token/probs) with probabilities', () => {
		const json = {
			completion_probabilities: [
				{
					token: ' the',
					probs: [
						{ token: ' the', prob: 0.3 },
						{ token: ' a', prob: 0.2 },
					],
				},
			],
		};
		expect(parseTopTokens(json, 10)).toEqual([
			{ token: ' the', prob: 0.3 },
			{ token: ' a', prob: 0.2 },
		]);
	});

	it('parses legacy shape (tok_str)', () => {
		const json = {
			completion_probabilities: [
				{
					content: ' the',
					probs: [
						{ tok_str: ' the', prob: 0.3 },
						{ tok_str: ' an', prob: 0.1 },
					],
				},
			],
		};
		expect(parseTopTokens(json, 10)).toEqual([
			{ token: ' the', prob: 0.3 },
			{ token: ' an', prob: 0.1 },
		]);
	});

	it('converts logprobs and sorts descending by probability', () => {
		const json = {
			completion_probabilities: [
				{
					probs: [
						{ token: ' rare', logprob: Math.log(0.05) },
						{ token: ' common', logprob: Math.log(0.5) },
					],
				},
			],
		};
		const out = parseTopTokens(json, 10);
		expect(out[0]?.token).toBe(' common');
		expect(out[0]?.prob).toBeCloseTo(0.5);
		expect(out[1]?.prob).toBeCloseTo(0.05);
	});

	it('sorts unsorted input, caps at n, tolerates garbage', () => {
		const json = {
			completion_probabilities: [
				{
					probs: [
						{ token: 'low', prob: 0.1 },
						{ token: 'high', prob: 0.4 },
						{ token: 'mid', prob: 0.2 },
						{ notatoken: 1 },
					],
				},
			],
		};
		expect(parseTopTokens(json, 2).map((t) => t.token)).toEqual([
			'high',
			'mid',
		]);
		expect(parseTopTokens({}, 5)).toEqual([]);
		expect(parseTopTokens(null, 5)).toEqual([]);
		expect(parseTopTokens({ completion_probabilities: [] }, 5)).toEqual([]);
	});
});

describe('firstWord', () => {
	it('takes the first whitespace-delimited word', () => {
		expect(firstWord(' France is')).toBe('France');
		expect(firstWord('Fr ance')).toBe('Fr');
		expect(firstWord('word')).toBe('word');
		expect(firstWord('  \n ')).toBe('');
		expect(firstWord('')).toBe('');
	});
});

describe('mergeCandidates', () => {
	it('sums probabilities of duplicates, sorts desc, drops empties, caps', () => {
		const out = mergeCandidates(
			[
				{ word: 'the', prob: 0.2 },
				{ word: '', prob: 0.5 },
				{ word: 'a', prob: 0.25 },
				{ word: 'the', prob: 0.1 },
				{ word: 'an', prob: 0.05 },
				{ word: 'and', prob: 0.01 },
			],
			3,
		);
		expect(out).toEqual([
			{ word: 'the', prob: 0.30000000000000004, glue: false },
			{ word: 'a', prob: 0.25, glue: false },
			{ word: 'an', prob: 0.05, glue: false },
		]);
	});
});

describe('endsSentence', () => {
	it('detects sentence-final words including closing quotes', () => {
		expect(endsSentence('end.')).toBe(true);
		expect(endsSentence('really?')).toBe(true);
		expect(endsSentence('done!"')).toBe(true);
		expect(endsSentence('word')).toBe(false);
		expect(endsSentence('Mr')).toBe(false);
	});
});

function fakeClient(continuation: string): CompletionClient {
	return {
		topTokens: async () => [],
		continueText: async () => continuation,
	};
}

describe('completeWord', () => {
	const signal = new AbortController().signal;

	it('completes a fragment via greedy continuation', async () => {
		const word = await completeWord(
			fakeClient('ance is known'),
			'p',
			' Fr',
			signal,
		);
		expect(word).toBe('France');
	});

	it('returns the word without a request when token has a boundary', async () => {
		const client: CompletionClient = {
			topTokens: async () => [],
			continueText: async () => {
				throw new Error('should not be called');
			},
		};
		expect(await completeWord(client, 'p', ' the ', signal)).toBe('the');
	});

	it('rejects pure-whitespace tokens', async () => {
		expect(await completeWord(fakeClient('x'), 'p', '\n', signal)).toBe('');
		expect(await completeWord(fakeClient('x'), 'p', '  ', signal)).toBe('');
	});
});
