import { App, Modal, TFile, Notice, Menu, setIcon } from 'obsidian';
import type ObsidianMasonryPlugin from './main';
import { t } from './i18n';
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

		contentEl.createEl('h2', { text: t('modal.assignTagsTo', { count: this.paths.length }) });

		const input = contentEl.createEl('input', {
			cls: 'masonry-tag-input',
			attr: { placeholder: t('placeholder.tagsCsv'), type: 'text' },
		});
		input.focus();

		const btnRow = contentEl.createDiv({ cls: 'masonry-tag-actions' });
		const applyBtn = btnRow.createEl('button', { cls: 'mod-cta', text: t('btn.assign') });
		applyBtn.addEventListener('click', () => {
			const raw = input.value.trim();
			if (!raw) { new Notice(t('notice.enterTag')); return; }
			const newTags = raw.split(',').map((s) => s.trim().replace(/^#/, '')).filter(Boolean);
			if (newTags.length === 0) { new Notice(t('notice.enterTag')); return; }

			void (async () => {
				for (const p of this.paths) {
					const file = this.app.vault.getAbstractFileByPath(p);
					if (!(file instanceof TFile)) continue;
					try {
						await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
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
				new Notice(t('notice.tagsAssigned', { count: this.paths.length }));
				this.close();
			})();
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
	tagsEl!: HTMLElement;
	dimsEl!: HTMLElement;
	zoomEl!: HTMLElement;
	leftNav!: HTMLElement;
	rightNav!: HTMLElement;
	imgContainer!: HTMLElement;
	nameEl!: HTMLElement;

	private imgEls: HTMLImageElement[] = [];
	private _activeIdx = 0;
	private get _imgEl() { return this.imgEls[this._activeIdx]; }
	private _initialShow = true;
	private _boardFile: TFile | null = null;
	private _tagInputEl!: HTMLInputElement;
	private _currentPath = '';
	private scale = 1;
	private fitScale = 1;
	private fitToWindow = true;
	private translateX = 0;
	private translateY = 0;
	private _targetScale = 1;
	private _targetTranslateX = 0;
	private _targetTranslateY = 0;
	private _animId: number | null = null;
	private _navTimer: number | null = null;
	private isDragging = false;
	private dragMoved = false;
	private dragStartX = 0;
	private dragStartY = 0;
	private dragTransX = 0;
	private dragTransY = 0;

	constructor(app: App, plugin: ObsidianMasonryPlugin, images: FileItem[], startIdx: number, boardFile?: TFile | null) {
		super(app);
		this.plugin = plugin;
		this.images = images;
		this.curIdx = startIdx;
		this._boardFile = boardFile ?? null;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass('masonry-image-viewer');
		contentEl.empty();

		this.modalEl.addClass('masonry-image-modal');

		this.imgContainer = contentEl.createDiv({ cls: 'masonry-iv-container' });

		this.imgEls[0] = this.imgContainer.createEl('img', { cls: 'masonry-iv-img masonry-iv-img-active' });
		this.imgEls[1] = this.imgContainer.createEl('img', { cls: 'masonry-iv-img masonry-iv-img-hidden' });
		for (const el of this.imgEls) {
			el.addEventListener('load', this._onImgLoad);
		}

		this.leftNav = contentEl.createDiv({ cls: 'masonry-iv-nav masonry-iv-nav-left' });
		this.leftNav.setText('‹');
		this.leftNav.addEventListener('click', () => this.nav(-1));

		this.rightNav = contentEl.createDiv({ cls: 'masonry-iv-nav masonry-iv-nav-right' });
		this.rightNav.setText('›');
		this.rightNav.addEventListener('click', () => this.nav(1));

		const bottom = contentEl.createDiv({ cls: 'masonry-iv-bottom' });
		this.nameEl = bottom.createSpan({ cls: 'masonry-iv-name' });
		this.dimsEl = bottom.createSpan({ cls: 'masonry-iv-dims' });
		this.zoomEl = bottom.createSpan({ cls: 'masonry-iv-zoom' });
		bottom.createSpan({ cls: 'masonry-iv-sep', text: '|' });
		const pinBtn = bottom.createEl('button', { cls: 'masonry-iv-pin-btn' });
		setIcon(pinBtn, 'pin');
		pinBtn.addEventListener('click', (e) => {
			const rect = pinBtn.getBoundingClientRect();
			const menu = new Menu();
			const boards = this.plugin.getPinBoards();
		for (const board of boards) {
			menu.addItem((item) =>
				item.setTitle(board.name.replace(/\.md$/i, ''))
					.onClick(() => {
						void (async () => {
							await this.plugin.addToPinBoard(this._currentPath, board);
							new Notice(`Прикреплено к ${board.name.replace(/\.md$/i, '')}`);
						})();
					})
			);
		}
			menu.addSeparator();
			menu.addItem((item) =>
				item.setTitle('Создать доску')
					.onClick(() => this._pinToBoard())
			);
			menu.showAtPosition({ x: rect.left, y: rect.bottom });
		});
		this._tagInputEl = bottom.createEl('input', {
			cls: 'masonry-iv-tag-input',
			attr: { type: 'text', placeholder: 'Тег...' },
		});
		this.tagsEl = bottom.createDiv({ cls: 'masonry-iv-tags' });
		this._tagInputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				const val = this._tagInputEl.value.trim();
				if (val) void this._addTag(val);
			}
		});

		this.scope?.register([], 'ArrowLeft', () => { this.nav(-1); return false; });
		this.scope?.register([], 'ArrowRight', () => { this.nav(1); return false; });
		this.scope?.register([], 'Escape', () => { this.close(); return false; });

		this.imgContainer.addEventListener('wheel', this._onWheel, { passive: false });
		this.imgContainer.addEventListener('mousedown', this._onMouseDown);
		this.imgContainer.addEventListener('contextmenu', (e) => e.preventDefault());
		activeDocument.addEventListener('mousemove', this._onMouseMove);
		activeDocument.addEventListener('mouseup', this._onMouseUp);

		this.show(this.curIdx);

		window.requestAnimationFrame(() => {
			this.modalEl.addClass('masonry-iv-visible');
			const bg = this.modalEl.previousElementSibling as HTMLElement | null;
			if (bg) bg.addClass('masonry-iv-bg-visible');
		});
	}

	close(): void {
		this.modalEl.removeClass('masonry-iv-visible');
		const bg = this.modalEl.previousElementSibling as HTMLElement | null;
		if (bg) bg.removeClass('masonry-iv-bg-visible');
		window.setTimeout(() => super.close(), 300);
	}

	onClose() {
		if (this._animId !== null) cancelAnimationFrame(this._animId);
		if (this._navTimer !== null) window.clearTimeout(this._navTimer);
		activeDocument.removeEventListener('mousemove', this._onMouseMove);
		activeDocument.removeEventListener('mouseup', this._onMouseUp);
		this.contentEl.empty();
	}

	private _onImgLoad = (e: Event) => {
		const img = e.currentTarget as HTMLImageElement;
		this.dimsEl.setText(`${img.naturalWidth}\u00D7${img.naturalHeight}`);
		if (!this.fitToWindow) {
			img.style.width = `${img.naturalWidth}px`;
			img.style.height = `${img.naturalHeight}px`;
		}
		this._updateFitScale(img);
		this._updateZoomDisplay();
	};

	private _updateFitScale(img?: HTMLImageElement) {
		const el = img ?? this._imgEl;
		if (!this.fitToWindow || !el.naturalWidth) {
			this.fitScale = 1;
			return;
		}
		const cw = this.imgContainer.clientWidth;
		const ch = this.imgContainer.clientHeight;
		const sx = cw / el.naturalWidth;
		const sy = ch / el.naturalHeight;
		this.fitScale = Math.min(sx, sy);
	}

	private _updateZoomDisplay() {
		const pct = Math.round(this.fitScale * this.scale * 100);
		this.zoomEl.setText(`${pct}%`);
	}

	private _showContextMenu = (e: MouseEvent) => {
		e.preventDefault();
		if (this.dragMoved) return;
		const menu = new Menu();
		menu.addItem((item) =>
			item.setTitle('Масштаб → 100%')
				.onClick(() => this._setZoom100())
		);
		menu.addItem((item) =>
			item.setTitle('Центровать изображение')
				.onClick(() => this._centerImage())
		);
		menu.addItem((item) =>
			item.setTitle('Вписать в окно')
				.setChecked(this.fitToWindow)
				.onClick(() => this._toggleFitToWindow())
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item.setTitle('Открыть в проводнике')
				.setIcon('folder-open')
				.onClick(() => this._openInExplorer())
		);
		if (this._boardFile) {
			menu.addItem((item) =>
				item.setTitle('Убрать с доски')
					.setIcon('log-out')
					.onClick(() => { void this._removeFromBoard(); })
			);
		} else {
			menu.addItem((item) =>
				item.setTitle('Удалить файл')
					.setIcon('trash-2')
					.onClick(() => { void this._deleteFile(); })
			);
		}
		menu.showAtMouseEvent(e);
	};

	private _setZoom100() {
		this.fitToWindow = false;
		this._imgEl.style.width = `${this._imgEl.naturalWidth}px`;
		this._imgEl.style.height = `${this._imgEl.naturalHeight}px`;
		this._imgEl.style.removeProperty('object-fit');
		this._targetScale = 1;
		this._targetTranslateX = 0;
		this._targetTranslateY = 0;
		this.fitScale = 1;
		this._startAnim();
	}

	private _centerImage() {
		this._targetTranslateX = 0;
		this._targetTranslateY = 0;
		this._startAnim();
	}

	private _toggleFitToWindow() {
		this.fitToWindow = !this.fitToWindow;
		if (this.fitToWindow) {
			this._imgEl.style.removeProperty('object-fit');
			this._imgEl.style.removeProperty('width');
			this._imgEl.style.removeProperty('height');
			this._targetScale = 1;
			this._targetTranslateX = 0;
			this._targetTranslateY = 0;
			this._updateFitScale();
		} else {
			this._imgEl.style.width = `${this._imgEl.naturalWidth}px`;
			this._imgEl.style.height = `${this._imgEl.naturalHeight}px`;
			this._imgEl.style.removeProperty('object-fit');
			this.fitScale = 1;
			this._targetScale = 1;
			this._targetTranslateX = 0;
			this._targetTranslateY = 0;
		}
		this._startAnim();
	}

	private _renderTags() {
		const tags = this.plugin.getItemTags ? this.plugin.getItemTags(this._currentPath) : [];
		this.tagsEl.empty();
		for (const tag of tags) {
			const chip = this.tagsEl.createSpan({ cls: 'masonry-chip' });
			chip.createSpan({ cls: 'masonry-chip-label', text: `#${tag}` });
			const del = chip.createSpan({ cls: 'masonry-chip-x', text: '\u00D7' });
			del.addEventListener('click', (e) => {
				e.stopPropagation();
				void this._removeTag(tag);
			});
		}
	}

	private async _addTag(tag: string) {
		const tags = this.plugin.getItemTags ? this.plugin.getItemTags(this._currentPath) : [];
		if (!tags.includes(tag)) {
			await this.plugin.setItemTags(this._currentPath, [...tags, tag]);
		}
		this._renderTags();
		this._tagInputEl.value = '';
		this._tagInputEl.focus();
	}

	private async _removeTag(tag: string) {
		const tags = this.plugin.getItemTags ? this.plugin.getItemTags(this._currentPath) : [];
		await this.plugin.setItemTags(this._currentPath, tags.filter(t => t !== tag));
		this._renderTags();
	}

	private _pinToBoard() {
		const boards = this.plugin.getPinBoards();
		new PinSelectModal(this.app, this.plugin, boards, [this._currentPath]).open();
	}

	private _focusTagInput() {
		this._tagInputEl?.focus();
	}

	private _openInExplorer() {
		const file = this.app.vault.getAbstractFileByPath(this._currentPath);
		if (!file || !(file instanceof TFile)) return;
		try {
			const adapter = this.app.vault.adapter as unknown as { getFullPath(path: string): string };
			const fullPath = adapter.getFullPath(file.path);
			const electron = (window.require as unknown as (mod: string) => { shell: { showItemInFolder: (p: string) => void } })('electron');
			electron.shell.showItemInFolder(fullPath);
		} catch (e) {
			console.error('Failed to open in explorer', e);
		}
	}

	private async _removeFromBoard() {
		if (!this._boardFile) return;
		await this.app.fileManager.processFrontMatter(this._boardFile, (fm) => {
			const data = fm as Record<string, unknown>;
			if (Array.isArray(data.pins)) {
				data.pins = (data.pins as string[]).filter((pin: string) => pin !== this._currentPath);
			}
		});
		new Notice('Убрано с доски');
		this.close();
	}

	private async _deleteFile() {
		const file = this.app.vault.getAbstractFileByPath(this._currentPath);
		if (!file || !(file instanceof TFile)) return;
		await this.app.fileManager.trashFile(file);
		new Notice('Файл перемещён в корзину');
		this.close();
	}

	private _onWheel = (e: WheelEvent) => {
		e.preventDefault();
		const delta = e.deltaY > 0 ? -0.1 : 0.1;
		this._targetScale = Math.max(0.25, Math.min(6, this._targetScale + delta));
		this._startAnim();
	};

	private _onMouseDown = (e: MouseEvent) => {
		if (e.button !== 2) return;
		e.preventDefault();
		this.isDragging = true;
		this.dragMoved = false;
		this.dragStartX = e.clientX;
		this.dragStartY = e.clientY;
		this.dragTransX = this.translateX;
		this.dragTransY = this.translateY;
		this.imgContainer.addClass('masonry-iv-grabbing');
	};

	private _onMouseMove = (e: MouseEvent) => {
		if (!this.isDragging) return;
		this.dragMoved = true;
		this._targetTranslateX = this.dragTransX + (e.clientX - this.dragStartX);
		this._targetTranslateY = this.dragTransY + (e.clientY - this.dragStartY);
		this._startAnim();
	};

	private _onMouseUp = (e: MouseEvent) => {
		if (e.button !== 2 || !this.isDragging) return;
		this.isDragging = false;
		this.imgContainer.removeClass('masonry-iv-grabbing');
	};

	private _applyTransform() {
		this._imgEl.style.transform = `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale})`;
		this._updateZoomDisplay();
	}

	private _startAnim() {
		if (this._animId !== null) return;
		this._animId = window.requestAnimationFrame(() => this._animate());
	}

	private _animate() {
		const lerpSpeed = this.isDragging ? 0.35 : 0.18;
		this.scale += (this._targetScale - this.scale) * lerpSpeed;
		this.translateX += (this._targetTranslateX - this.translateX) * lerpSpeed;
		this.translateY += (this._targetTranslateY - this.translateY) * lerpSpeed;
		this._applyTransform();
		const done = Math.abs(this.scale - this._targetScale) < 0.001
			&& Math.abs(this.translateX - this._targetTranslateX) < 0.5
			&& Math.abs(this.translateY - this._targetTranslateY) < 0.5;
		if (done) {
			this.scale = this._targetScale;
			this.translateX = this._targetTranslateX;
			this.translateY = this._targetTranslateY;
			this._applyTransform();
			this._animId = null;
		} else {
		this._animId = window.requestAnimationFrame(() => this._animate());
		}
	}

	private _resetZoom() {
		this._targetScale = 1;
		this._targetTranslateX = 0;
		this._targetTranslateY = 0;
		this.scale = 1;
		this.translateX = 0;
		this.translateY = 0;
		this._applyTransform();
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
		const file = this.app.vault.getAbstractFileByPath(item.path);
		if (!(file instanceof TFile)) return;
		this._currentPath = item.path;

		if (this._navTimer !== null) {
			window.clearTimeout(this._navTimer);
			this._navTimer = null;
		}

		if (this._initialShow) {
			this._initialShow = false;
			this.imgEls[0].setAttr('src', this.app.vault.getResourcePath(file));
			this.nameEl.setText(item.name);
			this._renderTags();
			this.dimsEl.setText('');
			this.zoomEl.setText('');
			this.leftNav.toggleClass('masonry-iv-hidden', idx === 0);
			this.rightNav.toggleClass('masonry-iv-hidden', idx === this.images.length - 1);
			this._resetZoom();
			return;
		}

		const nextIdx = 1 - this._activeIdx;
		const prev = this.imgEls[this._activeIdx];
		const next = this.imgEls[nextIdx];

		// Copy visual state from prev to next so the cross-fade aligns
		next.style.transform = prev.style.transform || '';
		next.style.width = prev.style.width || '';
		next.style.height = prev.style.height || '';
		next.style.objectFit = prev.style.objectFit || '';

		// Start loading next image
		next.setAttr('src', this.app.vault.getResourcePath(file));
		this.leftNav.toggleClass('masonry-iv-hidden', idx === 0);
		this.rightNav.toggleClass('masonry-iv-hidden', idx === this.images.length - 1);

		// Cross-fade images: prev fades out, next fades in
		prev.addClass('masonry-iv-img-hidden');
		prev.removeClass('masonry-iv-img-active');
		next.removeClass('masonry-iv-img-hidden');
		next.addClass('masonry-iv-img-active');
		this._activeIdx = nextIdx;

		// Update tags immediately (no fade needed for chips)
		this._renderTags();

		// Text fade: fade out → update → fade in
		const textEls = [this.nameEl, this.dimsEl, this.zoomEl];
		for (const el of textEls) {
			el.addClass('masonry-iv-text-fadeout');
		}

		this._navTimer = window.setTimeout(() => {
			this.nameEl.setText(item.name);
			for (const el of textEls) {
				el.removeClass('masonry-iv-text-fadeout');
				el.addClass('masonry-iv-text-fadein');
			}
			this._navTimer = window.setTimeout(() => {
				this._navTimer = null;
				for (const el of textEls) el.removeClass('masonry-iv-text-fadein');
			}, 120);
		}, 80);
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

		contentEl.createEl('h2', { text: t('modal.addToPinBoard') });

		const row = contentEl.createDiv({ cls: 'masonry-pin-select-row' });
		const select = row.createEl('select', { cls: 'masonry-pin-select' });
		for (const board of this.boards) {
			select.createEl('option', {
				text: board.name.replace(/\.md$/i, ''),
				value: board.path,
			});
		}
		const pinBtn = row.createEl('button', { cls: 'mod-cta' });
		setIcon(pinBtn, 'pin');
		pinBtn.createSpan({ text: ' ' + t('btn.pin') });
		pinBtn.addEventListener('click', () => {
			void (async () => {
				const selectedPath = select.value;
				const board = this.boards.find(b => b.path === selectedPath);
				if (!board) return;
				for (const p of this.paths) {
					await this.plugin.addToPinBoard(p, board);
				}
				new Notice(t('notice.pinnedToBoard', { count: this.paths.length, name: board.name.replace(/\.md$/i, '') }));
				this.close();
			})();
		});

		contentEl.createEl('hr');
		const createSec = contentEl.createDiv({ cls: 'masonry-pin-create' });
		createSec.createEl('h3', { text: t('modal.createNewBoard') });
		const input = createSec.createEl('input', {
			cls: 'masonry-pin-name-input',
			attr: { placeholder: t('placeholder.boardName'), type: 'text' },
		});
		const createBtn = createSec.createEl('button', { text: t('btn.createAndPin') });
		createBtn.addEventListener('click', () => {
			void (async () => {
				const name = input.value.trim();
				if (!name) { new Notice(t('notice.enterName')); return; }
				const file = await this.plugin.createPinBoard(name);
				if (!file) return;
				for (const p of this.paths) {
					await this.plugin.addToPinBoard(p, file);
				}
				new Notice(t('notice.boardCreatedWith', { name, count: this.paths.length }));
				this.close();
			})();
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}
