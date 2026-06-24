import { App, Plugin, PluginSettingTab, Setting, TFolder, TFile, TAbstractFile, Notice } from 'obsidian';
import { MasonryView, VIEW_TYPE_MASONRY } from './masonry-view';
import { PinSelectModal } from './modals';

type FrontMatterData = Record<string, unknown>;

export interface MasonrySettings {
	masonryFolders: string[];
	showFileNames: boolean;
	showTags: boolean;
	fileTags: Record<string, string[]>;
	itemGap: number;
	columnCount: number;
	noteCardMinHeight: number;
	noteCardMaxHeight: number;
	noteCardFontSize: number;
	folderCount: number;
}

const DEFAULT_SETTINGS: MasonrySettings = {
	masonryFolders: [],
	showFileNames: true,
	showTags: true,
	fileTags: {},
	itemGap: 10,
	columnCount: 4,
	noteCardMinHeight: 100,
	noteCardMaxHeight: 500,
	noteCardFontSize: 14,
	folderCount: 8,
};

export default class ObsidianMasonryPlugin extends Plugin {
	settings: MasonrySettings;
	private _openingBoard: boolean = false;

	async onload() {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_MASONRY, (leaf) => new MasonryView(leaf, this));
		this.app.workspace.onLayoutReady(() => this.updatePinBoardStyles());

		this.addCommand({
			id: 'open-masonry-view',
			name: 'Open Masonry View for current folder',
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (file?.parent) {
					if (!checking) void this.openMasonryView(file.parent.path);
					return true;
				}
				return false;
			},
		});

		this.addCommand({
			id: 'toggle-masonry-folder',
			name: 'Toggle masonry view for current folder',
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (file?.parent) {
					if (!checking) void this.toggleMasonryFolder(file.parent.path);
					return true;
				}
				return false;
			},
		});

		// Redirect pin-board file opens to Masonry View
		this.registerEvent(
			this.app.workspace.on('file-open', async (file) => {
				if (this._openingBoard) return;
				if (!file || file.extension !== 'md') return;
				if (this.isPinBoard(file)) {
					this._openingBoard = true;
					await this.openMasonryView(file.path);
					window.setTimeout(() => { this._openingBoard = false; }, 500);
				}
			})
		);

		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (file instanceof TFolder) {
					const isEnabled = this.settings.masonryFolders.includes(file.path);
					menu.addItem((item) => {
						item.setTitle(isEnabled ? 'Disable Masonry View' : 'Enable Masonry View')
							.setIcon('grid')
							.onClick(async () => await this.toggleMasonryFolder(file.path));
					});
					menu.addItem((item) => {
						item.setTitle('Open in Masonry View')
							.setIcon('grid-3x3')
							.onClick(async () => await this.openMasonryView(file.path));
					});
					menu.addSeparator();
					menu.addItem((item) => {
						item.setTitle('Create Pin Board here')
							.setIcon('pin')
							.onClick(async () => {
								const name = file.name + ' Board';
								const board = await this.createPinBoard(name, file.path);
								if (board) {
									new Notice(`Pin board "${name}" created`);
									this._openingBoard = true;
									await this.openMasonryView(board.path);
									window.setTimeout(() => { this._openingBoard = false; }, 500);
								}
							});
					});
				}

				if (file instanceof TFile) {
					menu.addItem((item) => {
						item.setTitle('Pin to board')
							.setIcon('pin')
							.onClick(async () => {
								const boards = this.getPinBoards();
								new PinSelectModal(this.app, this, boards, [file.path]).open();
							});
					});
				}
			})
		);

		// Keep file-explorer icons updated when metadata/pin-boards change
		this.registerEvent(
			this.app.metadataCache.on('resolved', () => this.updatePinBoardStyles())
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => this.handleRename(file, oldPath))
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => this.handleDelete(file))
		);

		this.addSettingTab(new MasonrySettingTab(this.app, this));

		// click masonry-enabled folder in file explorer → auto-open masonry view
		const doc = activeDocument;
		let lastClickPath = '';
		let lastClickTime = 0;
		this.registerDomEvent(doc, 'click', (e: MouseEvent) => {
			if (e.button !== 0) return;
			// only intercept clicks on the title text area, not the collapse indicator
			const content = (e.target as HTMLElement)?.closest('.nav-folder-title-content');
			if (!content) return;
			const title = content.closest('.nav-folder-title');
			if (!title) return;
			const path = title.getAttr('data-path');
			if (!path || !this.settings.masonryFolders.includes(path)) return;
			// double-click → let Obsidian handle expand/collapse
			const now = Date.now();
			if (path === lastClickPath && now - lastClickTime < 400) {
				lastClickPath = '';
				lastClickTime = 0;
				return;
			}
			lastClickPath = path;
			lastClickTime = now;
			e.preventDefault();
			e.stopPropagation();
			void this.openMasonryView(path);
		}, true);
	}

	onunload() {
		if (this.injectedStyleEl) {
			this.injectedStyleEl.remove();
		}
	}

	async loadSettings() {
		const data = (await this.loadData()) as Partial<MasonrySettings>;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async toggleMasonryFolder(path: string) {
		const idx = this.settings.masonryFolders.indexOf(path);
		if (idx > -1) {
			this.settings.masonryFolders.splice(idx, 1);
			new Notice(`Masonry View disabled for "${path}"`);
		} else {
			this.settings.masonryFolders.push(path);
			new Notice(`Masonry View enabled for "${path}"`);
		}
		await this.saveSettings();
		this.updatePinBoardStyles();
	}

	async openMasonryView(folderOrBoardPath?: string) {
		const path = folderOrBoardPath || '/';
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_MASONRY);
		if (leaves.length > 0) {
			void this.app.workspace.revealLeaf(leaves[0]);
			if (leaves[0].view instanceof MasonryView) {
				await leaves[0].view.loadFolderOrBoard(path);
			}
			return;
		}
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.setViewState({
			type: VIEW_TYPE_MASONRY,
			active: true,
			state: { folderPath: path },
		});
		void this.app.workspace.revealLeaf(leaf);
	}

	// ── pin boards ─────────────────────────────────────────

	isPinBoard(file: TFile): boolean {
		const cache = this.app.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter as Record<string, unknown> | undefined;
		const tags = fm?.tags;
		return (Array.isArray(tags) && tags.includes('pin-board')) ||
		       (typeof tags === 'string' && tags === 'pin-board');
	}

	getPinBoards(): TFile[] {
		return this.app.vault.getMarkdownFiles().filter(f => this.isPinBoard(f));
	}

	async createPinBoard(name: string, folderPath?: string): Promise<TFile | null> {
		const safeName = name.replace(/[\\/:*?"<>|]/g, '_');
		let fileName = `${safeName}.md`;
		let path = folderPath ? `${folderPath}/${fileName}` : fileName;
		let counter = 1;
		while (await this.app.vault.adapter.exists(path)) {
			fileName = `${safeName} ${counter}.md`;
			path = folderPath ? `${folderPath}/${fileName}` : fileName;
			counter++;
		}
		try {
			const file = await this.app.vault.create(
				path,
				`---\ntags:\n  - pin-board\npins: []\n---\n\n# ${name}\n\nYour pinned items will appear here.\n`
			);
			this.updatePinBoardStyles();
			return file;
		} catch {
			new Notice('Failed to create pin board');
			return null;
		}
	}

	private injectedStyleEl: HTMLElement | null = null;

	updatePinBoardStyles() {
		if (!this.injectedStyleEl) {
			const doc = activeDocument;
			this.injectedStyleEl = doc.createElement('style');
			this.injectedStyleEl.setAttr('data-masonry-icons', '');
			doc.head.appendChild(this.injectedStyleEl);
		}
		let css = '';
		// pin-board files → pin icon (monochrome SVG mask)
		const pinSvg = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' fill='none'%3E%3Cline x1='12' y1='17' x2='12' y2='22' stroke='white'/%3E%3Cpath d='M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z'/%3E%3C/svg%3E`;
		for (const b of this.getPinBoards()) {
			const safePath = b.path.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
			css += `.nav-file-title[data-path="${safePath}"] .nav-file-title-content::before{content:"";display:inline-block;width:1.2em;height:1.2em;margin-right:0.15em;vertical-align:middle;background-color:currentColor;-webkit-mask:url("${pinSvg}") no-repeat center;mask:url("${pinSvg}") no-repeat center;-webkit-mask-size:contain;mask-size:contain}`;
		}
		// masonry-enabled folders → 4-square grid icon (SVG mask)
		const gridSvg = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect x='3' y='3' width='8' height='8' rx='1' fill='white'/%3E%3Crect x='13' y='3' width='8' height='8' rx='1' fill='white'/%3E%3Crect x='3' y='13' width='8' height='8' rx='1' fill='white'/%3E%3Crect x='13' y='13' width='8' height='8' rx='1' fill='white'/%3E%3C/svg%3E`;
		for (const fp of this.settings.masonryFolders) {
			const safePath = fp.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
			css += `.nav-folder-title[data-path="${safePath}"] .nav-folder-title-content::before{content:"";display:inline-block;width:1.2em;height:1.2em;margin-right:0.15em;vertical-align:middle;background-color:currentColor;-webkit-mask:url("${gridSvg}") no-repeat center;mask:url("${gridSvg}") no-repeat center;-webkit-mask-size:contain;mask-size:contain}`;
		}
		this.injectedStyleEl.textContent = css;
	}

	// update pin-board pins when files/folders are renamed/moved
	private async handleRename(file: TAbstractFile, oldPath: string) {
		const newPath = file.path;
		const boards = this.getPinBoards();
		let needRefresh = false;
		for (const board of boards) {
			let changed = false;
			await this.app.fileManager.processFrontMatter(board, (fm) => {
				const data = fm as FrontMatterData;
				if (!Array.isArray(data.pins)) return;
				const updated = (data.pins as string[]).map((p: string) => {
					if (p === oldPath) { changed = true; return newPath; }
					if (p.startsWith(oldPath + '/')) {
						changed = true;
						return newPath + '/' + p.slice(oldPath.length + 1);
					}
					return p;
				});
				if (changed) data.pins = updated;
			});
			if (changed) {
				needRefresh = true;
				// refresh masonry view if currently showing this board
				for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MASONRY)) {
					if (leaf.view instanceof MasonryView && leaf.view.currentPath === board.path) {
						await leaf.view.loadFolderOrBoard(board.path);
					}
				}
			}
		}
		if (needRefresh) this.updatePinBoardStyles();
	}

	// remove deleted files/folders from all pin-board pins
	private async handleDelete(file: TAbstractFile) {
		const path = file.path;
		const boards = this.getPinBoards();
		let needRefresh = false;
		for (const board of boards) {
			let changed = false;
			await this.app.fileManager.processFrontMatter(board, (fm) => {
				const data = fm as FrontMatterData;
				if (!Array.isArray(data.pins)) return;
				const filtered = (data.pins as string[]).filter((p: string) => {
					if (p === path || p.startsWith(path + '/')) { changed = true; return false; }
					return true;
				});
				if (changed) data.pins = filtered;
			});
			if (changed) {
				needRefresh = true;
				for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MASONRY)) {
					if (leaf.view instanceof MasonryView && leaf.view.currentPath === board.path) {
						await leaf.view.loadFolderOrBoard(board.path);
					}
				}
			}
		}
		if (needRefresh) this.updatePinBoardStyles();
	}

	// normalise any path (absolute, relative, name-only) to a vault-relative path
	toVaultRelativePath(p: string): string {
		const clean = p.replace(/\\/g, '/').trim();
		const tryPath = (path: string): string | null => {
			const file = this.app.vault.getAbstractFileByPath(path);
			return file ? file.path : null;
		};
		let found = tryPath(clean);
		if (found) return found;
		// Obsidian's obsidian:// URIs strip .md
		if (!clean.match(/\.\w+$/)) {
			found = tryPath(clean + '.md');
			if (found) return found;
		}
		// strip vault base from absolute path
		try {
			const vaultPath = (this.app.vault.adapter as { getFullPath?: (path: string) => string }).getFullPath?.('/') || '';
			const norm = String(vaultPath).replace(/\\/g, '/').replace(/\/$/, '');
			if (norm && clean.startsWith(norm + '/')) {
				const rel = clean.slice(norm.length + 1);
				found = tryPath(rel);
				if (found) return found;
				if (!rel.match(/\.\w+$/)) {
					found = tryPath(rel + '.md');
					if (found) return found;
				}
			}
		} catch { /* adapter may not support getFullPath */ }
		// search by filename
		const name = clean.split('/').pop() || '';
		const all = this.app.vault.getAllLoadedFiles();
		const byName = all.filter(f => f.name === name);
		if (byName.length === 1) return byName[0].path;
		if (!name.match(/\.\w+$/)) {
			const byNameMd = all.filter(f => f.name === name + '.md');
			if (byNameMd.length === 1) return byNameMd[0].path;
		}
		const bySuffix = all.filter(f => f.path.endsWith('/' + name));
		if (bySuffix.length === 1) return bySuffix[0].path;
		return clean;
	}

	async addToPinBoard(filePath: string, board: TFile) {
		const normalized = this.toVaultRelativePath(filePath);
		await this.app.fileManager.processFrontMatter(board, (fm) => {
			const data = fm as FrontMatterData;
			if (!Array.isArray(data.pins)) data.pins = [];
			const pins = data.pins as string[];
			if (!pins.includes(normalized)) pins.push(normalized);
		});
	}

	async getPinBoardPins(board: TFile): Promise<string[]> {
		const content = await this.app.vault.read(board);
		const pins = this.parsePinsFromYaml(content);
		return pins.map(p => this.toVaultRelativePath(p));
	}

	private parsePinsFromYaml(content: string): string[] {
		const fmMatch = content.match(/^---\n([\s\S]*?)\n(?:---|\.\.\.)/);
		if (!fmMatch) return [];
		const yaml = fmMatch[1];
		// inline:  pins: [a, b, c]
		const inline = yaml.match(/^pins:\s*\[(.*?)\]\s*$/m);
		if (inline) return inline[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
		// block:  pins:\n  - a\n  - b
		if (/^pins:\s*$/m.test(yaml)) {
			const lines = yaml.split('\n');
			const start = lines.findIndex(l => /^pins:\s*$/.test(l));
			if (start === -1) return [];
			const items: string[] = [];
			for (let i = start + 1; i < lines.length; i++) {
				const item = lines[i].match(/^\s+-\s+(.+)$/);
				if (item) items.push(item[1].trim().replace(/['"]/g, ''));
				else if (lines[i].trim() && !/^\s/.test(lines[i])) break;
			}
			return items;
		}
		// single value:  pins: value
		const single = yaml.match(/^pins:\s+(.+)$/m);
		if (single) return [single[1].trim().replace(/['"]/g, '')];
		return [];
	}

	// ── tag storage (plugin data for all files) ─────────────

	getItemTags(filePath: string): string[] {
		return this.settings.fileTags?.[filePath] ?? [];
	}

	async setItemTags(filePath: string, tags: string[]) {
		if (!this.settings.fileTags) this.settings.fileTags = {};
		if (tags.length === 0) {
			delete this.settings.fileTags[filePath];
		} else {
			this.settings.fileTags[filePath] = [...tags];
		}
		// Also write to frontmatter for .md files (interop)
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (file instanceof TFile && file.extension === 'md') {
			try {
				await this.app.fileManager.processFrontMatter(file, (fm) => {
					const data = fm as FrontMatterData;
					data.tags = tags.length > 0 ? [...tags] : undefined;
				});
			} catch { /* ignore */ }
		}
		await this.saveSettings();
	}
}

class MasonrySettingTab extends PluginSettingTab {
	plugin: ObsidianMasonryPlugin;

	constructor(app: App, plugin: ObsidianMasonryPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getControlValue(key: string): unknown {
		return (this.plugin.settings as unknown as Record<string, unknown>)[key];
	}

	setControlValue(key: string, value: unknown): void {
		(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		void this.plugin.saveSettings();
		this.refreshMasonryViews();
	}

	private refreshMasonryViews() {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MASONRY)) {
			if (leaf.view instanceof MasonryView) leaf.view.render();
		}
	}

	getSettingDefinitions(): import('obsidian').SettingDefinitionItem[] {
		return [
			{
				name: 'Masonry View',
				desc: 'Right-click a folder and choose "Open in Masonry View" to browse in Pinterest-like layout.',
			},
			{ name: 'Show file names under items', desc: 'Display the filename below each masonry card', control: { type: 'toggle', key: 'showFileNames' } },
			{ name: 'Show tags under items', desc: 'Display tags below each masonry card', control: { type: 'toggle', key: 'showTags' } },
			{ name: 'Gap between items', desc: 'Spacing between cards in pixels', control: { type: 'number', key: 'itemGap' } },
			{ name: 'Column count', desc: 'Number of masonry columns', control: { type: 'number', key: 'columnCount' } },
			{ name: 'Note card min height', desc: 'Minimum card height for notes (px)', control: { type: 'number', key: 'noteCardMinHeight' } },
			{ name: 'Note card max height', desc: 'Maximum card height for notes (px) — content exceeding this is clipped', control: { type: 'number', key: 'noteCardMaxHeight' } },
			{ name: 'Note card font size', desc: 'Font size for the note preview text (px)', control: { type: 'number', key: 'noteCardFontSize' } },
			{ name: 'Folders per row', desc: 'Number of folder cards in a single row', control: { type: 'number', key: 'folderCount' } },
			{
				name: 'Masonry-enabled folders',
				render: (setting: Setting) => {
					const el = setting.controlEl;
					el.empty();
					const list = el.createEl('ul');
					if (this.plugin.settings.masonryFolders.length === 0) {
						list.createEl('li', { text: 'None' });
					} else {
						for (const p of this.plugin.settings.masonryFolders) {
							list.createEl('li', { text: p });
						}
					}
					el.createEl('hr');
					new Setting(el)
						.setName('Clear all folder assignments')
						.setDesc('Remove masonry view from all folders')
						.addButton((btn) =>
							btn.setButtonText('Clear All').setDestructive().onClick(async () => {
								this.plugin.settings.masonryFolders = [];
								await this.plugin.saveSettings();
								this.update();
								new Notice('Cleared all masonry folder settings');
							})
						);
				},
			},
		];
	}
}
