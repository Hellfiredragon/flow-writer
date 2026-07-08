import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_CONTROLLER_OPTIONS,
	StripRenderer,
	SuggestionController,
} from '../src/controller';
import { Candidate, CompletionClient, TokenProb } from '../src/llama';

/**
 * Fake llama client. Top tokens are whole words prefixed with a space
 * (rendered raw by the controller), and deepening continuations follow
 * a scripted map.
 */
class FakeClient implements CompletionClient {
	topTokensCalls = 0;
	lastPrompt = '';
	continueCalls = 0;
	aborted: AbortSignal[] = [];
	/** prompt suffix after base -> continuation returned */
	continuations = new Map<string, string>();
	tokens: TokenProb[] = [
		{ token: ' France', prob: 0.5 },
		{ token: ' the', prob: 0.3 },
		{ token: ' a', prob: 0.2 },
	];
	delayMs = 0;

	async topTokens(
		prompt: string,
		_n: number,
		signal: AbortSignal,
	): Promise<TokenProb[]> {
		this.topTokensCalls++;
		this.lastPrompt = prompt;
		this.aborted.push(signal);
		await this.wait(signal);
		return this.tokens;
	}

	async continueText(prompt: string, signal: AbortSignal): Promise<string> {
		this.continueCalls++;
		await this.wait(signal);
		for (const [suffix, cont] of this.continuations) {
			if (prompt.endsWith(suffix)) return cont;
		}
		return ' '; // no next word by default
	}

	private wait(signal: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			if (signal.aborted) return reject(new Error('aborted'));
			if (this.delayMs === 0) return resolve();
			const t = setTimeout(resolve, this.delayMs);
			signal.addEventListener('abort', () => {
				clearTimeout(t);
				reject(new Error('aborted'));
			});
		});
	}
}

class FakeRenderer implements StripRenderer {
	rendered: Candidate[][] = [];
	cleared = 0;
	render(candidates: Candidate[]): void {
		this.rendered.push(candidates.map((c) => ({ ...c })));
	}
	clear(): void {
		this.cleared++;
	}
	get last(): Candidate[] | undefined {
		return this.rendered[this.rendered.length - 1];
	}
}

describe('SuggestionController', () => {
	let client: FakeClient;
	let renderer: FakeRenderer;
	let controller: SuggestionController;
	const opts = { ...DEFAULT_CONTROLLER_OPTIONS, maxCandidates: 3, maxDepth: 3 };

	beforeEach(() => {
		vi.useFakeTimers();
		client = new FakeClient();
		renderer = new FakeRenderer();
		controller = new SuggestionController(client, renderer, () => opts);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	async function flush() {
		await vi.advanceTimersByTimeAsync(0);
	}

	it('trigger fetches and renders raw tokens sorted by probability', async () => {
		controller.trigger('Once upon a time in ');
		await flush();
		expect(renderer.last?.map((c) => c.text)).toEqual([
			'France',
			'the',
			'a',
		]);
		expect(renderer.last?.map((c) => c.prob)).toEqual([0.5, 0.3, 0.2]);
		expect(controller.active).toBe(true);
		expect(controller.candidateAt(0)).toBe('France');
		expect(controller.candidateAt(9)).toBeNull();
	});

	it('drops candidates below the probability cutoff', async () => {
		client.tokens = [
			{ token: ' France', prob: 0.6 },
			{ token: ' the', prob: 0.05 },
			{ token: ' 나를', prob: 0.004 },
		];
		controller.trigger('Joe walks on the street, when ');
		await flush();
		expect(renderer.last?.map((c) => c.text)).toEqual(['France', 'the']);
		// The initial beat costs exactly one request — tokens render raw,
		// no completion requests at all.
		expect(client.continueCalls).toBe(0);
	});

	it('trims trailing whitespace from the prompt (token-boundary fix)', async () => {
		controller.trigger('Paris is ');
		await flush();
		// A trailing space starves real word tokens (they carry their own
		// leading space) and surfaces numbers/HTML tags instead.
		expect(client.lastPrompt).toBe('Paris is');
	});

	it('joins deepening prompts with a single space', async () => {
		client.continuations.set('I love France', ' is');
		controller.trigger('I love ');
		await flush();
		await vi.advanceTimersByTimeAsync(opts.idleIntervalMs);
		expect(renderer.last?.[0]?.text).toBe('France is');
	});

	it('never triggers on whitespace-only prompts', async () => {
		controller.trigger('   \n ');
		await flush();
		expect(client.topTokensCalls).toBe(0);
		expect(controller.active).toBe(false);
	});

	it('merges duplicate completed words, summing their probabilities', async () => {
		client.tokens = [
			{ token: ' the', prob: 0.3 },
			{ token: ' the', prob: 0.25 },
			{ token: ' a', prob: 0.2 },
		];
		controller.trigger('text ');
		await flush();
		expect(renderer.last?.map((c) => c.text)).toEqual(['the', 'a']);
		expect(renderer.last?.[0]?.prob).toBeCloseTo(0.55);
	});

	it('resorts after merging when summed duplicates overtake the leader', async () => {
		client.tokens = [
			{ token: ' France', prob: 0.3 },
			{ token: ' the', prob: 0.25 },
			{ token: ' the', prob: 0.2 },
		];
		controller.trigger('text ');
		await flush();
		expect(renderer.last?.map((c) => c.text)).toEqual(['the', 'France']);
	});

	it('clear aborts in-flight requests and stale results never render', async () => {
		client.delayMs = 50;
		controller.trigger('slow prompt ');
		await vi.advanceTimersByTimeAsync(10);
		controller.clear();
		expect(client.aborted[0]?.aborted).toBe(true);
		await vi.advanceTimersByTimeAsync(500);
		expect(renderer.rendered).toHaveLength(0);
		expect(controller.active).toBe(false);
	});

	it('a new trigger discards the previous session (one-beat lifetime)', async () => {
		client.delayMs = 50;
		controller.trigger('first ');
		await vi.advanceTimersByTimeAsync(10);
		controller.trigger('second ');
		await vi.advanceTimersByTimeAsync(500);
		// Only the second session's result may render.
		expect(client.aborted[0]?.aborted).toBe(true);
		expect(renderer.rendered.length).toBe(1);
		expect(controller.active).toBe(true);
	});

	it('maxDepth 1 disables idle deepening entirely', async () => {
		controller = new SuggestionController(client, renderer, () => ({
			...opts,
			maxDepth: 1,
		}));
		controller.trigger('I love ');
		await flush();
		expect(renderer.last?.every((c) => c.done)).toBe(true);
		const calls = client.continueCalls;
		await vi.advanceTimersByTimeAsync(opts.idleIntervalMs * 5);
		expect(client.continueCalls).toBe(calls);
		expect(renderer.last?.[0]?.text).toBe('France');
	});

	it('deepens each candidate by one word per idle tick, in place', async () => {
		client.continuations.set('France', ' is famous');
		client.continuations.set('France is', ' known');
		controller.trigger('I love ');
		await flush();
		expect(renderer.last?.[0]?.text).toBe('France');

		await vi.advanceTimersByTimeAsync(opts.idleIntervalMs);
		expect(renderer.last?.[0]?.text).toBe('France is');
		// Order and count unchanged (depth, not width).
		expect(renderer.last?.map((c) => c.text)).toEqual([
			'France is',
			'the',
			'a',
		]);

		await vi.advanceTimersByTimeAsync(opts.idleIntervalMs);
		expect(renderer.last?.[0]?.text).toBe('France is known');
		expect(renderer.last?.[0]?.done).toBe(true); // maxDepth = 3
	});

	it('stops deepening at sentence end', async () => {
		client.continuations.set('France', ' wins.');
		controller.trigger('I love ');
		await flush();
		await vi.advanceTimersByTimeAsync(opts.idleIntervalMs);
		expect(renderer.last?.[0]?.text).toBe('France wins.');
		expect(renderer.last?.[0]?.done).toBe(true);
	});

	it('marks candidates done when the model yields no next word', async () => {
		controller.trigger('text ');
		await flush();
		await vi.advanceTimersByTimeAsync(opts.idleIntervalMs);
		expect(renderer.last?.every((c) => c.done)).toBe(true);
		// Timer stops: further ticks make no requests.
		const calls = client.continueCalls;
		await vi.advanceTimersByTimeAsync(opts.idleIntervalMs * 3);
		expect(client.continueCalls).toBe(calls);
	});

	it('paces deepening sequentially: next round = previous round + interval', async () => {
		client.continuations.set('France', ' is big');
		client.continuations.set('France is', ' big');
		controller.trigger('I love ');
		await flush();

		client.delayMs = 700; // each deepening round now takes 700ms
		await vi.advanceTimersByTimeAsync(opts.idleIntervalMs); // t=1000: round 1 starts
		const callsAtRound1 = client.continueCalls;
		expect(callsAtRound1).toBeGreaterThan(0);

		// t=2000: round 1 finished at t=1700, round 2 is due at t=2700 — not yet.
		await vi.advanceTimersByTimeAsync(1000);
		expect(client.continueCalls).toBe(callsAtRound1);

		// t=2800: past t=2700, round 2 has started.
		await vi.advanceTimersByTimeAsync(800);
		expect(client.continueCalls).toBeGreaterThan(callsAtRound1);
	});

	it('serves repeated prompts from cache, preserving deepened state', async () => {
		client.continuations.set('France', ' is');
		controller.trigger('I love ');
		await flush();
		await vi.advanceTimersByTimeAsync(opts.idleIntervalMs);
		expect(renderer.last?.[0]?.text).toBe('France is');

		controller.clear();
		const fetches = client.topTokensCalls;
		controller.trigger('I love ');
		await flush();
		expect(client.topTokensCalls).toBe(fetches); // cache hit
		expect(renderer.last?.[0]?.text).toBe('France is');
	});

	it('evicts the oldest cache entry beyond cacheSize', async () => {
		const small = { ...opts, cacheSize: 2 };
		controller = new SuggestionController(client, renderer, () => small);
		for (const p of ['one ', 'two ', 'three ']) {
			controller.trigger(p);
			await flush();
		}
		controller.clear();
		controller.trigger('one ');
		await flush();
		expect(client.topTokensCalls).toBe(4); // 'one' was evicted, refetched
	});

	it('stays silent when the server is unreachable', async () => {
		client.topTokens = async () => {
			throw new Error('ECONNREFUSED');
		};
		controller.trigger('text ');
		await flush();
		expect(renderer.rendered).toHaveLength(0);
		expect(controller.active).toBe(false);
	});
});
