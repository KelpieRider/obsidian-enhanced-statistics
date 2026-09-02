const { MarkdownView, Plugin, PluginSettingTab, Setting } = require("obsidian");

const DEFAULT_SETTINGS = {
  displayMode: "thousands",
  refreshSeconds: 15,
};
const NON_WHITESPACE = /\S/u;
const LETTER_OR_NUMBER = /[\p{L}\p{N}\p{M}]/u;

/**
 * 字符数包含非空白符号；词数按 CJK 单字和连续字母/数字统计。
 */
function countText(text) {
  let characterCount = 0;
  let wordCount = 0;
  let inNonCjkWord = false;

  for (const character of text) {
    const codePoint = character.codePointAt(0);

    if (NON_WHITESPACE.test(character)) characterCount += 1;

    if (isCjk(codePoint)) {
      wordCount += 1;
      inNonCjkWord = false;
      continue;
    }

    if (isLetterOrNumber(character)) {
      if (!inNonCjkWord) wordCount += 1;
      inNonCjkWord = true;
    } else if (character !== "'" && character !== "’") {
      inNonCjkWord = false;
    }
  }

  return { characterCount, wordCount };
}

function isCjk(codePoint) {
  return (
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x20000 && codePoint <= 0x323af) ||
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0x31f0 && codePoint <= 0x31ff) ||
    (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0x3130 && codePoint <= 0x318f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af)
  );
}

function isLetterOrNumber(character) {
  return LETTER_OR_NUMBER.test(character);
}

function formatCount(value, mode) {
  return mode === "exact"
    ? value.toLocaleString("zh-CN")
    : `${(value / 1000).toFixed(1)}千`;
}

module.exports = class EnhancedWordCountPlugin extends Plugin {
  async onload() {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData() || {}) };
    this.normaliseSettings();
    this.isDirty = true;
    this.refreshInProgress = false;
    this.refreshQueued = false;
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.addClass("enhanced-word-count");
    this.registerDomEvent(this.statusBarItem, "click", () => {
      void this.toggleDisplayMode();
    });

    this.addSettingTab(new EnhancedWordCountSettingTab(this.app, this));
    this.addCommand({
      id: "toggle-display-mode",
      name: "切换字数显示方式（单独字数 / 千字）",
      callback: () => void this.toggleDisplayMode(),
    });

    // 编辑时只设置标记，避免每次按键都扫描整篇长文。
    this.registerEvent(
      this.app.workspace.on("editor-change", () => {
        this.isDirty = true;
        this.queueRefresh();
      })
    );

    // 切换笔记时立即更新一次，不必等待下一个 15 秒周期。
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.isDirty = true;
        this.queueRefresh();
      })
    );

    this.restartRefreshTimer();
    this.register(() => this.stopRefreshTimer());

    this.app.workspace.onLayoutReady(() => this.queueRefresh());
  }

  normaliseSettings() {
    this.settings.displayMode = this.settings.displayMode === "exact" ? "exact" : "thousands";
    const seconds = Number(this.settings.refreshSeconds);
    this.settings.refreshSeconds = Number.isFinite(seconds)
      ? Math.min(3600, Math.max(1, Math.round(seconds)))
      : DEFAULT_SETTINGS.refreshSeconds;
  }

  restartRefreshTimer() {
    this.stopRefreshTimer();
    this.refreshTimer = window.setInterval(() => this.refresh(), this.settings.refreshSeconds * 1000);
  }

  queueRefresh() {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    window.setTimeout(() => {
      this.refreshQueued = false;
      this.refresh();
    }, 300);
  }

  stopRefreshTimer() {
    if (this.refreshTimer !== undefined) {
      window.clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  async saveSettings() {
    this.normaliseSettings();
    await this.saveData(this.settings);
    this.restartRefreshTimer();
    this.isDirty = true;
    this.queueRefresh();
  }

  async toggleDisplayMode() {
    this.settings.displayMode = this.settings.displayMode === "exact" ? "thousands" : "exact";
    await this.saveSettings();
  }

  refresh() {
    if (this.refreshInProgress) return;
    this.refreshInProgress = true;
    try {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);

    if (!view || !view.editor || !this.statusBarItem?.isConnected) {
      this.statusBarItem?.hide();
      return;
    }

    this.statusBarItem.show();
    if (!this.isDirty) return;

    const { characterCount, wordCount } = countText(view.editor.getValue());
    const { displayMode, refreshSeconds } = this.settings;
    const display = `${formatCount(wordCount, displayMode)}词 · ${formatCount(characterCount, displayMode)}字符`;
    this.statusBarItem.setText(display);
    this.statusBarItem.setAttr(
      "aria-label",
      `精确词数：${wordCount.toLocaleString("zh-CN")}；` +
      `精确字符数：${characterCount.toLocaleString("zh-CN")}；` +
      `当前显示：${displayMode === "exact" ? "单独字数" : "千字"}；` +
      `每 ${refreshSeconds} 秒刷新；点击可切换`
    );
    this.isDirty = false;
    } catch (error) {
      console.error("[enhanced-word-count] refresh failed", error);
      this.isDirty = true;
    } finally {
      this.refreshInProgress = false;
    }
  }
};

class EnhancedWordCountSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const plugin = this.plugin;
    containerEl.empty();
    containerEl.createEl("h2", { text: "字数统计增强（Word Count+）" });
    let draftRefreshSeconds = plugin.settings.refreshSeconds;

    new Setting(containerEl)
      .setName("显示方式")
      .setDesc("选择右下角显示精确数字，还是以千字为单位显示。点击状态栏也可以切换。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("exact", "单独字数")
          .addOption("thousands", "千字")
          .setValue(plugin.settings.displayMode)
          .onChange(async (value) => {
            plugin.settings.displayMode = value;
            await plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("刷新时间（秒）")
      .setDesc("编辑时只标记内容变化；到达此时间后才重新统计。范围为 1–3600 秒，默认 15 秒。")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.refreshSeconds))
          .setValue(String(plugin.settings.refreshSeconds))
          .onChange((value) => {
            draftRefreshSeconds = value;
          })
      )
      .addButton((button) =>
        button
          .setButtonText("刷新并应用")
          .setCta()
          .onClick(async () => {
            const seconds = Number(draftRefreshSeconds);
            if (!Number.isFinite(seconds)) return;
            plugin.settings.refreshSeconds = seconds;
            await plugin.saveSettings();
            this.display();
          })
      );
  }
}
