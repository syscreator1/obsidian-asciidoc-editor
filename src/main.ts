console.log("[asciidoc-editor] main.ts ACTIVE !!!");
import { renderAsciidocToHtml } from "./asciidoctor/renderer";
console.log("[asciidoc-editor] renderer import =", typeof renderAsciidocToHtml);

import { Plugin, TFile } from "obsidian";
import { AsciidocPreviewView, VIEW_TYPE_ASCIIDOC_PREVIEW } from "./view/AsciidocPreviewView";
import { AsciidocKrokiSettingTab } from "./AsciidocKrokiSettingTab";
import { DEFAULT_SETTINGS, type AsciidocKrokiSettings, DEFAULT_CACHE, type PluginDataV1 } from "./settings";
import * as path from "path";

export default class AsciiDocPlugin extends Plugin {
  settings: AsciidocKrokiSettings;
	diagramCache = DEFAULT_CACHE;

  async onload() {
    console.log("[asciidoc-editor] loaded");
		const data = (await this.loadData()) as unknown as PluginDataV1 | Record<string, any> | null;

		if (!data || (data as any).version !== 1) {
			this.settings = Object.assign({}, DEFAULT_SETTINGS, (data ?? {}) as any);
			this.diagramCache = DEFAULT_CACHE;
			this.diagramCache.items ||= {};
			// ★Save here to normalize to v1 format (optional but recommended)
			await this.saveSettings();
		} else {
			const v1 = data as PluginDataV1;
			this.settings = Object.assign({}, DEFAULT_SETTINGS, v1.settings ?? {});
			this.diagramCache = v1.diagramCache ?? DEFAULT_CACHE;
			this.diagramCache.items ||= {};
		}
		
		this.addSettingTab(new AsciidocKrokiSettingTab(this.app, this));

    // ★Resolve the absolute path of the plugin/vault folder (Desktop only)
    // Use FileSystemAdapter#getBasePath()
    const adapter: any = this.app.vault.adapter as any;
    const vaultBase: string | undefined = adapter?.getBasePath?.();

    // Open .adoc with the normal Markdown editor (editing stays as-is)
    this.registerExtensions(["adoc"], "markdown");

    // Preview view
    this.registerView(VIEW_TYPE_ASCIIDOC_PREVIEW, (leaf) => new AsciidocPreviewView(leaf, this));

    // Command: open the current .adoc in the preview
    this.addCommand({
      id: "asciidoc-open-preview",
      name: "Open Asciidoc Preview (current file)",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension.toLowerCase() !== "adoc") return false;
        if (checking) return true;
        void this.openPreviewForFile(file);
        return true;
      },
    });

		// ★While a .adoc is active, add a class to <body> to make the editor styling more "plain"
		const updateAdocActiveClass = () => {
			const f = this.app.workspace.getActiveFile();
			const isAdoc = !!f && f.extension.toLowerCase() === "adoc";
			document.body.toggleClass("adoc-active", isAdoc);
		};

		// Initial state
		updateAdocActiveClass();

		// Update on active file change
		this.registerEvent(this.app.workspace.on("active-leaf-change", updateAdocActiveClass));
		this.applyHighlightStrength();

  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_ASCIIDOC_PREVIEW);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    const data: PluginDataV1 = {
      version: 1,
      settings: this.settings,
      diagramCache: this.diagramCache,
    };

		await this.saveData(data);
  }

  private async openPreviewForFile(file: TFile) {
		// ★Capture editorLeaf first (before calling getLeaf!)
		const editorLeaf = this.app.workspace.activeLeaf;

		const leaf = this.app.workspace.getLeaf("split", "vertical");

		await leaf.setViewState({
			type: VIEW_TYPE_ASCIIDOC_PREVIEW,
			active: false,
			state: {
				file: file.path,
				follow: true,
				returnToEditor: true,
			},
		});

		const view = leaf.view;
		if (view instanceof AsciidocPreviewView) {
			await view.loadFile(file);
		}

		// ★Win against Obsidian focus adjustments (double rAF)
		if (editorLeaf) {
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					this.app.workspace.setActiveLeaf(editorLeaf, { focus: true });
				});
			});
		}
	}

	applyHighlightStrength() {
		const root = document.documentElement;

		switch (this.settings.highlightStrength) {
			case "weak":
				root.style.setProperty("--kroki-hl-bg", "25%");
				root.style.setProperty("--kroki-hl-bg-current", "35%");
				root.style.setProperty("--kroki-hl-stroke", "2px");
				root.style.setProperty("--kroki-hl-stroke-current", "3px");
				break;

			case "strong":
				root.style.setProperty("--kroki-hl-bg", "55%");
				root.style.setProperty("--kroki-hl-bg-current", "75%");
				root.style.setProperty("--kroki-hl-stroke", "4px");
				root.style.setProperty("--kroki-hl-stroke-current", "6px");
				break;

			default: // medium
				root.style.setProperty("--kroki-hl-bg", "40%");
				root.style.setProperty("--kroki-hl-bg-current", "55%");
				root.style.setProperty("--kroki-hl-stroke", "3px");
				root.style.setProperty("--kroki-hl-stroke-current", "4px");
		}
	}
}
