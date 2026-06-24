import { App, Modal, TFile, TFolder, Notice } from 'obsidian';
import type ObsidianMasonryPlugin from './main';
import type { FileItem } from './masonry-view';

// ── Tag Assignment Modal ─────────────────────────────────────

export class TagAssignModal extends Modal {
	plugin: ObsidianMasonryPlugin;
	paths: string[];

	constructor(app: App, plugin: ObsidianMasonryPlugin, paths: string[]) {
		super(app);
		this.plugin = plugin;
		this.paths = paths;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass('masonry-tag-modal');
		contentEl.empty();

		contentEl.createEl('h2', { text: `Assign tags to ${this.paths.length} item(s)` });

		const input = contentEl.createEl('input', {
			cls: 'masonry-tag-input',
			attr: { placeholder: 'Enter tags, comma-separated (e.g. concept, art, mood)', type: 'text' },
		});
		input.focus();

		const btnRow = contentEl.createDiv({ cls: 'masonry-tag-actions' });
		const applyBtn = btnRow.createEl('button', { cls: 'mod-cta', text: 'Assign' });
		applyBtn.addEventListener('click', async () => {
			const raw = input.value.trim();
			if (!raw) { new Notice('Enter at least one tag'); return; }
			const newTags = raw.split(',').map((s) => s.trim().replace(/^#/, '')).filter(Boolean);
			if (newTags.length === 0) { new Notice('Enter at least one tag'); return; }

			for (const p of this.paths) {
				const file = this.app.vault.getAbstractFileByPath(p);
				if (!(file instanceof TFile)) continue;
				try {
					await this.app.fileManager.processFrontMatter(file, (fm) => {
						let existing: string[] = [];
						if (Array.isArray(fm.tags)) {
							existing = fm.tags.map(String);
						} else if (typeof fm.tags === 'string') {
							existing = [fm.tags];
						}
						const merged = [...new Set([...existing, ...newTags])];
						fm.tags = merged;
					});
				} catch (e) {
					console.error('Failed to tag', p, e);
				}
			}
			new Notice(`Assigned tags to ${this.paths.length} item(s)`);
			this.close();
		});

		this.scope?.register([], 'Enter', () => { applyBtn.click(); return false; });
		this.scope?.register([], 'Escape', () => { this.close(); return false; });
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ── Image Viewer Modal ──────────────────────────────────────

export class ImageViewModal extends Modal {
	plugin: ObsidianMasonryPlugin;
	images: FileItem[];
	curIdx: number;
	imgEl!: HTMLImageElement;
	captionEl!: HTMLElement;
	leftNav!: HTMLElement;
	rightNav!: HTMLElement;
	imgContainer!: HTMLElement;

	constructor(app: App, plugin: ObsidianMasonryPlugin, images: FileItem[], startIdx: number) {
		super(app);
		this.plugin = plugin;
		this.images = images;
		this.curIdx = startIdx;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass('masonry-image-viewer');
		contentEl.empty();

		this.imgContainer = contentEl.createDiv({ cls: 'masonry-iv-container' });
		this.imgEl = this.imgContainer.createEl('img', { cls: 'masonry-iv-img' });

		this.leftNav = contentEl.createDiv({ cls: 'masonry-iv-nav masonry-iv-nav-left' });
		this.leftNav.setText('‹');
		this.leftNav.addEventListener('click', () => this.nav(-1));

		this.rightNav = contentEl.createDiv({ cls: 'masonry-iv-nav masonry-iv-nav-right' });
		this.rightNav.setText('›');
		this.rightNav.addEventListener('click', () => this.nav(1));

		const bottom = contentEl.createDiv({ cls: 'masonry-iv-bottom' });
		this.captionEl = bottom.createDiv({ cls: 'masonry-iv-caption' });
		const closeBtn = bottom.createEl('button', { cls: 'masonry-iv-close', text: 'Close' });
		closeBtn.addEventListener('click', () => this.close());

		this.scope?.register([], 'ArrowLeft', () => { this.nav(-1); return false; });
		this.scope?.register([], 'ArrowRight', () => { this.nav(1); return false; });
		this.scope?.register([], 'Escape', () => { this.close(); return false; });

		this.show(this.curIdx);
	}

	private nav(dir: number) {
		const next = this.curIdx + dir;
		if (next >= 0 && next < this.images.length) {
			this.curIdx = next;
			this.show(next);
		}
	}

	private show(idx: number) {
		const item = this.images[idx];
		if (!item) return;
		const file = this.app.vault.getAbstractFileByPath(item.path) as TFile;
		if (!file) return;
		this.imgEl.setAttr('src', this.app.vault.getResourcePath(file));
		this.captionEl.setText(`${item.name}  —  ${idx + 1} / ${this.images.length}`);
		this.leftNav.toggleClass('masonry-iv-hidden', idx === 0);
		this.rightNav.toggleClass('masonry-iv-hidden', idx === this.images.length - 1);
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ── Pin Select Modal ────────────────────────────────────────

export class PinSelectModal extends Modal {
	plugin: ObsidianMasonryPlugin;
	boards: TFile[];
	paths: string[];

	constructor(app: App, plugin: ObsidianMasonryPlugin, boards: TFile[], paths: string[]) {
		super(app);
		this.plugin = plugin;
		this.boards = boards;
		this.paths = paths;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass('masonry-pin-modal');
		contentEl.empty();

		contentEl.createEl('h2', { text: 'Add to Pin Board' });

		const list = contentEl.createDiv({ cls: 'masonry-pin-list' });
		for (const board of this.boards) {
			const row = list.createDiv({ cls: 'masonry-pin-row' });
			row.createSpan({ text: board.name.replace(/\.md$/i, '') });
			const btn = row.createEl('button', { cls: 'mod-cta', text: 'Pin' });
			btn.addEventListener('click', async () => {
				for (const p of this.paths) {
					await this.plugin.addToPinBoard(p, board);
				}
				new Notice(`Pinned ${this.paths.length} item(s) to "${board.name.replace(/\.md$/i, '')}"`);
				this.close();
			});
		}

		contentEl.createEl('hr');
		const createSec = contentEl.createDiv({ cls: 'masonry-pin-create' });
		createSec.createEl('h3', { text: 'Create New Board' });
		const input = createSec.createEl('input', {
			cls: 'masonry-pin-name-input',
			attr: { placeholder: 'Board name…', type: 'text' },
		});
		const createBtn = createSec.createEl('button', { text: 'Create & Pin' });
		createBtn.addEventListener('click', async () => {
			const name = input.value.trim();
			if (!name) { new Notice('Enter a name'); return; }
			const file = await this.plugin.createPinBoard(name);
			if (!file) return;
			for (const p of this.paths) {
				await this.plugin.addToPinBoard(p, file);
			}
			new Notice(`Board "${name}" created with ${this.paths.length} pin(s)`);
			this.close();
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}
