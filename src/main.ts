import { Plugin } from 'obsidian';
import { Prec } from '@codemirror/state';
import { EditorView, ViewUpdate, keymap } from '@codemirror/view';
import {
	DEFAULT_SETTINGS,
	FlowWriterSettings,
	FlowWriterSettingTab,
} from './settings';
import { LlamaClient } from './llama';
import {
	DEFAULT_CONTROLLER_OPTIONS,
	SuggestionController,
	planPick,
} from './controller';
import { StripView } from './strip';

export default class FlowWriterPlugin extends Plugin {
	settings!: FlowWriterSettings;
	private controller!: SuggestionController;
	private strip!: StripView;
	/** The one editor view that owns the live strip (hard rules 2 & robustness). */
	private activeView: EditorView | null = null;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new FlowWriterSettingTab(this.app, this));

		this.strip = new StripView({
			getAnchor: () => {
				const view = this.activeView;
				if (!view) return null;
				const coords = view.coordsAtPos(view.state.selection.main.head);
				return coords
					? { left: coords.left, bottom: coords.bottom }
					: null;
			},
			onPick: (i) => this.pick(i),
		});
		this.controller = new SuggestionController(
			new LlamaClient(() => this.settings.endpoint),
			this.strip,
			() => ({
				...DEFAULT_CONTROLLER_OPTIONS,
				maxCandidates: this.settings.maxCandidates,
				maxDepth: this.settings.maxDepth,
				idleIntervalMs: this.settings.idleIntervalMs,
				minProb: this.settings.minProbPercent / 100,
			}),
		);

		this.registerEditorExtension([
			EditorView.updateListener.of((update) => this.onUpdate(update)),
			Prec.highest(keymap.of(this.buildKeymap())),
		]);
	}

	onunload() {
		this.controller.clear();
	}

	private buildKeymap() {
		const bindings = [];
		for (let slot = 0; slot < 10; slot++) {
			bindings.push({
				key: `Alt-${(slot + 1) % 10}`,
				run: (view: EditorView) => {
					if (view !== this.activeView || !this.controller.active) {
						return false;
					}
					return this.pick(slot);
				},
			});
		}
		bindings.push({
			key: 'Escape',
			run: (view: EditorView) => {
				if (view !== this.activeView || !this.controller.active) {
					return false;
				}
				this.controller.clear();
				return true;
			},
		});
		return bindings;
	}

	private onUpdate(update: ViewUpdate): void {
		const view = update.view;
		if (update.docChanged) {
			// Any edit ends the beat; a user-typed trigger char starts a new one.
			if (view === this.activeView || this.activeView === null) {
				this.handleEdit(update);
			}
			return;
		}
		if (view !== this.activeView) return;
		if (update.focusChanged && !view.hasFocus) {
			this.controller.clear();
			return;
		}
		if (update.selectionSet) {
			// Cursor moved without an edit: discard (hard rule 2).
			this.controller.clear();
			return;
		}
		if (update.geometryChanged) this.strip.reposition();
	}

	private handleEdit(update: ViewUpdate): void {
		this.controller.clear();
		this.activeView = null;
		const view = update.view;
		if (!view.hasFocus) return;
		const isTyping = update.transactions.some((tr) =>
			tr.isUserEvent('input.type'),
		);
		if (!isTyping) return;
		const sel = view.state.selection.main;
		if (!sel.empty) return;
		const head = sel.head;
		if (head === 0) return;
		const lastChar = view.state.sliceDoc(head - 1, head);
		if (!this.settings.triggerChars.includes(lastChar)) return;
		this.activeView = view;
		this.controller.trigger(view.state.sliceDoc(0, head));
	}

	/** Insert candidate `slot` via planPick (glue-aware spacing, trailing
	 *  space retriggers prediction — never automatic, rule 1). */
	private pick(slot: number): boolean {
		const view = this.activeView;
		const cand = this.controller.candidateAt(slot);
		if (!view || cand === null) return false;
		const head = view.state.selection.main.head;
		const { deleteBack, insert } = planPick(
			view.state.sliceDoc(0, head),
			cand,
		);
		view.dispatch({
			changes: { from: head - deleteBack, to: head, insert },
			selection: { anchor: head - deleteBack + insert.length },
			userEvent: 'input.type',
		});
		view.focus();
		return true;
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<FlowWriterSettings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
