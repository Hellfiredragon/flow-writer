import { Candidate } from './llama';
import { StripRenderer } from './controller';

export interface StripHost {
	/** Viewport coords of the cursor (bottom-left of the cursor line). */
	getAnchor(): { left: number; bottom: number } | null;
	/** User picked slot i (0-based). */
	onPick(i: number): void;
}

/**
 * The quiet suggestion strip: a fixed-position overlay below the cursor
 * line. Never reflows the document; deepening updates text nodes in place.
 */
export class StripView implements StripRenderer {
	private el: HTMLDivElement | null = null;
	private slots: HTMLElement[] = [];

	constructor(private host: StripHost) {}

	render(candidates: Candidate[], selected: number): void {
		if (!this.el) {
			this.el = document.body.createDiv({ cls: 'flow-writer-strip' });
			this.slots = [];
		}
		// Grow/shrink slot elements to match; text updates in place (rule 5).
		while (this.slots.length > candidates.length) {
			this.slots.pop()?.remove();
		}
		candidates.forEach((cand, i) => {
			let slot = this.slots[i];
			if (!slot) {
				slot = this.el!.createSpan({ cls: 'flow-writer-candidate' });
				slot.createSpan({
					cls: 'flow-writer-key',
					text: String((i + 1) % 10),
				});
				slot.createSpan({ cls: 'flow-writer-word' });
				slot.createSpan({ cls: 'flow-writer-prob' });
				slot.addEventListener('mousedown', (evt) => {
					evt.preventDefault();
					this.host.onPick(i);
				});
				this.slots.push(slot);
			}
			const word = slot.querySelector('.flow-writer-word');
			if (word && word.textContent !== cand.text) {
				word.textContent = cand.text;
			}
			const prob = slot.querySelector('.flow-writer-prob');
			if (prob) {
				const pct =
					cand.prob >= 0.01
						? `(${Math.round(cand.prob * 100)}%)`
						: '(<1%)';
				if (prob.textContent !== pct) prob.textContent = pct;
			}
			slot.classList.toggle('is-selected', i === selected);
		});
		this.reposition();
	}

	reposition(): void {
		if (!this.el) return;
		const anchor = this.host.getAnchor();
		if (!anchor) {
			this.clear();
			return;
		}
		const width = this.el.offsetWidth;
		const left = Math.max(
			4,
			Math.min(anchor.left, window.innerWidth - width - 8),
		);
		this.el.style.left = `${left}px`;
		this.el.style.top = `${anchor.bottom + 4}px`;
	}

	clear(): void {
		this.el?.remove();
		this.el = null;
		this.slots = [];
	}
}
