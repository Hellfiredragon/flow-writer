import {
	Candidate,
	CompletionClient,
	endsSentence,
	firstWord,
	mergeCandidates,
} from './llama';

export interface StripRenderer {
	/** Show or update the strip in place. Called with the live array. */
	render(candidates: Candidate[], selected: number): void;
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
	/** Candidates whose seed-token probability is below this are dropped. */
	minProb: number;
}

export const DEFAULT_CONTROLLER_OPTIONS: ControllerOptions = {
	maxCandidates: 10,
	maxDepth: 1,
	idleIntervalMs: 1000,
	contextChars: 4000,
	cacheSize: 32,
	minProb: 0.01,
};

/**
 * Plan the document edit for picking `cand` with `before` = text before the
 * cursor. Trailing spaces/tabs are consumed and reinserted deliberately: a
 * glue candidate ("'s", ",") attaches directly to the previous word, a
 * normal word is separated by exactly one space — added even when the user
 * typed none (e.g. right after punctuation). No space is added at the start
 * of a line or document. The insertion always ends with a space, which
 * re-triggers prediction like any typed space.
 */
export function planPick(
	before: string,
	cand: Candidate,
	/** Refinement prefix typed since the trigger — replaced by the pick. */
	typed = '',
): { deleteBack: number; insert: string } {
	const base = typed ? before.slice(0, before.length - typed.length) : before;
	const trailing = /[ \t]*$/.exec(base)?.[0] ?? '';
	const prev = base.slice(0, base.length - trailing.length).slice(-1);
	const needSpace = !cand.glue && prev !== '' && prev !== '\n';
	return {
		deleteBack: typed.length + trailing.length,
		insert: `${needSpace ? ' ' : ''}${cand.text} `,
	};
}

interface Session {
	id: number;
	prompt: string;
	candidates: Candidate[];
	/** Index highlighted in the strip; refined by typed letters. */
	selected: number;
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

	/** Candidate for pick slot `i` (0-based), or null. */
	candidateAt(i: number): Candidate | null {
		return this.session?.candidates[i] ?? null;
	}

	/** Index of the highlighted candidate (0 until refined). */
	get selectedIndex(): number {
		return this.session?.selected ?? 0;
	}

	/**
	 * Refine the live set with the letters typed since the trigger: the
	 * first candidate whose text starts with `typed` (case-insensitive)
	 * becomes selected. Returns false when nothing matches — the caller
	 * should end the beat then.
	 */
	refine(typed: string): boolean {
		const s = this.session;
		if (!s || s.candidates.length === 0) return false;
		const t = typed.toLowerCase();
		const idx = s.candidates.findIndex((c) =>
			c.text.toLowerCase().startsWith(t),
		);
		if (idx === -1) return false;
		s.selected = idx;
		this.renderer.render(s.candidates, idx);
		return true;
	}

	/**
	 * Start a new suggestion beat for the text before the cursor.
	 * Discards and aborts any previous session first.
	 */
	trigger(textBeforeCursor: string): void {
		this.clear();
		const opts = this.options();
		// Trailing whitespace is trimmed: BPE word tokens carry their leading
		// space (" the"), so a prompt ending in " " starves all real words and
		// surfaces junk that follows a space without one (numbers, HTML tags).
		const prompt = textBeforeCursor
			.slice(-opts.contextChars)
			.replace(/\s+$/, '');
		if (!/\S/.test(prompt)) return;
		const session: Session = {
			id: this.nextId++,
			prompt,
			candidates: [],
			selected: 0,
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
			this.renderer.render(session.candidates, session.selected);
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
		let tokens;
		try {
			tokens = await this.client.topTokens(
				session.prompt,
				opts.maxCandidates,
				session.abort.signal,
			);
		} catch {
			// Server unreachable / aborted: strip simply stays absent.
			return;
		}
		if (!this.isLive(session)) return;
		// One request per beat: raw token fragments above the cutoff render
		// directly — no completion requests. A fragment may be a partial word
		// ("Fr" for "France"); accepting the speed/quality tradeoff for now.
		const words = tokens
			.filter((t) => t.prob >= opts.minProb)
			.map((t) => ({
				word: firstWord(t.token),
				prob: t.prob,
				// No leading space on the token: attaches to the previous
				// word ("'s", ",") instead of standing alone.
				glue: /^\S/.test(t.token),
			}));
		const merged = mergeCandidates(words, opts.maxCandidates);
		if (merged.length === 0) return;
		session.candidates = merged.map(({ word, prob, glue }) => ({
			text: word,
			prob,
			done: endsSentence(word) || opts.maxDepth <= 1,
			glue: glue ?? false,
		}));
		this.cache.set(session.prompt, session.candidates);
		if (this.cache.size > opts.cacheSize) {
			const oldest = this.cache.keys().next().value as string;
			this.cache.delete(oldest);
		}
		this.renderer.render(session.candidates, session.selected);
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
					// Prompt has no trailing space (see trigger): re-join the
					// candidate the way it would be inserted — glued directly,
					// or separated by a single space.
					const rest = await this.client.continueText(
						session.prompt + (cand.glue ? '' : ' ') + cand.text,
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
		this.renderer.render(session.candidates, session.selected);
		this.startIdle(session);
	}
}
