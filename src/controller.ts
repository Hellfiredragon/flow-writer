import {
	Candidate,
	CompletionClient,
	completeWord,
	endsSentence,
	mergeCandidates,
} from './llama';

export interface StripRenderer {
	/** Show or update the strip in place. Called with the live array. */
	render(candidates: Candidate[]): void;
	/** Remove the strip. */
	clear(): void;
}

export interface ControllerOptions {
	maxCandidates: number;
	/** Max words per candidate (deepening limit). */
	maxDepth: number;
	idleIntervalMs: number;
	/** Prompt = at most this many chars before the cursor. */
	contextChars: number;
	cacheSize: number;
}

export const DEFAULT_CONTROLLER_OPTIONS: ControllerOptions = {
	maxCandidates: 10,
	maxDepth: 5,
	idleIntervalMs: 1000,
	contextChars: 4000,
	cacheSize: 32,
};

interface Session {
	id: number;
	prompt: string;
	candidates: Candidate[];
	abort: AbortController;
	idleTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Owns the single live suggestion set (hard rule 2). DOM-free: rendering
 * goes through the injected StripRenderer, network through CompletionClient.
 */
export class SuggestionController {
	private session: Session | null = null;
	private nextId = 1;
	/** LRU: prompt -> live candidate array (revisits restore deepened state). */
	private cache = new Map<string, Candidate[]>();

	constructor(
		private client: CompletionClient,
		private renderer: StripRenderer,
		private options: () => ControllerOptions,
	) {}

	get active(): boolean {
		return this.session !== null && this.session.candidates.length > 0;
	}

	/** Word for pick slot `i` (0-based), or null. */
	candidateAt(i: number): string | null {
		return this.session?.candidates[i]?.text ?? null;
	}

	/**
	 * Start a new suggestion beat for the text before the cursor.
	 * Discards and aborts any previous session first.
	 */
	trigger(textBeforeCursor: string): void {
		this.clear();
		const opts = this.options();
		const prompt = textBeforeCursor.slice(-opts.contextChars);
		if (!/\S/.test(prompt)) return;
		const session: Session = {
			id: this.nextId++,
			prompt,
			candidates: [],
			abort: new AbortController(),
			idleTimer: null,
		};
		this.session = session;

		const cached = this.cache.get(prompt);
		if (cached) {
			// LRU touch.
			this.cache.delete(prompt);
			this.cache.set(prompt, cached);
			session.candidates = cached;
			this.renderer.render(session.candidates);
			this.startIdle(session);
			return;
		}
		void this.fetchInitial(session);
	}

	/** Discard the live set and abort everything in flight (hard rule 2). */
	clear(): void {
		const s = this.session;
		if (!s) return;
		this.session = null;
		s.abort.abort();
		if (s.idleTimer !== null) clearTimeout(s.idleTimer);
		this.renderer.clear();
	}

	private isLive(session: Session): boolean {
		return this.session === session;
	}

	private async fetchInitial(session: Session): Promise<void> {
		const opts = this.options();
		let words: string[];
		try {
			const tokens = await this.client.topTokens(
				session.prompt,
				opts.maxCandidates,
				session.abort.signal,
			);
			if (!this.isLive(session)) return;
			words = await Promise.all(
				tokens.map((tok) =>
					completeWord(
						this.client,
						session.prompt,
						tok,
						session.abort.signal,
					).catch(() => ''),
				),
			);
		} catch {
			// Server unreachable / aborted: strip simply stays absent.
			return;
		}
		if (!this.isLive(session)) return;
		const merged = mergeCandidates(words, opts.maxCandidates);
		if (merged.length === 0) return;
		session.candidates = merged.map((text) => ({
			text,
			done: endsSentence(text) || opts.maxDepth <= 1,
		}));
		this.cache.set(session.prompt, session.candidates);
		if (this.cache.size > opts.cacheSize) {
			const oldest = this.cache.keys().next().value as string;
			this.cache.delete(oldest);
		}
		this.renderer.render(session.candidates);
		this.startIdle(session);
	}

	/**
	 * Sequential pacing: the next deepening round is scheduled only after
	 * the previous one has fully returned, so the cadence is
	 * "wait for earlier requests + idle interval" — the server is never
	 * flooded with overlapping rounds.
	 */
	private startIdle(session: Session): void {
		if (session.candidates.every((c) => c.done)) return;
		session.idleTimer = setTimeout(() => {
			session.idleTimer = null;
			void this.deepen(session);
		}, this.options().idleIntervalMs);
	}

	/** Grow every unfinished candidate by exactly one word (hard rule 3). */
	private async deepen(session: Session): Promise<void> {
		if (!this.isLive(session)) return;
		const opts = this.options();
		await Promise.all(
			session.candidates.map(async (cand) => {
				if (cand.done) return;
				let next = '';
				try {
					const rest = await this.client.continueText(
						session.prompt + cand.text,
						session.abort.signal,
					);
					// Continuation must start a new word, not extend the last one.
					const m = /^\s+(\S+)/.exec(rest);
					next = m?.[1] ?? '';
				} catch {
					return;
				}
				if (!this.isLive(session)) return;
				if (!next) {
					cand.done = true;
					return;
				}
				cand.text = `${cand.text} ${next}`;
				const depth = cand.text.split(/\s+/).length;
				if (depth >= opts.maxDepth || endsSentence(next)) cand.done = true;
			}),
		);
		if (!this.isLive(session)) return;
		this.renderer.render(session.candidates);
		this.startIdle(session);
	}
}
