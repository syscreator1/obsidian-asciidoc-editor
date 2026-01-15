import { FileView, TFile, WorkspaceLeaf, TAbstractFile } from "obsidian";
import { renderAsciidocToHtml } from "../asciidoctor/renderer";
import type AsciiDocPlugin from "../main";

export const VIEW_TYPE_ASCIIDOC_PREVIEW = "asciidoc-preview-view";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[c]
  );
}

export class AsciidocPreviewView extends FileView {
  private plugin: AsciiDocPlugin;

  private currentFile: TFile | null = null;
  private deps = new Set<string>();

  private previewEl: HTMLDivElement | null = null;
  private statusEl: HTMLDivElement | null = null;

  private searchEl: HTMLDivElement | null = null;
  private searchInput: HTMLInputElement | null = null;

  private searchHits: HTMLElement[] = [];
  private searchIndex = -1;

  private rootEl: HTMLDivElement | null = null;

  private zoomScale = 1.0;
  private zoomSlider: HTMLInputElement | null = null;
  private zoomLabel: HTMLSpanElement | null = null;

  // 競合防止：レンダー世代
  private renderSeq = 0;

  // debounce
  private renderTimer: number | null = null;

  private followActiveEditor = true;
  private lastEditorLeaf: WorkspaceLeaf | null = null;
  private shouldReturnFocusOnOpen = true;

  // handlers
  private modifyHandler: ((af: TAbstractFile) => void) | null = null;
  private renameHandler: ((file: TFile, oldPath: string) => void) | null = null;
  private deleteHandler: ((file: TFile) => void) | null = null;
  private activeLeafChangeHandler: (() => void) | null = null;

  private lastQuery = "";
  private svgHitNodes: SVGTextElement[] = [];
  private svgHitTexts: SVGTextElement[] = [];
  private svgHitRects: (SVGRectElement | null)[] = [];
  private svgHitIndex = -1;

  private searchCounterEl: HTMLSpanElement | null = null;
  private searchMode: "block" | "text" = "text";

  private isPanning = false;
  private panTarget: HTMLElement | null = null;
  private panStartX = 0;
  private panStartY = 0;
  private panStartScrollLeft = 0;
  private panStartScrollTop = 0;

  private downX = 0;
  private downY = 0;
  private moved = false;

  constructor(leaf: WorkspaceLeaf, plugin: AsciiDocPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  private bindPanHandlers(container: HTMLElement) {
    const wraps = container.querySelectorAll<HTMLElement>(".kroki-diagram-wrap");

    wraps.forEach((wrap) => {
      // すでに付いてたら二重登録しない（renderごとにDOMが変わるので保険）
      if ((wrap as any).__krokiPanBound) return;
      (wrap as any).__krokiPanBound = true;

      wrap.addEventListener("mousedown", this.onPanMouseDown, true);
    });
  }

  private onPreviewMouseDown = (ev: MouseEvent) => {
    if (ev.button !== 0) return;
    this.downX = ev.clientX;
    this.downY = ev.clientY;
    this.moved = false;
  };

  private onPreviewMouseMove = (ev: MouseEvent) => {
    // 左ボタン押下中だけ
    if ((ev.buttons & 1) === 0) return;

    const dx = Math.abs(ev.clientX - this.downX);
    const dy = Math.abs(ev.clientY - this.downY);
    if (dx > 4 || dy > 4) this.moved = true;
  };

  private onPreviewMouseUp = (ev: MouseEvent) => {
    if (ev.button !== 0) return;

    const t = ev.target as HTMLElement | null;
    if (!t) return;

    // ★A方針：図の上では「クリックでもドラッグでも」Editorに戻さない
    if (t.closest(".kroki-diagram-wrap")) return;

    // 図の外（Preview背景など）の“クリック”だけ戻す（ここがAの肝）
    if (this.moved) return;

    if (this.followActiveEditor && this.lastEditorLeaf) {
      this.app.workspace.setActiveLeaf(this.lastEditorLeaf, { focus: true });
    }
  };

  private onPanMouseDown = (ev: MouseEvent) => {
    // 左クリックのみ
    if (ev.button !== 0) return;

    this.isPanning = true;

    // ★パン中はPreviewをアクティブにする（イベントを確実に拾う）
    this.app.workspace.setActiveLeaf(this.leaf, { focus: true });

    const target = ev.target as HTMLElement | null;
    if (!target) return;

    // 操作系（リンク、ボタン、入力、SVG内リンク等）はパンしない
    const interactive = target.closest(
      'a, button, input, textarea, select, summary, details, [role="button"], [contenteditable="true"]'
    );
    if (interactive) return;

    const wrap = (target.closest(".kroki-diagram-wrap") as HTMLElement | null);
    if (!wrap) return;

    // ここでパン開始
    this.isPanning = true;
    this.panTarget = wrap;
    this.panStartX = ev.clientX;
    this.panStartY = ev.clientY;
    this.panStartScrollLeft = wrap.scrollLeft;
    this.panStartScrollTop = wrap.scrollTop;

    wrap.classList.add("is-panning");

    // Obsidianのフォーカス/選択を抑止
    ev.preventDefault();
    ev.stopPropagation();

    window.addEventListener("mousemove", this.onPanMouseMove, true);
    window.addEventListener("mouseup", this.onPanMouseUp, true);
  };

  private onPanMouseMove = (ev: MouseEvent) => {
    if (!this.isPanning || !this.panTarget) return;

    const dx = ev.clientX - this.panStartX;
    const dy = ev.clientY - this.panStartY;

    // ドラッグ方向と逆にスクロール
    this.panTarget.scrollLeft = this.panStartScrollLeft - dx;
    this.panTarget.scrollTop = this.panStartScrollTop - dy;

    ev.preventDefault();
  };

  private onPanMouseUp = (_ev: MouseEvent) => {
    if (this.panTarget) this.panTarget.classList.remove("is-panning");

    this.isPanning = false;
    this.panTarget = null;

    window.removeEventListener("mousemove", this.onPanMouseMove, true);
    window.removeEventListener("mouseup", this.onPanMouseUp, true);

    if (this.followActiveEditor && this.lastEditorLeaf) {
      window.setTimeout(() => {
        this.app.workspace.setActiveLeaf(this.lastEditorLeaf!, { focus: true });
      }, 0);
    }    
  };
  

  private onPreviewWheel = (ev: WheelEvent) => {
    // Ctrl + ホイールだけ拾う（普通スクロールは邪魔しない）
    if (!ev.ctrlKey) return;

    // ブラウザズーム等を抑止
    ev.preventDefault();
    ev.stopPropagation();

    // wheel: 下で縮小 / 上で拡大 にする（好みで逆でもOK）
    const delta = ev.deltaY;
    const step = ev.shiftKey ? 0.2 : 0.1; // Shift押しながらで大きく

    let scale = this.zoomScale + (delta > 0 ? -step : step);

    // 50%〜200%（スライダーと同じ範囲）
    scale = Math.max(0.5, Math.min(2.0, scale));

    this.setZoomScale(scale);
  };

  getViewType(): string {
    return VIEW_TYPE_ASCIIDOC_PREVIEW;
  }

  getDisplayText(): string {
    return "Asciidoc Preview";
  }

  canAcceptExtension(extension: string): boolean {
    return extension.toLowerCase() === "adoc";
  }

  async setState(state: any, result: any): Promise<void> {
    // ★ follow 状態の復元
    if (typeof state?.follow === "boolean") {
      this.followActiveEditor = state.follow;
    }

    if (typeof state?.returnToEditor === "boolean") {
      this.shouldReturnFocusOnOpen = state.returnToEditor;
    }

    // ★ file の復元
    if (state?.file && typeof state.file === "string") {
      const af = this.app.vault.getAbstractFileByPath(state.file);
      if (af instanceof TFile) {
        await this.loadFile(af);
        return;
      }
    }

    await super.setState(state, result);
  }

  getState(): any {
    return {
      file: this.currentFile?.path ?? null,
      follow: this.followActiveEditor,
    };
  }

  async loadFile(file: TFile): Promise<void> {
    this.currentFile = file;
    this.updateStatusBadge();
    this.queueRender(0);
  }

  async onOpen(): Promise<void> {
    // container は一度だけ作って使い回す
    this.contentEl.empty();

    // root（固定UI + 内容領域を分離）
    this.rootEl = this.contentEl.createDiv({ cls: "asciidoc-preview-root" });

    // ===== Search UI（固定）=====
    this.searchEl = this.rootEl.createDiv({ cls: "asciidoc-preview-search" });

    this.searchInput = this.searchEl.createEl("input", {
      type: "search",
      placeholder: "Search diagrams (PlantUML source)…",
    });

    const btnPrev = this.searchEl.createEl("button", { text: "◀" });
    const btnNext = this.searchEl.createEl("button", { text: "▶" });
    const btnFlash = this.searchEl.createEl("button", { text: "⚡" });
    btnFlash.title = "Flash current hit";
    const btnClear = this.searchEl.createEl("button", { text: "✕" });
    const modeWrap = this.searchEl.createDiv({ cls: "kroki-search-mode" });

    const btnBlock = modeWrap.createEl("button", { text: "図" });
    const btnText = modeWrap.createEl("button", { text: "文字" });

    const updateModeUi = () => {
      btnBlock.classList.toggle("is-active", this.searchMode === "block");
      btnText.classList.toggle("is-active", this.searchMode === "text");
    };


    // ===== Zoom UI =====
    const zoomWrap = this.searchEl.createDiv({ cls: "kroki-zoom-ui" });

    this.zoomSlider = zoomWrap.createEl("input", {
      type: "range",
    });
    this.zoomSlider.min = "50";
    this.zoomSlider.max = "200";
    this.zoomSlider.step = "10";
    this.zoomSlider.value = String(this.zoomScale * 100);

    this.zoomLabel = zoomWrap.createSpan({
      text: `${Math.round(this.zoomScale * 100)}%`,
    });

    this.zoomSlider.addEventListener("input", () => {
      const v = Number(this.zoomSlider!.value);
      this.zoomScale = v / 100;
      this.zoomLabel!.setText(`${v}%`);
      this.applyZoom();
    });

    btnFlash.onclick = () => {
      if (this.searchMode === "text") {
        this.scrollAndFlashCurrentSvgHit();
      } else {
        this.scrollAndFlashCurrentDiagramHit();
      }
    };

    // 設定のデフォルトズームを適用（50〜200）
    const pct = Math.max(50, Math.min(200, this.plugin.settings.zoomDefaultPct ?? 100));
    this.zoomScale = pct / 100;

    this.zoomSlider.value = String(Math.round(this.zoomScale * 100));
    this.zoomLabel.setText(`${Math.round(this.zoomScale * 100)}%`);

    const btnReset = zoomWrap.createEl("button", { text: "100%" });
    btnReset.onclick = () => this.setZoomScale(1.0);

    btnBlock.onclick = () => {
      this.searchMode = "block";
      updateModeUi();
      // モード切替時は同じクエリで再検索
      const q = this.searchInput?.value ?? "";
      this.runDiagramSearch(q);
      this.clearSvgHighlights();
      this.updateCounter(); // counterは文字モード用なら0/0になる
    };

    btnText.onclick = () => {
      this.searchMode = "text";
      updateModeUi();
      const q = this.searchInput?.value ?? "";
      this.clearDiagramSearch();
      this.highlightSvgText(q);
      this.updateCounter();
    };

    updateModeUi();

    this.searchCounterEl = this.searchEl.createSpan({
      cls: "kroki-search-counter",
      text: "0 / 0",
    });

    btnNext.after(this.searchCounterEl);

    this.searchInput.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      ev.stopPropagation();

      const dir = ev.shiftKey ? -1 : 1;

      if (this.searchMode === "block") this.gotoSearchHit(dir);
      else this.gotoSvgHit(dir);

      this.updateCounter();
    });

    this.searchInput.addEventListener("input", () => {
      const q = this.searchInput!.value;

      if (this.searchMode === "block") {
        this.clearSvgHighlights();
        this.runDiagramSearch(q);
        // 図モードで件数も出したいなら、別カウンタを作る（今は文字用なので0/0でもOK）
        this.updateCounter();
      } else {
        this.clearDiagramSearch();
        this.highlightSvgText(q);
        this.updateCounter();
      }
    });

    this.searchInput.placeholder =
      "Search diagrams (Enter: next / Shift+Enter: prev)";

    btnPrev.onclick = () => {
      if (this.searchMode === "block") this.gotoSearchHit(-1);
      else this.gotoSvgHit(-1);
      this.updateCounter();
    };

    btnNext.onclick = () => {
      if (this.searchMode === "block") this.gotoSearchHit(1);
      else this.gotoSvgHit(1);
      this.updateCounter();
    };

    btnClear.onclick = () => {
      if (this.searchInput) this.searchInput.value = "";
      this.clearDiagramSearch();
    };

    // ===== Preview content（ここだけ renderImpl が書き換える）=====
    this.previewEl = this.rootEl.createDiv({ cls: "asciidoc-preview" });
    this.previewEl.addEventListener("mousedown", this.onPreviewMouseDown, true);
    this.previewEl.addEventListener("mousemove", this.onPreviewMouseMove, true);
    this.previewEl.addEventListener("mouseup", this.onPreviewMouseUp, true);
    this.previewEl.addEventListener("wheel", this.onPreviewWheel, { passive: false });

    this.containerEl.addEventListener("mouseup", this.onLeafMouseUp, true);

    // ★ 状態バッジ（Follow / Pinned）
    this.statusEl = this.searchEl.createDiv({ cls: "asciidoc-preview-status" });
    this.updateStatusBadge();

     // modify は TAbstractFile が来るのでそれで受ける
    this.modifyHandler = (af: TAbstractFile) => {
      const p = (af as any)?.path as string | undefined;
      if (!p) return;
      if (this.deps.has(p)) this.queueRender();
    };
    this.app.vault.on("modify", this.modifyHandler);

    this.renameHandler = (f: TFile, oldPath: string) => {
      if (this.deps.has(oldPath) || this.deps.has(f.path)) this.queueRender();
    };
    this.app.vault.on("rename", this.renameHandler);

    this.deleteHandler = (f: TFile) => {
      if (this.deps.has(f.path)) this.queueRender();
    };
    this.app.vault.on("delete", this.deleteHandler);

    this.activeLeafChangeHandler = () => {
      const activeLeaf = this.app.workspace.activeLeaf;
      if (!activeLeaf) return;

      if (activeLeaf.view !== this) {
        this.lastEditorLeaf = activeLeaf;
      }      

      if (!this.followActiveEditor) return;

      // 自分自身がアクティブになった場合は無視（無限ループ防止）
      if (activeLeaf.view === this) return;

      const file = this.app.workspace.getActiveFile();
      if (file && file.extension.toLowerCase() === "adoc") {
        // 同じファイルなら何もしない
        if (this.currentFile?.path === file.path) return;
        void this.loadFile(file);
      }
    };
    this.app.workspace.on("active-leaf-change", this.activeLeafChangeHandler);

    this.addAction("pin", "Toggle Pin (Follow/Pinned)", () => {
      this.followActiveEditor = !this.followActiveEditor;
      this.updateStatusBadge();

      if (this.lastEditorLeaf) {
        this.app.workspace.setActiveLeaf(this.lastEditorLeaf, { focus: true });
      }
    });

    // ★ 初期追従：開いた瞬間にアクティブな .adoc を掴む
    if (this.followActiveEditor && !this.currentFile) {
      const f = this.app.workspace.getActiveFile();
      if (f && f.extension.toLowerCase() === "adoc") {
        this.currentFile = f;
      }
    }

    // ★ Previewを開いた直後はPreview leafがアクティブになりがちなので editor に戻す
    if (this.shouldReturnFocusOnOpen && this.lastEditorLeaf) {
      window.setTimeout(() => {
        if (this.lastEditorLeaf) {
          this.app.workspace.setActiveLeaf(this.lastEditorLeaf, { focus: true });
        }
      }, 0);
    }

    // 初期描画（すでに currentFile がセット済みなら）
    this.queueRender(0);
  }

  async onClose(): Promise<void> {
    if (this.modifyHandler) this.app.vault.off("modify", this.modifyHandler);
    if (this.renameHandler) this.app.vault.off("rename", this.renameHandler);
    if (this.deleteHandler) this.app.vault.off("delete", this.deleteHandler);
    if (this.activeLeafChangeHandler) {
      this.app.workspace.off("active-leaf-change", this.activeLeafChangeHandler);
    }

    this.modifyHandler = null;
    this.renameHandler = null;
    this.deleteHandler = null;
    this.activeLeafChangeHandler = null;
    this.clearDiagramSearch();
    this.searchInput = null;
    this.searchEl = null;
    this.rootEl = null;

    if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
    this.renderTimer = null;

    this.containerEl.removeEventListener("mouseup", this.onLeafMouseUp, true);
    this.previewEl?.removeEventListener("wheel", this.onPreviewWheel as any);
    this.previewEl?.removeEventListener("mousedown", this.onPreviewMouseDown, true);
    this.previewEl?.removeEventListener("mousemove", this.onPreviewMouseMove, true);
    this.previewEl?.removeEventListener("mouseup", this.onPreviewMouseUp, true);
    
    this.previewEl = null;

    window.removeEventListener("mousemove", this.onPanMouseMove, true);
    window.removeEventListener("mouseup", this.onPanMouseUp, true);

  }

  private scrollAndFlashCurrentSvgHit() {
    if (this.svgHitIndex < 0) return;

    const t = this.svgHitTexts[this.svgHitIndex];
    const r = this.svgHitRects[this.svgHitIndex] ?? null;
    if (!t) return;

    // ★中央へ寄せて、見えたらフラッシュ（すでにあなたの実装がある前提）
    this.scrollSvgHitIntoView(t, r);
  }

  private flashCurrentSvgHit() {
    if (this.svgHitIndex < 0) return;

    const t = this.svgHitTexts[this.svgHitIndex];
    const r = this.svgHitRects[this.svgHitIndex] ?? null;
    if (!t) return;

    this.flashEl(t);
    if (r) this.flashEl(r);
  }

  private flashCurrentDiagramHit() {
    if (this.searchIndex < 0) return;

    const el = this.searchHits[this.searchIndex];
    if (!el) return;

    this.flashEl(el);
  }


  private applyZoom() {
    if (!this.previewEl) return;

    const targets = this.previewEl.querySelectorAll<HTMLElement>(
      ".kroki-diagram-wrap svg, .kroki-diagram-wrap img.kroki-diagram"
    );

    targets.forEach((el) => {
      el.classList.add("kroki-diagram-zoom");
      el.style.transform = `scale(${this.zoomScale})`;
    });
  }

  private isInPreviewViewport(el: Element): boolean {
    const preview = this.previewEl;
    if (!preview) return false;

    const pr = preview.getBoundingClientRect();
    const er = (el as any).getBoundingClientRect?.() as DOMRect | undefined;
    if (!er) return false;

    return (
      er.right > pr.left &&
      er.left < pr.right &&
      er.bottom > pr.top &&
      er.top < pr.bottom
    );
  }

  private flashWhenVisibleInPreview(target: Element | null, timeoutMs = 1200) {
    if (!target) return;

    const start = performance.now();
    const tick = () => {
      if (!document.contains(target)) return;

      if (this.isInPreviewViewport(target)) {
        requestAnimationFrame(() => this.flashEl(target));
        return;
      }

      if (performance.now() - start > timeoutMs) {
        this.flashEl(target);
        return;
      }

      requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
  }

  private scrollAndFlashDiagramHit(el: HTMLElement) {
    // current付与は呼び出し側でOK（ここではやらない）
    el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });

    // ★見えるようになってからフラッシュ
    this.flashWhenVisibleInPreview(el, 1200);
  }

  private scrollAndFlashCurrentDiagramHit() {
    if (this.searchIndex < 0) return;
    const el = this.searchHits[this.searchIndex];
    if (!el) return;

    // ★中央へ
    el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });

    // ★見えたらフラッシュ
    this.flashWhenVisibleInPreview(el, 1200);
  }

  /** render の入口はここだけにする（debounce） */
  private queueRender(delayMs = 120) {
    if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      void this.renderImpl();
    }, delayMs);
  }

  /** 実レンダー（競合防止付き） */
  private async renderImpl(): Promise<void> {
    const container = this.previewEl;
    if (!container) return;

    if (!this.currentFile) {
      container.innerHTML = `<div>No file loaded.</div>`;
      return;
    }

    const seq = ++this.renderSeq;

    try {
      const result = await renderAsciidocToHtml(this.app, this.plugin, this.currentFile);

      // 古い render 結果は捨てる
      if (seq !== this.renderSeq) return;

      this.deps = new Set(result.deps ?? []);
      container.innerHTML = result.html ?? "";

      // パン用イベントを付与（図が再描画されても動くように）
      this.bindPanHandlers(container);

      if (this.searchInput) this.searchInput.value = "";
      this.clearDiagramSearch();
      this.clearSvgHighlights();
      this.applyZoom();

    } catch (e: any) {
      if (seq !== this.renderSeq) return;

      const msg = e?.stack ? String(e.stack) : String(e);
      container.innerHTML = `<pre class="adoc-error">${esc(msg)}</pre>`;
    }
  }

  private setZoomScale(scale: number) {
    this.zoomScale = scale;

    const pct = Math.round(this.zoomScale * 100);

    if (this.zoomSlider) this.zoomSlider.value = String(pct);
    if (this.zoomLabel) this.zoomLabel.setText(`${pct}%`);

    // 最後に使った値として保存（好みでON/OFF可能）
    this.plugin.settings.zoomDefaultPct = Math.round(this.zoomScale * 100);
    void this.plugin.saveSettings();

    this.applyZoom();
  }

  // private onPreviewMouseDown = (ev: MouseEvent) => {
  //   // パン中/パン開始はEditorに戻さない（パンが潰れるので）
  //   if (this.isPanning) return;

  //   // Follow ON のときだけ（Pinned で触れないのは不便）
  //   if (!this.followActiveEditor) return;

  //   // すでに editor が分かっている時だけ
  //   if (!this.lastEditorLeaf) return;

  //   const t = ev.target as HTMLElement | null;
  //   if (!t) return;

  //   // 図の上での操作は、パン等のためEditorに戻さない
  //   if (t.closest(".kroki-diagram-wrap")) return;

  //   // クリック対象が操作系ならフォーカスを奪わない
  //   // （リンク、ボタン、入力、詳細、要素内のクリックなど）
  //   const interactive = t.closest(
  //     'a, button, input, textarea, select, summary, details, [role="button"], [contenteditable="true"]'
  //   );
  //   if (interactive) return;

  //   // 左クリックのみ（右クリックメニューなどを壊さない）
  //   if (ev.button !== 0) return;

  //   // Preview がアクティブになる前に editor へ戻す
  //   this.app.workspace.setActiveLeaf(this.lastEditorLeaf, { focus: true });
  // };

  private onLeafMouseUp = (ev: MouseEvent) => {
    // パン中/パン開始はEditorに戻さない（パンが潰れるので）
    if (this.isPanning) return;

    if (!this.followActiveEditor) return;

    // 左クリックだけ
    if (ev.button !== 0) return;

    const t = ev.target as HTMLElement | null;
    if (!t) return;

    // 図の上での操作は、パン等のためEditorに戻さない
    if (t.closest(".kroki-diagram-wrap")) return;

    // 操作系は戻さない（リンク等を壊さない）
    const interactive = t.closest(
      'a, button, input, textarea, select, summary, details, [role="button"], [contenteditable="true"]'
    );
    if (interactive) return;

    const editorLeaf = this.findEditorLeafForCurrentFile() ?? this.lastEditorLeaf;
    if (!editorLeaf) return;

    // Obsidianに勝つため次フレームで戻す（rAF×2）
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.app.workspace.setActiveLeaf(editorLeaf, { focus: true });
      });
    });
  };

  private updateStatusBadge() {
    if (!this.statusEl) return;

    this.statusEl.empty();

    const isFollow = this.followActiveEditor;
    const modeText = isFollow ? "Follow" : "Pinned";
    const cls = isFollow ? "is-follow" : "is-pinned";

    const badge = this.statusEl.createSpan({
      cls: `adoc-mode-badge ${cls}`,
      text: modeText,
    });

    badge.setAttr("role", "button");
    badge.setAttr("tabindex", "0");
    badge.setAttr("aria-label", "Toggle Follow / Pinned");

    // ★クリックで切替
    const toggle = () => {
      this.followActiveEditor = !this.followActiveEditor;
      this.updateStatusBadge();

      const editorLeaf = this.findEditorLeafForCurrentFile() ?? this.lastEditorLeaf;
      if (editorLeaf) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            this.app.workspace.setActiveLeaf(editorLeaf, { focus: true });
          });
        });
      }

      // 状態を保存したいなら state に持たせる／settings に持たせる
      // （今は view state の follow で復元しているので不要ならこのままでOK）
    };

    badge.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggle();
    });

    badge.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      ev.stopPropagation();
      toggle();
    });

    // お好みで、表示中のファイル名も出す
    if (this.currentFile) {
      const file = this.statusEl.createSpan({ cls: "adoc-mode-file" });
      file.setText(this.currentFile.name);
    }
  }


  private findEditorLeafForCurrentFile(): WorkspaceLeaf | null {
    const file = this.currentFile;
    if (!file) return null;

    const leaves = this.app.workspace.getLeavesOfType("markdown");
    for (const leaf of leaves) {
      const v: any = leaf.view as any;
      const vf: TFile | null | undefined = v?.file;
      if (vf?.path === file.path) return leaf;
    }
    return null;
  }

  private runDiagramSearch(query: string) {
    this.clearDiagramSearch();
    this.lastQuery = (query ?? "").trim();
    if (!this.lastQuery) return;

    const qLower = this.lastQuery.toLowerCase();

    const wraps = this.previewEl?.querySelectorAll<HTMLElement>(".kroki-diagram-wrap");
    if (!wraps) return;

    this.searchHits = [];
    for (const wrap of Array.from(wraps)) {
      const idx = wrap.querySelector<HTMLElement>(".kroki-search-index");
      const text = idx?.textContent?.toLowerCase() ?? "";

      if (text.includes(qLower)) {
        wrap.classList.add("is-search-hit");
        this.searchHits.push(wrap);

        // ★ヒット語バッジを付与（見えるハイライト）
        this.attachHitBadge(wrap, this.lastQuery);
      }
    }

    if (this.searchHits.length > 0) {
      this.searchIndex = 0;
      const searchHit = this.searchHits[0];
      if (searchHit) {
        this.setCurrentHit(searchHit);
        this.scrollAndFlashDiagramHit(searchHit);
      }
    }
  }

  private gotoSearchHit(dir: number) {
    if (this.searchHits.length === 0) return;

    this.searchIndex =
      (this.searchIndex + dir + this.searchHits.length) % this.searchHits.length;

    const el = this.searchHits[this.searchIndex];
    if (!el) return;
    this.setCurrentHit(el);
    this.scrollAndFlashDiagramHit(el);
  }

  private setCurrentHit(el: HTMLElement) {
    // いったん全て解除
    this.searchHits.forEach((h) => h.classList.remove("is-search-current"));
    el.classList.add("is-search-current");
  }

  private clearDiagramSearch() {
    // 枠解除
    this.searchHits.forEach((el) => el.classList.remove("is-search-hit", "is-search-current"));

    // バッジ削除
    const badges = this.previewEl?.querySelectorAll(".kroki-hit-badge");
    badges?.forEach((b) => b.remove());

    this.searchHits = [];
    this.searchIndex = -1;
    this.lastQuery = "";
  }

  private scrollToHit(el: HTMLElement) {
    el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  }

  private attachHitBadge(wrap: HTMLElement, query: string) {
    // すでに付いていれば付け直し
    wrap.querySelector(".kroki-hit-badge")?.remove();

    const badge = document.createElement("div");
    badge.className = "kroki-hit-badge";
    badge.innerHTML = this.buildHighlightedText(`Hit: ${query}`, query);

    // wrap の先頭に挿入（図の上に出る）
    wrap.prepend(badge);
  }

  private buildHighlightedText(text: string, query: string): string {
    const t = text ?? "";
    const q = (query ?? "").trim();
    if (!q) return this.escapeHtmlForUi(t);

    // 大文字小文字無視で <mark> を入れる
    const re = new RegExp(this.escapeRegExp(q), "ig");
    const escaped = this.escapeHtmlForUi(t);

    // escaped済み文字列に対して mark を入れるのは安全にやる必要があるので、
    // ここは単純化：表示文に query をそのまま入れているだけなので置換対象は query 部分だけ。
    // （一般化したいなら TextNode 分割方式にします）
    return escaped.replace(re, (m) => `<mark>${m}</mark>`);
  }

  private escapeHtmlForUi(s: string): string {
    return (s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[c]
    );
  }

  private escapeRegExp(s: string): string {
    return (s ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  
  private highlightSvgText(query: string) {
    this.clearSvgHighlights();
    const q = (query ?? "").trim().toLowerCase();
    if (!q) return;

    const wraps = this.previewEl?.querySelectorAll<HTMLElement>(".kroki-diagram-wrap");
    if (!wraps) return;

    for (const wrap of Array.from(wraps)) {
      const svg = wrap.querySelector<SVGSVGElement>("svg");
      if (!svg) continue;

      const texts = svg.querySelectorAll<SVGTextElement>("text");
      for (const t of Array.from(texts)) {
        const s = (t.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
        if (!s) continue;
        if (!s.includes(q)) continue;

        t.classList.add("kroki-svg-text-hit");
        this.svgHitTexts.push(t);

        // ★ 背景は「親グループ内の rect」を塗る（BBox不要で確実）
        const rect = this.findHighlightRectForText(t);
        if (rect) rect.classList.add("kroki-svg-rect-hit");
        this.svgHitRects.push(rect);
      }
    }

    if (this.svgHitTexts.length > 0) {
      this.svgHitIndex = 0;
      this.setCurrentSvgHit(this.svgHitIndex);
      const svgHitText = this.svgHitTexts[0];
      if (svgHitText) {
        this.scrollSvgHitIntoView(svgHitText);
        this.updateCounter();
      }
    }
  }

  private findHighlightRectForText(textEl: SVGTextElement): SVGRectElement | null {
    // 典型：<g class="cluster">...<rect>...<text>...</g>
    // 近い祖先から rect を探す
    let el: Element | null = textEl;

    for (let i = 0; i < 6 && el; i++) {
      // その階層内の最初の rect を候補にする
      const rect = el.querySelector?.("rect") as SVGRectElement | null;
      if (rect) return rect;

      el = el.parentElement;
    }

    // fallback：同じ親の直前/直後を探す（稀）
    const parent = textEl.parentElement;
    if (parent) {
      const sibRect = parent.querySelector("rect") as SVGRectElement | null;
      if (sibRect) return sibRect;
    }

    return null;
  }

  private setCurrentSvgHit(index: number) {
    // text current
    this.svgHitTexts.forEach((t) => t.classList.remove("kroki-svg-current"));
    const t = this.svgHitTexts[index];
    if (t) t.classList.add("kroki-svg-current");

    // rect current
    this.svgHitRects.forEach((r) => r?.classList.remove("kroki-svg-rect-current"));
    const r = this.svgHitRects[index];
    r?.classList.add("kroki-svg-rect-current");

    if (t) {
      this.flashEl(t);
    }
    if (r) {
      this.flashEl(r);
    }
  }

  private gotoSvgHit(dir: number) {
    if (this.svgHitTexts.length === 0) return;

    this.svgHitIndex =
      (this.svgHitIndex + dir + this.svgHitTexts.length) % this.svgHitTexts.length;

    this.setCurrentSvgHit(this.svgHitIndex);
    const svgHitText = this.svgHitTexts[this.svgHitIndex];
    if (svgHitText) {
      this.scrollSvgHitIntoView(svgHitText);
      this.updateCounter();
    }
  }

  private scrollSvgHitIntoView(textEl: SVGTextElement, rectEl?: SVGRectElement | null) {
    const wrap = (textEl as any).closest?.(".kroki-diagram-wrap") as HTMLElement | null;
    if (!wrap) {
      // fallback（効けばOK）
      (textEl as any).scrollIntoView?.({ behavior: "smooth", block: "center" });
      requestAnimationFrame(() => {
        this.flashEl(textEl);
        if (rectEl) this.flashEl(rectEl);
      });
      return;
    }

    // ★まず図（wrap）自体を Preview の中央に持ってくる（縦位置）
    wrap.scrollIntoView({ behavior: "smooth", block: "center" });

    // ★次に wrap の中で text の位置へ、上下左右とも中央に寄せる
    const wrapRect = wrap.getBoundingClientRect();
    const textRect = (textEl as any).getBoundingClientRect?.() as DOMRect | undefined;
    if (!textRect) return;

    // wrap 内座標へ変換（現在の scroll を加味）
    const xInWrap = (textRect.left - wrapRect.left) + wrap.scrollLeft;
    const yInWrap = (textRect.top - wrapRect.top) + wrap.scrollTop;

    // 中央にしたい目標スクロール位置
    const targetLeft = xInWrap - wrap.clientWidth / 2;
    const targetTop  = yInWrap - wrap.clientHeight / 2;

    wrap.scrollTo({
      left: Math.max(0, targetLeft),
      top: Math.max(0, targetTop),
      behavior: "smooth",
    });

    this.flashWhenVisible({
      wrap,
      target: textEl,
      also: rectEl ?? null,
      timeoutMs: 1200,
    });    
  }

  private clearSvgHighlights() {
    this.svgHitTexts.forEach((t) =>
      t.classList.remove("kroki-svg-text-hit", "kroki-svg-current")
    );
    this.svgHitRects.forEach((r) =>
      r?.classList.remove("kroki-svg-rect-hit", "kroki-svg-rect-current")
    );

    this.svgHitTexts = [];
    this.svgHitRects = [];
    this.svgHitIndex = -1;
    this.updateCounter();
  }
  
  private updateCounter() {
    if (!this.searchCounterEl) return;

    if (this.searchMode === "block") {
      const total = this.searchHits.length;
      const current = total > 0 ? this.searchIndex + 1 : 0;
      this.searchCounterEl.setText(`${current} / ${total}`);
      return;
    }

    const total = this.svgHitTexts.length;
    const current = total > 0 ? this.svgHitIndex + 1 : 0;
    this.searchCounterEl.setText(`${current} / ${total}`);
  }

  private flashEl(el: Element | null, className = "kroki-flash") {
    if (!el) return;
    el.classList.remove(className);

    // ★同じ要素を連続でフラッシュできるように reflow
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    (el as any).getBoundingClientRect?.();

    el.classList.add(className);

    // animation 1回で外す（安全策）
    window.setTimeout(() => {
      el.classList.remove(className);
    }, 900);
  }

  private isInWrapViewport(wrap: HTMLElement, el: Element): boolean {
    const wr = wrap.getBoundingClientRect();
    const er = (el as any).getBoundingClientRect?.() as DOMRect | undefined;
    if (!er) return false;

    // wrapの表示領域と要素の矩形が交差していれば「見えている」
    const inter =
      er.right > wr.left &&
      er.left < wr.right &&
      er.bottom > wr.top &&
      er.top < wr.bottom;

    return inter;
  }

  /**
   * smooth scroll の最中でもOK。
   * - wrap内で target が「見える」状態になったらフラッシュ
   * - timeout で諦める（無限待ち防止）
   */
  private flashWhenVisible(params: {
    wrap: HTMLElement;
    target: Element | null;
    also?: Element | null;          // rectなど一緒にフラッシュしたいもの
    timeoutMs?: number;
  }) {
    const { wrap, target, also, timeoutMs = 1200 } = params;
    if (!wrap || !target) return;

    const start = performance.now();

    const tick = () => {
      // renderでDOMが差し替わった等の安全策
      if (!document.contains(target)) return;

      if (this.isInWrapViewport(wrap, target)) {
        // ★見える状態になった「次のフレーム」でフラッシュ
        requestAnimationFrame(() => {
          this.flashEl(target);
          if (also) this.flashEl(also);
        });
        return;
      }

      if (performance.now() - start > timeoutMs) {
        // タイムアウトしたら一応フラッシュ（見えてなくても）
        this.flashEl(target);
        if (also) this.flashEl(also);
        return;
      }

      requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
  }

}
