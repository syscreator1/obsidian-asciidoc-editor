import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type YourPlugin from "./main";
import { DEFAULT_SETTINGS } from "./settings";

export class AsciidocKrokiSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: YourPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Kroki / Diagram settings" });

    new Setting(containerEl)
      .setName("Kroki Base URL")
      .setDesc("例: https://kroki.io  /  社内KrokiのURL")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.krokiBaseUrl)
          .setValue(this.plugin.settings.krokiBaseUrl)
          .onChange(async (v) => {
            const value = v.trim().replace(/\/+$/, "");
            if (!this.plugin.settings.allowHttp && value.startsWith("http://")) {
              new Notice("http:// は無効です（Allow HTTP を ON にしてください）");
              return;
            }
            this.plugin.settings.krokiBaseUrl = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Default format")
      .addDropdown((dd) =>
        dd
          .addOption("svg", "svg (recommended)")
          .addOption("png", "png")
          .setValue(this.plugin.settings.defaultFormat)
          .onChange(async (v) => {
            this.plugin.settings.defaultFormat = v as any;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Timeout (ms)")
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.timeoutMs))
          .onChange(async (v) => {
            const n = Number(v);
            if (!Number.isFinite(n) || n < 1000) return;
            this.plugin.settings.timeoutMs = Math.floor(n);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Enabled diagram types (comma separated)")
      .setDesc("例: plantuml,mermaid,graphviz")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.enabledDiagramTypes.join(","))
          .onChange(async (v) => {
            this.plugin.settings.enabledDiagramTypes = v
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
    .setName("Diagram search highlight strength")
    .setDesc("How strongly matched diagram text is highlighted")
    .addDropdown((dd) => {
        dd.addOption("weak", "Weak")
        .addOption("medium", "Medium")
        .addOption("strong", "Strong")
        .setValue(this.plugin.settings.highlightStrength)
        .onChange(async (v) => {
            this.plugin.settings.highlightStrength = v as any;
            await this.plugin.saveSettings();
            this.plugin.applyHighlightStrength(); // ★即時反映
        });
    });

    new Setting(containerEl)
    .setName("Default diagram zoom (%)")
    .setDesc("Applied when opening the preview. 50 - 200")
    .addText((tx) => {
        tx.setPlaceholder("100")
        .setValue(String(this.plugin.settings.zoomDefaultPct ?? 100))
        .onChange(async (v) => {
            const n = Math.floor(Number(v));
            if (!Number.isFinite(n)) return;
            const clamped = Math.max(50, Math.min(200, n));
            this.plugin.settings.zoomDefaultPct = clamped;
            await this.plugin.saveSettings();
        });
    });

    new Setting(containerEl)
      .setName("Allow HTTP (not recommended)")
      .setDesc("一部環境で http がブロックされることがあります")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.allowHttp).onChange(async (v) => {
          this.plugin.settings.allowHttp = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Cache max items")
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.cacheMaxItems))
          .onChange(async (v) => {
            const n = Number(v);
            if (!Number.isFinite(n) || n < 0) return;
            this.plugin.settings.cacheMaxItems = Math.floor(n);
            await this.plugin.saveSettings();
          }),
      );
  }
}
