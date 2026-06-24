import { ItemView, WorkspaceLeaf, TFolder, TFile, TAbstractFile, Notice, Menu, setIcon, MarkdownRenderer } from 'obsidian';
import type ObsidianMasonryPlugin from './main';
import { ImageViewModal, PinSelectModal } from './modals';

export const VIEW_TYPE_MASONRY = 'obsidian-masonry-view';

export interface FileItem {
	path: string;
	name: string;
	type: 'folder' | 'image' | 'video' | 'note' | 'other';
	isFolder: boolean;
	extension?: string;
	tags: string[];
	notePreview?: string;
	folderThumb?: string;
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico']);

export class MasonryView extends ItemView {
	plugin: ObsidianMasonryPlugin;
	private _dragHandlers: Record<string, (e: Event) => void> | null = null;
	currentPath: string = '';
	history: string[] = [];
	historyIdx: number = -1;
	items: FileItem[] = [];
	selected: Set<string> = new Set();
	searchQuery: string = '';
	lastSelectedEl: HTMLElement | null = null;

	// board mode
	isBoardView: boolean = false;
	boardFile: TFile | null = null;

	headerEl!: HTMLElement;
	gridWrapper!: HTMLElement;
	searchEl!: HTMLInputElement;
	backBtn!: HTMLElement;
	fwdBtn!: HTMLElement;
	pathEl!: HTMLElement;
	tagBarEl!: HTMLElement;
	tagChipsEl!: HTMLElement;
	tagInputEl!: HTMLInputElement;
	tagCloudBtnEl!: HTMLElement;
	tagCloudEl!: HTMLElement;
	editBoardBtnEl!: HTMLElement;

	constructor(leaf: WorkspaceLeaf, plugin: ObsidianMasonryPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return VIEW_TYPE_MASONRY; }
	getDisplayText(): string {
		if (this.isBoardView && this.boardFile) return `Board: ${this.boardFile.name.replace(/\.md$/i, '')}`;
		return this.currentPath ? `Masonry: ${this.currentPath}` : 'Masonry View';
	}
	getIcon(): string { return 'grid-3x3'; }

	async onOpen() {
		const { containerEl: c } = this;
		c.empty();
		c.addClass('masonry-root');
		this.buildHeader(c);
		this.gridWrapper = c.createDiv({ cls: 'masonry-grid-wrapper' });

		this.setupDragDrop();

		this.scope?.register(['Mod', 'Shift'], 'Backspace', () => { void this.deleteSelected(true); return false; });
		this.scope?.register([], 'Delete', (e) => {
			if (e.ctrlKey || e.metaKey) void this.deleteSelected(true);
			else void this.deleteSelected(false);
			return false;
		});

		if (this.currentPath) await this.loadFolderOrBoard(this.currentPath);
	}

	// One-time drag-drop setup — document-level capture to intercept before Obsidian
	private setupDragDrop() {
		const doc = window.activeDocument ?? document;
		let lastDragTarget: Element | null = null;
		const isMasonryTarget = (e: Event): boolean =>
			!!(e.target as HTMLElement)?.closest('.masonry-grid-wrapper');

		const isNavTitle = (e: Event): HTMLElement | null =>
			(e.target as HTMLElement)?.closest('.nav-file-title') as HTMLElement ?? null;

		const getSrc = (e: DragEvent): string => {
			const dt = e.dataTransfer;
			if (!dt) return '';
			const plain = dt.getData('text/plain');
			if (plain) {
				const txt = plain.trim();
				// Obsidian file-explorer drag puts an obsidian:// URI in text/plain
				const obsMatch = txt.match(/obsidian:\/\/open\?.*?[&?]file=([^&]+)/);
				if (obsMatch) return decodeURIComponent(obsMatch[1]).replace(/\\/g, '/');
				return txt.replace(/\\/g, '/');
			}
			const uri = dt.getData('text/uri-list');
			if (uri) {
				const decoded = decodeURI(uri.replace(/^file:\/\/\//i, '').replace(/^file:\/\//i, ''));
				return decoded.trim().replace(/\\/g, '/');
			}
			return '';
		};

		// convert a raw path (possibly absolute) into a vault-relative path
		const resolvePath = (raw: string): string => {
			// try the path as-is
			const tryPath = (p: string): string | null => {
				const file = this.app.vault.getAbstractFileByPath(p);
				return file ? file.path : null;
			};
			let found = tryPath(raw);
			if (found) return found;
			// Obsidian's obsidian:// URIs strip .md — try adding it back
			if (!raw.match(/\.\w+$/)) {
				found = tryPath(raw + '.md');
				if (found) return found;
			}
			// try as absolute path — strip vault base
			const vaultPath = (this.app.vault.adapter as any).getFullPath?.('/') || '';
			if (vaultPath) {
				const norm = String(vaultPath).replace(/\\/g, '/').replace(/\/$/, '');
				const tryRel = (rel: string): string | null => {
					const f = this.app.vault.getAbstractFileByPath(rel);
					return f ? f.path : null;
				};
				if (raw.startsWith(norm + '/')) {
					const rel = raw.slice(norm.length + 1);
					found = tryRel(rel);
					if (found) return found;
					// also try with .md added back
					if (!rel.match(/\.\w+$/)) {
						found = tryRel(rel + '.md');
						if (found) return found;
					}
				}
			}
			// fallback: search by filename (exact match first)
			const name = raw.split('/').pop()?.split('\\').pop() || '';
			const all = this.app.vault.getAllLoadedFiles();
			const byName = all.filter(f => f.name === name);
			if (byName.length === 1) return byName[0].path;
			if (!name.match(/\.\w+$/)) {
				const exactMd = all.filter(f => f.name === name + '.md');
				if (exactMd.length === 1) return exactMd[0].path;
			}
			const bySuffix = all.filter(f => f.path.endsWith('/' + name));
			if (bySuffix.length === 1) return bySuffix[0].path;
			// assume it's already vault-relative
			return raw;
		};

		const cleanBoardMarkers = () => {
			doc.querySelectorAll('.masonry-drop-board').forEach(el => el.removeClass('masonry-drop-board'));
			doc.querySelectorAll('.masonry-drop-file-exp').forEach(el => el.removeClass('masonry-drop-file-exp'));
		};

		const onDragOver = (e: DragEvent) => {
			// masonry view: highlight folders and pin-board cards
			if (isMasonryTarget(e)) {
				e.preventDefault();
				e.stopPropagation();
				const card = (e.target as HTMLElement).closest('.masonry-card');
				if (!card) return;
				if (lastDragTarget === card) return;
				if (lastDragTarget) lastDragTarget.removeClass('masonry-drop-board');
				lastDragTarget = null;
				const path = card.getAttr('data-path');
				if (!path) return;
				const file = this.app.vault.getAbstractFileByPath(path);
				if (file instanceof TFolder) {
					card.addClass('masonry-drop-board');
					lastDragTarget = card;
				} else if (file instanceof TFile && this.plugin.isPinBoard(file)) {
					card.addClass('masonry-drop-board');
					lastDragTarget = card;
				}
				return;
			}
			// file explorer: allow drop on pin-board files
			const navTitle = isNavTitle(e);
			if (!navTitle) return;
			const path = navTitle.getAttr('data-path');
			if (!path) return;
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile && this.plugin.isPinBoard(file)) {
				e.preventDefault();
				e.stopPropagation();
				navTitle.addClass('masonry-drop-file-exp');
			}
		};
		const onDragLeave = () => {
			cleanBoardMarkers();
			lastDragTarget = null;
		};
		const onDrop = async (e: DragEvent) => {
			const src = getSrc(e);
			if (!src) return;
			const multiRaw = e.dataTransfer?.getData('text/x-masonry-items');
			const rawPaths: string[] = multiRaw ? JSON.parse(multiRaw) : [src];
			const paths = rawPaths.map(resolvePath).filter(Boolean);
			if (!paths.length) return;

			// masonry view drop
			if (isMasonryTarget(e)) {
				e.preventDefault();
				e.stopPropagation();
				cleanBoardMarkers();
				const targetCard = (e.target as HTMLElement).closest('.masonry-card');
				const targetPath = targetCard?.getAttr('data-path') || this.currentPath;
				if (!targetPath) return;
				for (const p of paths) await this.handleDropOnFolder(p, targetPath);
				await this.loadFolderOrBoard(this.currentPath);
				return;
			}

			// file-explorer drop on a pin-board file
			const navTitle = isNavTitle(e);
			if (!navTitle) return;
			const targetPath = navTitle.getAttr('data-path');
			if (!targetPath) return;
			const file = this.app.vault.getAbstractFileByPath(targetPath);
			if (file instanceof TFile && this.plugin.isPinBoard(file)) {
				e.preventDefault();
				e.stopPropagation();
				cleanBoardMarkers();
				for (const p of paths) {
					await this.plugin.addToPinBoard(p, file);
				}
				new Notice(`Pinned to "${file.name.replace(/\.md$/i, '')}"`);
				await this.loadFolderOrBoard(this.currentPath);
			}
		};
		const opts = { capture: true };
		doc.addEventListener('dragover', onDragOver, opts);
		doc.addEventListener('dragleave', onDragLeave, opts);
		doc.addEventListener('drop', onDrop as EventListener, opts);
		this._dragHandlers = { dragover: onDragOver as (e: Event) => void, dragleave: onDragLeave as (e: Event) => void, drop: onDrop as (e: Event) => void };
	}

	async onClose() {
		this.containerEl.empty();
		if (this._dragHandlers) {
			const doc = window.activeDocument ?? document;
			for (const [evt, fn] of Object.entries(this._dragHandlers)) {
				doc.removeEventListener(evt, fn, { capture: true });
			}
		}
	}

	getState(): Record<string, unknown> {
		return { folderPath: this.currentPath, history: this.history, historyIdx: this.historyIdx, isBoardView: this.isBoardView };
	}

	async setState(state: Record<string, unknown>, result: any): Promise<void> {
		const path = state.folderPath as string;
		if (path) {
			this.currentPath = path;
			this.history = (state.history as string[]) || [];
			this.historyIdx = (state.historyIdx as number) ?? -1;
			this.isBoardView = state.isBoardView as boolean || false;
			await this.loadFolderOrBoard(path);
		}
	}

	// ── entry point ─────────────────────────────────────────

	async loadFolderOrBoard(path: string) {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile && file.extension === 'md' && this.plugin.isPinBoard(file)) {
			await this.loadPinBoard(file);
		} else {
			await this.loadFolder(path);
		}
	}

	// ── header ──────────────────────────────────────────────

	private buildHeader(c: HTMLElement) {
		this.headerEl = c.createDiv({ cls: 'masonry-header' });
		const row1 = this.headerEl.createDiv({ cls: 'masonry-hrow' });

		const nav = row1.createDiv({ cls: 'masonry-nav' });
		this.backBtn = nav.createEl('button', { cls: 'masonry-nav-btn', attr: { 'aria-label': 'Back' } });
		setIcon(this.backBtn, 'arrow-left');
		this.backBtn.addEventListener('click', () => this.goBack());
		this.fwdBtn = nav.createEl('button', { cls: 'masonry-nav-btn', attr: { 'aria-label': 'Forward' } });
		setIcon(this.fwdBtn, 'arrow-right');
		this.fwdBtn.addEventListener('click', () => this.goForward());

		const sc = row1.createDiv({ cls: 'masonry-search' });
		const searchIcon = sc.createSpan({ cls: 'masonry-search-icon' });
		setIcon(searchIcon, 'search');
		this.searchEl = sc.createEl('input', {
			cls: 'masonry-search-input',
			attr: { placeholder: 'Search name or tag…', type: 'text' },
		});
		this.searchEl.addEventListener('input', () => { this.searchQuery = this.searchEl.value; this.render(); });
		this.searchEl.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') { this.searchEl.value = ''; this.searchQuery = ''; this.render(); }
		});

		this.pathEl = row1.createDiv({ cls: 'masonry-path' });

		// Edit Board button (shown only in board view)
		this.editBoardBtnEl = row1.createEl('button', {
			cls: 'masonry-action-btn masonry-edit-board-btn',
			attr: { 'aria-label': 'Edit board file' },
		});
		setIcon(this.editBoardBtnEl, 'pencil');
		this.editBoardBtnEl.addClass('masonry-hide');
		this.editBoardBtnEl.addEventListener('click', () => { void this.editCurrentBoard(); });

		const actions = row1.createDiv({ cls: 'masonry-actions' });

		this.tagCloudBtnEl = actions.createEl('button', {
			cls: 'masonry-action-btn',
			attr: { 'aria-label': 'Tag cloud' },
		});
		setIcon(this.tagCloudBtnEl, 'hash');
		this.tagCloudBtnEl.addEventListener('click', () => this.toggleTagCloud());

		const tagBtn = actions.createEl('button', {
			cls: 'masonry-action-btn',
			attr: { 'aria-label': 'Assign tags' },
		});
		setIcon(tagBtn, 'tag');
		tagBtn.addEventListener('click', () => this.focusTagInput());

		const pinBtn = actions.createEl('button', {
			cls: 'masonry-action-btn',
			attr: { 'aria-label': 'Pin selected to board' },
		});
		setIcon(pinBtn, 'pin');
		pinBtn.addEventListener('click', () => { void this.showPinModal(); });

		// tag bar (row 2)
		this.tagBarEl = this.headerEl.createDiv({ cls: 'masonry-tag-bar' });
		this.tagBarEl.addClass('masonry-hide');
		this.tagBarEl.createSpan({ cls: 'masonry-tag-label', text: 'Tags: ' });
		this.tagChipsEl = this.tagBarEl.createDiv({ cls: 'masonry-tag-chips' });
		this.tagInputEl = this.tagBarEl.createEl('input', {
			cls: 'masonry-tag-input',
			attr: { placeholder: 'add tag…', type: 'text' },
		});
		this.tagInputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ',') {
				e.preventDefault();
				void this.addTagFromInput();
			} else if (e.key === 'Backspace' && this.tagInputEl.value === '') {
				// remove last chip
				const chips = this.getCurrentChips();
				if (chips.length > 0) void this.removeTagAndSave(chips[chips.length - 1]);
			}
		});

		// tag cloud (hidden)
		this.tagCloudEl = this.headerEl.createDiv({ cls: 'masonry-tag-cloud' });
		this.tagCloudEl.addClass('masonry-hide');
	}

	// ── tag: auto-save on every change ──────────────────────

	private getCurrentChips(): string[] {
		const tags: string[] = [];
		this.tagChipsEl.querySelectorAll('.masonry-chip').forEach(el => {
			const label = el.querySelector('.masonry-chip-label');
			if (label) tags.push(label.textContent || '');
		});
		return tags;
	}

	private async addTagFromInput() {
		const raw = this.tagInputEl.value.trim();
		if (!raw) return;
		const parts = raw.split(',').map(s => s.trim().replace(/^#/, '')).filter(Boolean);
		if (parts.length === 0) return;
		this.tagInputEl.value = '';
		for (const tag of parts) {
			await this.addSingleTag(tag);
		}
	}

	private async addSingleTag(tag: string) {
		if (this.selected.size === 0) return;
		for (const p of this.selected) {
			const existing = this.plugin.getItemTags(p);
			if (existing.includes(tag)) continue;
			await this.plugin.setItemTags(p, [...existing, tag]);
			const item = this.items.find(i => i.path === p);
			if (item) item.tags = this.plugin.getItemTags(p);
		}
		this.buildTagFreq();
		this.render();
		this.renderTagChipsFromSelection();
	}

	private async removeTagAndSave(tag: string) {
		if (this.selected.size === 0) return;
		for (const p of this.selected) {
			const existing = this.plugin.getItemTags(p);
			const updated = existing.filter(t => t !== tag);
			await this.plugin.setItemTags(p, updated);
			const item = this.items.find(i => i.path === p);
			if (item) item.tags = this.plugin.getItemTags(p);
		}
		this.buildTagFreq();
		this.render();
		this.renderTagChipsFromSelection();
	}

	private renderTagChipsFromSelection() {
		if (this.selected.size === 0) { this.tagBarEl.addClass('masonry-hide'); return; }
		this.tagBarEl.removeClass('masonry-hide');
		const allTags = new Set<string>();
		for (const p of this.selected) {
			for (const t of this.plugin.getItemTags(p)) allTags.add(t);
		}
		this.tagChipsEl.empty();
		const sorted = [...allTags].sort();
		for (const tag of sorted) {
			const chip = this.tagChipsEl.createSpan({ cls: 'masonry-chip' });
			chip.createSpan({ cls: 'masonry-chip-label', text: `#${tag}` });
			const del = chip.createSpan({ cls: 'masonry-chip-x', text: '×' });
			del.addEventListener('click', (e) => { e.stopPropagation(); void this.removeTagAndSave(tag); });
		}
	}

	private focusTagInput() {
		this.renderTagChipsFromSelection();
		this.tagInputEl.focus();
	}

	// ── tag cloud ───────────────────────────────────────────

	private toggleTagCloud() {
		if (this.tagCloudVisible()) {
			this.tagCloudEl.addClass('masonry-hide');
		} else {
			this.buildTagCloud();
			this.tagCloudEl.removeClass('masonry-hide');
			window.setTimeout(() => {
				const doc = window.activeDocument ?? document;
				const handler = (e: MouseEvent) => {
					if (!this.tagCloudEl.contains(e.target as Node) && e.target !== this.tagCloudBtnEl) {
						this.tagCloudEl.addClass('masonry-hide');
						doc.removeEventListener('click', handler);
					}
				};
				doc.addEventListener('click', handler);
			}, 0);
		}
	}

	private tagCloudVisible(): boolean {
		return !this.tagCloudEl.hasClass('masonry-hide');
	}

	private buildTagFreq() {
		if (!this.plugin.settings.fileTags) return;
		this.tagFreq.clear();
		for (const item of this.items) {
			if (item.isFolder) continue;
			const tags = this.plugin.getItemTags(item.path);
			for (const t of tags) {
				this.tagFreq.set(t, (this.tagFreq.get(t) || 0) + 1);
			}
		}
	}

	private tagFreq: Map<string, number> = new Map();

	private buildTagCloud() {
		this.tagCloudEl.empty();
		this.tagCloudEl.createDiv({ cls: 'masonry-tc-title', text: 'Tag Cloud' });

		const list = this.tagCloudEl.createDiv({ cls: 'masonry-tc-items' });
		const sorted = [...this.tagFreq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

		if (sorted.length === 0) {
			list.createSpan({ cls: 'masonry-tc-empty', text: 'No tags in this folder' });
		}

		const maxFreq = sorted.length > 0 ? sorted[0][1] : 1;
		for (const [tag, freq] of sorted) {
			const el = list.createSpan({ cls: 'masonry-tc-tag' });
			el.setText(`#${tag} (${freq})`);
			const scale = 0.75 + (freq / maxFreq) * 0.5;
			el.style.fontSize = `${scale}em`;
			el.addEventListener('click', () => {
				this.searchEl.value = `#${tag}`;
				this.searchQuery = `#${tag}`;
				this.tagCloudEl.addClass('masonry-hide');
				this.render();
			});
		}
	}

	// ── navigation ──────────────────────────────────────────

	async loadFolder(path: string) {
		this.isBoardView = false;
		this.boardFile = null;
		this.editBoardBtnEl.addClass('masonry-hide');

		if (this.historyIdx === -1 || this.history[this.historyIdx] !== path) {
			this.history = this.history.slice(0, this.historyIdx + 1);
			this.history.push(path);
			this.historyIdx = this.history.length - 1;
		}
		this.currentPath = path;
		this.selected.clear();
		this.tagBarEl.addClass('masonry-hide');
		this.tagCloudEl.addClass('masonry-hide');
		this.updateUI();

		const folder = this.app.vault.getAbstractFileByPath(path);
		if (!folder || !(folder instanceof TFolder)) { new Notice('Folder not found'); return; }

		this.items = [];
		for (const child of folder.children) {
			const item = await this.toFileItem(child);
			if (item) this.items.push(item);
		}
		await this.enrichItems(this.items);
		this.buildTagFreq();
		this.render();
	}

	async loadPinBoard(file: TFile) {
		this.isBoardView = true;
		this.boardFile = file;
		this.editBoardBtnEl.removeClass('masonry-hide');

		const boardPath = file.path;
		if (this.historyIdx === -1 || this.history[this.historyIdx] !== boardPath) {
			this.history = this.history.slice(0, this.historyIdx + 1);
			this.history.push(boardPath);
			this.historyIdx = this.history.length - 1;
		}
		this.currentPath = boardPath;
		this.selected.clear();
		this.tagBarEl.addClass('masonry-hide');
		this.tagCloudEl.addClass('masonry-hide');
		this.updateUI();

		const pins = await this.plugin.getPinBoardPins(file);
		this.items = [];
		for (const pinPath of pins) {
			const abs = this.app.vault.getAbstractFileByPath(pinPath);
			if (abs instanceof TFolder) {
				this.items.push({ path: abs.path, name: abs.name, type: 'folder', isFolder: true, tags: this.plugin.getItemTags(abs.path) });
			} else if (abs instanceof TFile) {
				const item = await this.toFileItem(abs);
				if (item) {
					item.tags = this.plugin.getItemTags(abs.path);
					this.items.push(item);
				}
			}
		}
		await this.enrichItems(this.items);
		this.buildTagFreq();
		this.render();
	}

	private async editCurrentBoard() {
		if (this.boardFile) {
			const leaf = this.app.workspace.getMostRecentLeaf() ?? this.app.workspace.getLeaf();
			await leaf.openFile(this.boardFile);
		}
	}

	goBack() {
		if (this.historyIdx > 0) {
			this.historyIdx--;
			this.currentPath = this.history[this.historyIdx];
			this.selected.clear();
			this.updateUI();
			void this.loadFolderOrBoard(this.currentPath);
		}
	}

	goForward() {
		if (this.historyIdx < this.history.length - 1) {
			this.historyIdx++;
			this.currentPath = this.history[this.historyIdx];
			this.selected.clear();
			this.updateUI();
			void this.loadFolderOrBoard(this.currentPath);
		}
	}

	private updateUI() {
		if (this.isBoardView && this.boardFile) {
			this.pathEl.setText(this.boardFile.name.replace(/\.md$/i, ''));
		} else {
			this.pathEl.setText(this.currentPath || '/');
		}
		this.backBtn.toggleClass('masonry-nav-disabled', this.historyIdx <= 0);
		this.fwdBtn.toggleClass('masonry-nav-disabled', this.historyIdx >= this.history.length - 1);
	}

	// ── file-item conversion ────────────────────────────────

	private async toFileItem(file: TAbstractFile): Promise<FileItem | null> {
		if (file instanceof TFolder) {
			return { path: file.path, name: file.name, type: 'folder', isFolder: true, tags: this.plugin.getItemTags(file.path) };
		}
		if (!(file instanceof TFile)) return null;
		const ext = file.extension.toLowerCase();
		const isImage = IMAGE_EXTS.has(ext);
		const type = isImage ? 'image' : ext === 'md' ? 'note' : 'other';
		return {
			path: file.path,
			name: file.name,
			type,
			isFolder: false,
			extension: ext,
			tags: this.plugin.getItemTags(file.path),
		};
	}

	private async enrichItems(items: FileItem[]) {
		await Promise.all(items.map(async item => {
			if (item.type === 'note' && !item.notePreview) {
				item.notePreview = await this.getNotePreview(item.path);
			}
			if (item.isFolder && !item.folderThumb) {
				item.folderThumb = await this.getFolderThumb(item.path);
			}
		}));
	}

	private async getNotePreview(path: string): Promise<string> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return '';
		try {
			const content = await this.app.vault.read(file);
			const body = content.replace(/^---[\s\S]*?---\n*/m, '');
			const lines = body.split('\n').filter(l => l.trim());
			let preview = lines.slice(0, 30).join('\n').trim();
			preview = preview.replace(/!\[.*?\]\(.*?\)/g, '').trim();
			if (preview.length > 2000) preview = preview.slice(0, 1997) + '…';
			return preview || '';
		} catch { return ''; }
	}

	private async getFolderThumb(path: string): Promise<string | undefined> {
		const folder = this.app.vault.getAbstractFileByPath(path);
		if (!(folder instanceof TFolder)) return undefined;
		for (const child of folder.children) {
			if (child instanceof TFile && IMAGE_EXTS.has(child.extension.toLowerCase())) return child.path;
		}
		return undefined;
	}

	private getResourcePath(filePath: string): string {
		const file = this.app.vault.getAbstractFileByPath(filePath);
		return file instanceof TFile ? this.app.vault.getResourcePath(file) : '';
	}

	// ── rendering ───────────────────────────────────────────

	render() {
		this.gridWrapper.empty();
		const q = this.searchQuery.toLowerCase().trim();

		let folders = this.items.filter(i => i.isFolder).sort((a, b) => a.name.localeCompare(b.name));
		let files = this.items.filter(i => !i.isFolder).sort((a, b) => a.name.localeCompare(b.name));

		if (q) {
			const match = (i: FileItem) =>
				i.name.toLowerCase().includes(q) || i.tags.some(t => t.toLowerCase().includes(q));
			folders = folders.filter(match);
			files = files.filter(match);
		}

		const gap = this.plugin.settings.itemGap ?? 10;
		const colCount = this.plugin.settings.columnCount ?? 4;
		const noteMinH = this.plugin.settings.noteCardMinHeight ?? 100;
		const noteMaxH = this.plugin.settings.noteCardMaxHeight ?? 500;
		const noteFontSize = this.plugin.settings.noteCardFontSize ?? 14;
		const folderCount = this.plugin.settings.folderCount ?? 8;
		this.gridWrapper.style.setProperty('--masonry-gap', `${gap}px`);
		this.gridWrapper.style.setProperty('--masonry-note-min-height', `${noteMinH + 8}px`);
		this.gridWrapper.style.setProperty('--masonry-note-max-height', `${noteMaxH + 8}px`);
		this.gridWrapper.style.setProperty('--masonry-note-font-size', `${noteFontSize}px`);

		const hasSections: string[] = [];

		// folders in a CSS grid row
		const rowItems = this.isBoardView ? [] : folders;
		if (rowItems.length > 0) {
			hasSections.push('folders');
			const row = this.gridWrapper.createDiv({ cls: 'masonry-folders-row' });
			row.style.setProperty('--masonry-folder-count', String(folderCount));
			row.style.gap = `${gap}px`;
			for (const item of rowItems) {
				this.createCardIn(row, item);
			}
		}

		// notes in their own CSS-columns grid
		const notes = files.filter(i => i.type === 'note');
		if (notes.length > 0) {
			hasSections.push('notes');
			const grid = this.gridWrapper.createDiv({ cls: 'masonry-grid masonry-grid-notes' });
			grid.style.columnCount = String(colCount);
			grid.style.columnGap = `${gap}px`;
			grid.style.marginTop = `${gap}px`;
			for (const item of notes) {
				this.createCardIn(grid, item);
			}
		}

		// images, videos, other files in their own grid
		const others = files.filter(i => i.type !== 'note');
		if (others.length > 0) {
			hasSections.push('others');
			const grid = this.gridWrapper.createDiv({ cls: 'masonry-grid masonry-grid-others' });
			grid.style.columnCount = String(colCount);
			grid.style.columnGap = `${gap}px`;
			grid.style.marginTop = `${gap}px`;
			for (const item of others) {
				this.createCardIn(grid, item);
			}
		}

		if (hasSections.length === 0) {
			this.gridWrapper.createDiv({ cls: 'masonry-empty' })
				.setText(q ? 'No items match your search' : this.isBoardView ? 'This board is empty — pin some items!' : 'This folder is empty');
		}
	}

	// create a card and attach all event listeners
	private createCardIn(parent: HTMLElement, item: FileItem) {
		const card = parent.createDiv({
			cls: `masonry-card ${item.isFolder ? 'masonry-folder' : ''} ${this.selected.has(item.path) ? 'masonry-selected' : ''}`,
			attr: { draggable: 'true', 'data-path': item.path },
		});
		this.buildCardContent(card, item);

		card.addEventListener('click', (e) => {
			if (e.ctrlKey || e.metaKey) {
				this.toggleSelect(item.path, card);
			} else if (e.shiftKey && this.lastSelectedEl) {
				this.rangeSelect(card);
			} else {
				this.clearSelection();
				this.selected.add(item.path);
				card.addClass('masonry-selected');
				this.lastSelectedEl = card;
			}
			this.renderTagChipsFromSelection();
		});

		card.addEventListener('dblclick', () => { void this.openItem(item); });

		card.addEventListener('dragstart', (e) => {
			const dragPaths = this.selected.has(item.path) && this.selected.size > 1 ? [...this.selected] : [item.path];
			e.dataTransfer?.setData('text/plain', item.path);
			e.dataTransfer?.setData('text/x-masonry-items', JSON.stringify(dragPaths));
			e.dataTransfer!.effectAllowed = 'move';
			card.addClass('masonry-dragging');
		});
		card.addEventListener('dragend', () => card.removeClass('masonry-dragging'));

		card.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			if (!this.selected.has(item.path)) {
				this.clearSelection();
				this.selected.add(item.path);
				card.addClass('masonry-selected');
			}
			this.showCtxMenu(e, item);
		});

		return card;
	}

	private buildCardContent(card: HTMLElement, item: FileItem) {
		const showNames = this.plugin.settings.showFileNames;
		const showTags = this.plugin.settings.showTags;

		if (item.isFolder) {
			card.addClass('masonry-folder-card');
			this.buildCardHeader(card, 'folder', item.name);
			// thumb — first image inside folder, if any
			if (item.folderThumb) {
				const thumb = card.createDiv({ cls: 'masonry-thumb' });
				const src = this.getResourcePath(item.folderThumb);
				if (src) {
					thumb.createEl('img', { cls: 'masonry-img', attr: { src, loading: 'lazy' } });
				}
			}
		} else if (item.type === 'note') {
			card.addClass('masonry-note-card');
			const displayName = item.extension === 'md' ? item.name.replace(/\.md$/i, '') : item.name;
			this.buildCardHeader(card, 'document', displayName);
			const thumb = card.createDiv({ cls: 'masonry-thumb' });
			if (item.notePreview) {
				const previewEl = thumb.createDiv({ cls: 'masonry-note-preview' });
				void MarkdownRenderer.render(this.app, item.notePreview, previewEl, item.path, this);
			} else {
				thumb.createDiv({ cls: 'masonry-note-preview masonry-note-empty', text: '— empty note —' });
			}
		} else {
			const thumb = card.createDiv({ cls: 'masonry-thumb' });
			if (item.type === 'image') {
				const src = this.getResourcePath(item.path);
				if (src) {
					const img = thumb.createEl('img', { cls: 'masonry-img', attr: { src, loading: 'lazy' } });
					img.onerror = () => img.replaceWith(createDiv({ cls: 'masonry-placeholder', text: '🖼' }));
				}
			} else {
				thumb.createDiv({ cls: 'masonry-placeholder', text: '📄' });
			}
			if (showNames) {
				const label = card.createDiv({ cls: 'masonry-label' });
				label.setText(item.name);
			}
		}

		if (showTags && (item.type === 'note' || item.tags.length > 0)) {
			const tagsEl = card.createDiv({ cls: 'masonry-tags' });
			for (const t of item.tags.slice(0, 5)) {
				tagsEl.createSpan({ cls: 'masonry-tag', text: `#${t}` });
			}
			if (item.tags.length > 5) tagsEl.createSpan({ cls: 'masonry-tag-more', text: `+${item.tags.length - 5}` });
		}
	}

	private buildCardHeader(card: HTMLElement, iconId: string, name: string): HTMLElement {
		const header = card.createDiv({ cls: 'masonry-item-header' });
		const iconEl = header.createDiv({ cls: 'masonry-item-icon' });
		setIcon(iconEl, iconId);
		header.createSpan({ cls: 'masonry-item-name', text: name });
		return header;
	}

	// ── selection ───────────────────────────────────────────

	private clearSelection() {
		this.selected.clear();
		this.gridWrapper.querySelectorAll('.masonry-selected').forEach(el => el.removeClass('masonry-selected'));
		this.lastSelectedEl = null;
	}

	private toggleSelect(path: string, card: HTMLElement) {
		if (this.selected.has(path)) { this.selected.delete(path); card.removeClass('masonry-selected'); }
		else { this.selected.add(path); card.addClass('masonry-selected'); this.lastSelectedEl = card; }
	}

	private rangeSelect(card: HTMLElement) {
		const allCards = Array.from(this.gridWrapper.querySelectorAll('.masonry-card'));
		const si = allCards.indexOf(this.lastSelectedEl!);
		const ei = allCards.indexOf(card);
		if (si === -1 || ei === -1) return;
		const [lo, hi] = si < ei ? [si, ei] : [ei, si];
		for (let i = lo; i <= hi; i++) {
			const c = allCards[i];
			const p = c.getAttr('data-path');
			if (p) { this.selected.add(p); c.addClass('masonry-selected'); }
		}
	}

	// ── item actions ────────────────────────────────────────

	async openItem(item: FileItem) {
		if (item.isFolder) { await this.loadFolderOrBoard(item.path); return; }
		const file = this.app.vault.getAbstractFileByPath(item.path);
		if (!file || !(file instanceof TFile)) return;
		if (item.type === 'image') {
			const images = this.items.filter(i => i.type === 'image');
			const idx = images.findIndex(i => i.path === item.path);
			new ImageViewModal(this.app, this.plugin, images, idx >= 0 ? idx : 0).open();
		} else {
			const leaf = this.app.workspace.getMostRecentLeaf() ?? this.app.workspace.getLeaf();
			await leaf.openFile(file);
		}
	}

	async deleteSelected(permanent: boolean) {
		if (this.selected.size === 0) return;
		// In board view, remove from board instead of deleting
		if (this.isBoardView && this.boardFile) {
			const removed = new Set(this.selected);
			for (const p of this.selected) {
				// remove pin from board
				await this.app.fileManager.processFrontMatter(this.boardFile, (fm) => {
					if (Array.isArray(fm.pins)) {
						fm.pins = fm.pins.filter((pin: string) => pin !== p);
					}
				});
			}
			new Notice(`Removed ${removed.size} pin(s) from board`);
			this.selected.clear();
			await this.loadPinBoard(this.boardFile);
			return;
		}
		for (const p of this.selected) {
			const file = this.app.vault.getAbstractFileByPath(p);
			if (!file) continue;
			try {
				if (permanent) await this.app.vault.delete(file, true);
				else if (file instanceof TFile) await this.app.fileManager.trashFile(file);
			} catch (e) { console.error('Failed to delete', p, e); }
		}
		const count = this.selected.size;
		this.selected.clear();
		this.tagBarEl.addClass('masonry-hide');
		new Notice(permanent ? `Permanently deleted ${count} item(s)` : `Moved ${count} item(s) to trash`);
		await this.loadFolderOrBoard(this.currentPath);
	}

	async pinItem(filePath: string) {
		this.selected.add(filePath);
		await this.showPinModal();
	}

	async showPinModal() {
		if (this.selected.size === 0) { new Notice('Select items first'); return; }
		const boards = this.plugin.getPinBoards();
		if (boards.length === 0) {
			new Notice('No pin boards found. Right-click a folder → Create Pin Board here.');
			return;
		}
		new PinSelectModal(this.app, this.plugin, boards, [...this.selected]).open();
	}

	private showCtxMenu(e: MouseEvent, item: FileItem) {
		const menu = new Menu();
		menu.addItem(i => i.setTitle('Open').setIcon('document').onClick(() => this.openItem(item)));
		menu.addItem(i => i.setTitle('Pin to board').setIcon('pin').onClick(async () => {
			this.selected.add(item.path);
			await this.showPinModal();
		}));
		menu.addItem(i => i.setTitle('Assign tags').setIcon('tag').onClick(() => {
			if (!this.selected.has(item.path)) { this.selected.add(item.path); }
			this.focusTagInput();
		}));
		menu.addSeparator();
		if (this.isBoardView) {
			menu.addItem(i => i.setTitle('Remove from board').setIcon('trash').onClick(async () => {
				this.selected.add(item.path);
				await this.deleteSelected(false);
			}));
		} else {
			menu.addItem(i => i.setTitle('Delete').setIcon('trash').onClick(() => {
				this.selected.add(item.path);
				void this.deleteSelected(false);
			}));
		}
		menu.showAtMouseEvent(e);
	}

	// ── drag & drop ─────────────────────────────────────────

	private async handleDropOnFolder(srcPath: string, destPath: string) {
		const destFile = this.app.vault.getAbstractFileByPath(destPath);
		if (destFile instanceof TFile) {
			if (this.plugin.isPinBoard(destFile)) {
				await this.plugin.addToPinBoard(srcPath, destFile);
				new Notice(`Pinned to "${destFile.name.replace(/\.md$/i, '')}"`);
				return;
			}
		}
		if (destFile instanceof TFolder) {
			const srcName = srcPath.split('/').pop();
			if (!srcName) return;
			const srcFile = this.app.vault.getAbstractFileByPath(srcPath);
			if (!srcFile) return;
			try {
				await this.app.fileManager.renameFile(srcFile, `${destPath}/${srcName}`);
			} catch { new Notice('Move failed'); }
		}
	}
}
