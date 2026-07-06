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
	it('parses modern llama-server shape (token/probs)', () => {
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
		expect(parseTopTokens(json, 10)).toEqual([' the', ' a']);
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
		expect(parseTopTokens(json, 10)).toEqual([' the', ' an']);
	});

	it('caps at n and tolerates garbage', () => {
		const json = {
			completion_probabilities: [
				{
					probs: [
						{ token: 'a' },
						{ token: 'b' },
						{ token: 'c' },
						{ notatoken: 1 },
					],
				},
			],
		};
		expect(parseTopTokens(json, 2)).toEqual(['a', 'b']);
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
	it('dedupes in order, drops empties, caps', () => {
		expect(
			mergeCandidates(['the', '', 'a', 'the', 'an', 'and'], 3),
		).toEqual(['the', 'a', 'an']);
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
