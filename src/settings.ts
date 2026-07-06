import { App, PluginSettingTab, Setting } from 'obsidian';
import FlowWriterPlugin from './main';

export interface FlowWriterSettings {
	endpoint: string;
	/** Characters that trigger a prediction when typed. */
	triggerChars: string;
	idleIntervalMs: number;
	/** Max words per candidate; 1 disables idle deepening entirely. */
	maxDepth: number;
	maxCandidates: number;
	/** Drop candidates whose token probability is below this (percent). */
	minProbPercent: number;
}

export const DEFAULT_SETTINGS: FlowWriterSettings = {
	endpoint: 'http://127.0.0.1:8080',
	triggerChars: ' .,;:!?—-"\')\n',
	idleIntervalMs: 1000,
	maxDepth: 1,
	maxCandidates: 10,
	minProbPercent: 1,
};

export class FlowWriterSettingTab extends PluginSettingTab {
	plugin: FlowWriterPlugin;

	constructor(app: App, plugin: FlowWriterPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Server endpoint')
			.setDesc('Base URL of the local llama-server (raw /completion).')
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.endpoint)
					.setValue(this.plugin.settings.endpoint)
					.onChange(async (value) => {
						this.plugin.settings.endpoint =
							value.trim() || DEFAULT_SETTINGS.endpoint;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Trigger characters')
			.setDesc('Typing any of these characters requests suggestions.')
			.addText((text) =>
				text
					.setValue(this.plugin.settings.triggerChars)
					.onChange(async (value) => {
						this.plugin.settings.triggerChars =
							value || DEFAULT_SETTINGS.triggerChars;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Idle deepening interval')
			.setDesc('Milliseconds of idle time per extra word.')
			.addSlider((slider) =>
				slider
					.setLimits(250, 5000, 250)
					.setValue(this.plugin.settings.idleIntervalMs)
					.onChange(async (value) => {
						this.plugin.settings.idleIntervalMs = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Max depth')
			.setDesc(
				'Maximum words a candidate can grow to while idle. 1 disables idle deepening.',
			)
			.addSlider((slider) =>
				slider
					.setLimits(1, 12, 1)
					.setValue(this.plugin.settings.maxDepth)
					.onChange(async (value) => {
						this.plugin.settings.maxDepth = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Probability cutoff')
			.setDesc('Hide candidates below this probability (percent).')
			.addSlider((slider) =>
				slider
					.setLimits(0, 10, 1)
					.setValue(this.plugin.settings.minProbPercent)
					.onChange(async (value) => {
						this.plugin.settings.minProbPercent = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Candidates')
			.setDesc('How many next-word candidates to show.')
			.addSlider((slider) =>
				slider
					.setLimits(3, 10, 1)
					.setValue(this.plugin.settings.maxCandidates)
					.onChange(async (value) => {
						this.plugin.settings.maxCandidates = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}
