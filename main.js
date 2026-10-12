const { MarkdownView, Notice, Plugin, PluginSettingTab, Setting } = require("obsidian");

const DEFAULT_SETTINGS = {
  statisticsEnabled: true,
  displayMode: "thousands",
  headingStats: true,
  refreshSeconds: 15,
  fileExplorerWrap: true,
  wrapMinChars: 20,
  wrapOnEdit: true,
};

const WRAP_STYLE_ID = "valar-nav-wrap-style";
const WRAP_CLASS = "valar-nav-wrap";
const WRAP_EDIT_CLASS = "valar-nav-wrap-on-edit";

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

/**
 * 统计当前页面中的一至五级 Markdown 标题。
 * 代码围栏中的内容不算标题；至少显示到三级，四、五级只显示到页面实际用到的最深级别。
 */
function countHeadings(text) {
  const counts = [0, 0, 0, 0, 0];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let fenceMarker;
  let fenceLength = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);

    if (fenceMarker) {
      if (fence && fence[1][0] === fenceMarker && fence[1].length >= fenceLength) {
        fenceMarker = undefined;
        fenceLength = 0;
      }
      continue;
    }

    if (fence) {
      fenceMarker = fence[1][0];
      fenceLength = fence[1].length;
      continue;
    }

    const atxHeading = /^ {0,3}(#{1,6})(?:[ \t]+|$)/.exec(line);
    if (atxHeading) {
      const level = atxHeading[1].length;
      if (level <= counts.length) counts[level - 1] += 1;
      continue;
    }

    if (index + 1 < lines.length && line.trim()) {
      const setextHeading = /^ {0,3}(=+|-+)[ \t]*$/.exec(lines[index + 1]);
      if (setextHeading) {
        counts[setextHeading[1][0] === "=" ? 0 : 1] += 1;
        index += 1;
      }
    }
  }

  let deepestLevel = 3;
  for (let index = counts.length - 1; index >= 2; index -= 1) {
    if (counts[index] > 0) {
      deepestLevel = index + 1;
      break;
    }
  }
  return counts.slice(0, deepestLevel);
}

function formatHeadingCount(counts) {
  return counts.join("/");
}

/**
 * 定位光标所在行对应的标题，并返回从一级标题到该标题的层级链。
 * 若光标不在标题行（ATX 标题行或其下划线）上，返回 null。
 */
function getHeadingChainAt(text, targetLine) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const chain = [];
  let fenceMarker;
  let fenceLength = 0;
  let targetLevel = 0;

  const limit = Math.min(Math.max(targetLine, 0), lines.length - 1);

  for (let index = 0; index <= limit; index += 1) {
    const line = lines[index];
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);

    if (fenceMarker) {
      if (fence && fence[1][0] === fenceMarker && fence[1].length >= fenceLength) {
        fenceMarker = undefined;
        fenceLength = 0;
      }
      continue;
    }

    if (fence) {
      fenceMarker = fence[1][0];
      fenceLength = fence[1].length;
      continue;
    }

    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?)|[ \t]*)$/.exec(line);
    if (atx) {
      const level = atx[1].length;
      const title = (atx[2] || "").replace(/\s+#+\s*$/, "").trim();
      while (chain.length > 0 && chain[chain.length - 1].level >= level) {
        chain.pop();
      }
      chain.push({ level, title });
      if (index === targetLine) targetLevel = level;
      continue;
    }

    if (index + 1 < lines.length && line.trim()) {
      const setext = /^ {0,3}(=+|-+)[ \t]*$/.exec(lines[index + 1]);
      if (setext) {
        const level = setext[1][0] === "=" ? 1 : 2;
        const title = line.trim();
        while (chain.length > 0 && chain[chain.length - 1].level >= level) {
          chain.pop();
        }
        chain.push({ level, title });
        if (index === targetLine || index + 1 === targetLine) targetLevel = level;
        continue;
      }
    }
  }

  if (!targetLevel) return null;

  const titles = chain
    .filter((item) => item.level <= targetLevel && item.title)
    .map((item) => item.title);

  return titles;
}

module.exports = class ValarStyleEnhancementPlugin extends Plugin {
  async onload() {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData() || {}) };
    this.normaliseSettings();
    this.isDirty = true;
    this.refreshInProgress = false;
    this.refreshQueued = false;
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.addClass("valar-style-enhancement");
    this.registerDomEvent(this.statusBarItem, "click", () => {
      void this.toggleDisplayMode();
    });

    this.addSettingTab(new ValarStyleEnhancementSettingTab(this.app, this));
    this.addCommand({
      id: "toggle-display-mode",
      name: "切换字数显示方式（单独字数 / 千字）",
      callback: () => void this.toggleDisplayMode(),
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        if (!(view instanceof MarkdownView)) return;
        const address = this.getChapterAddress(editor, view);
        if (!address) return;

        menu.addItem((item) => {
          item
            .setTitle("获取章节地址")
            .setIcon("map-pin")
            .onClick(async () => {
              await this.copyChapterAddress(address);
            });
        });
      })
    );

    this.registerEvent(
      this.app.workspace.on("editor-change", () => {
        this.isDirty = true;
      })
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.isDirty = true;
        this.queueRefresh();
      })
    );

    this.restartRefreshTimer();
    this.register(() => this.stopRefreshTimer());

    this.app.workspace.onLayoutReady(() => this.queueRefresh());

    // ===== 文件目录自动换行 =====
    this.applyWrapStyle();
    this.wrapMutationObserver = new MutationObserver(() => {
      this.scheduleWrapRefresh();
    });

    this.register(() => {
      this.wrapMutationObserver.disconnect();
      document.body.classList.remove(WRAP_EDIT_CLASS);
      document.getElementById(WRAP_STYLE_ID)?.remove();
    });

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.observeWrapExplorers();
        this.scheduleWrapRefresh();
      })
    );

    this.observeWrapExplorers();
    this.refreshWrap();
    this.updateWrapBodyClass();
  }

  getChapterAddress(editor, view) {
    if (!view || !view.file || !editor) return null;

    const titles = getHeadingChainAt(editor.getValue(), editor.getCursor().line);
    if (!titles || titles.length === 0) return null;

    const folderName = view.file.parent && view.file.parent.name;
    const parts = folderName
      ? [folderName, view.file.basename, ...titles]
      : [view.file.basename, ...titles];

    return parts.join(".");
  }

  async copyChapterAddress(address) {
    try {
      await navigator.clipboard.writeText(address);
      new Notice(`已复制章节地址：${address}`);
    } catch (error) {
      console.error("[valar-style-enhancement] copy chapter address failed", error);
      new Notice("复制章节地址失败，请手动复制");
    }
  }

  normaliseSettings() {
    this.settings.statisticsEnabled = this.settings.statisticsEnabled !== false;
    this.settings.displayMode = this.settings.displayMode === "exact" ? "exact" : "thousands";
    this.settings.headingStats = this.settings.headingStats !== false;
    const seconds = Number(this.settings.refreshSeconds);
    this.settings.refreshSeconds = Number.isFinite(seconds)
      ? Math.min(3600, Math.max(1, Math.round(seconds)))
      : DEFAULT_SETTINGS.refreshSeconds;

    this.settings.fileExplorerWrap = this.settings.fileExplorerWrap !== false;
    this.settings.wrapOnEdit = this.settings.wrapOnEdit !== false;
    const minChars = Number(this.settings.wrapMinChars);
    this.settings.wrapMinChars = Number.isFinite(minChars)
      ? Math.max(0, Math.round(minChars))
      : DEFAULT_SETTINGS.wrapMinChars;
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
    this.refreshWrap();
    this.updateWrapBodyClass();
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

      if (!this.settings.statisticsEnabled) {
        this.statusBarItem.hide();
        return;
      }

      this.statusBarItem.show();
      if (!this.isDirty) return;

      const text = view.editor.getValue();
      const { characterCount, wordCount } = countText(text);
      const { displayMode, headingStats } = this.settings;
      const displayParts = [
        `${formatCount(wordCount, displayMode)}词`,
        `${formatCount(characterCount, displayMode)}字符`,
      ];
      let headingCounts;
      if (headingStats) {
        headingCounts = countHeadings(text);
        displayParts.push(`标题 ${formatHeadingCount(headingCounts)}`);
      }
      const display = displayParts.join(" · ");
      this.statusBarItem.setText(display);
      this.isDirty = false;
    } catch (error) {
      console.error("[valar-style-enhancement] refresh failed", error);
      this.isDirty = true;
    } finally {
      this.refreshInProgress = false;
    }
  }

  applyWrapStyle() {
    document.getElementById(WRAP_STYLE_ID)?.remove();
    const style = document.head.createEl("style", {
      attr: { id: WRAP_STYLE_ID }
    });
    style.textContent = `
.nav-file-title.${WRAP_CLASS},
.nav-folder-title.${WRAP_CLASS} {
  --nav-item-white-space: pre-wrap;
}

body.${WRAP_EDIT_CLASS} .nav-file-title-content[contenteditable="true"],
body.${WRAP_EDIT_CLASS} .nav-folder-title-content[contenteditable="true"] {
  --nav-item-white-space: pre-wrap;
}
`;
  }

  getWrapExplorerEls() {
    return Array.from(
      document.querySelectorAll(
        '.workspace-leaf-content[data-type="file-explorer"]'
      )
    );
  }

  observeWrapExplorers() {
    for (const el of this.getWrapExplorerEls()) {
      if (el.dataset.valarWrapObserved) {
        continue;
      }
      el.dataset.valarWrapObserved = "true";
      this.wrapMutationObserver.observe(el, {
        childList: true,
        subtree: true
      });
    }
  }

  scheduleWrapRefresh() {
    if (this.wrapRefreshTimer) {
      clearTimeout(this.wrapRefreshTimer);
    }
    this.wrapRefreshTimer = window.setTimeout(() => {
      this.wrapRefreshTimer = null;
      this.refreshWrap();
    }, 250);
  }

  refreshWrap() {
    const enabled = this.settings.fileExplorerWrap;
    const minChars = this.settings.wrapMinChars;

    for (const explorer of this.getWrapExplorerEls()) {
      const titles = explorer.querySelectorAll(
        ".nav-file-title, .nav-folder-title"
      );

      for (const title of titles) {
        const content = title.querySelector(
          ".nav-file-title-content, .nav-folder-title-content"
        );
        const text = content ? content.textContent || "" : "";
        const shouldWrap = enabled && text.length > minChars;
        title.classList.toggle(WRAP_CLASS, shouldWrap);
      }
    }
  }

  updateWrapBodyClass() {
    document.body.classList.toggle(
      WRAP_EDIT_CLASS,
      this.settings.fileExplorerWrap && this.settings.wrapOnEdit
    );
  }
};

class ValarStyleEnhancementSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const plugin = this.plugin;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Valar的样式增强" });

    containerEl.createEl("h3", { text: "A 统计增强" });

    const statsEnabled = plugin.settings.statisticsEnabled;
    const statsSubDisabled = !statsEnabled;

    new Setting(containerEl)
      .setName("启用统计增强")
      .setDesc("总开关：关闭后状态栏不再显示字数、字符数和标题数量，下面的选项会变淡并停用。")
      .addToggle((toggle) =>
        toggle
          .setValue(statsEnabled)
          .onChange(async (value) => {
            plugin.settings.statisticsEnabled = value;
            await plugin.saveSettings();
            this.display();
          })
      );

    const headingStatsSetting = new Setting(containerEl)
      .setName("标题数量统计")
      .setDesc("开启后在状态栏显示当前页面的1至5级标题数量；关闭后不扫描标题。")
      .addToggle((toggle) =>
        toggle
          .setValue(plugin.settings.headingStats)
          .setDisabled(statsSubDisabled)
          .onChange(async (value) => {
            plugin.settings.headingStats = value;
            await plugin.saveSettings();
          })
      );
    headingStatsSetting.settingEl.classList.toggle("valar-setting-faded", statsSubDisabled);

    const displayModeSetting = new Setting(containerEl)
      .setName("显示方式")
      .setDesc("选择右下角显示精确数字，还是以千字为单位显示。点击状态栏也可以切换。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("exact", "单独字数")
          .addOption("thousands", "千字")
          .setValue(plugin.settings.displayMode)
          .setDisabled(statsSubDisabled)
          .onChange(async (value) => {
            plugin.settings.displayMode = value;
            await plugin.saveSettings();
          })
      );
    displayModeSetting.settingEl.classList.toggle("valar-setting-faded", statsSubDisabled);

    let draftRefreshSeconds = plugin.settings.refreshSeconds;

    const refreshSetting = new Setting(containerEl)
      .setName("刷新时间（秒）")
      .setDesc("编辑时只标记内容变化；到达此时间后才重新统计。范围为 1–3600 秒。")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.refreshSeconds))
          .setValue(String(plugin.settings.refreshSeconds))
          .setDisabled(statsSubDisabled)
          .onChange((value) => {
            draftRefreshSeconds = value;
          })
      )
      .addButton((button) =>
        button
          .setButtonText("应用")
          .setCta()
          .setDisabled(statsSubDisabled)
          .onClick(async () => {
            const seconds = Number(draftRefreshSeconds);
            if (!Number.isFinite(seconds)) return;
            plugin.settings.refreshSeconds = seconds;
            await plugin.saveSettings();
            this.display();
          })
      );
    refreshSetting.settingEl.classList.toggle("valar-setting-faded", statsSubDisabled);

    containerEl.createEl("h3", { text: "B 文件目录换行增强" });

    const wrapEnabled = plugin.settings.fileExplorerWrap;
    const wrapSubDisabled = !wrapEnabled;

    new Setting(containerEl)
      .setName("启用文件目录换行增强")
      .setDesc("总开关：开启后长文件名和文件夹名会换行显示完整内容；关闭则恢复单行省略号。")
      .addToggle((toggle) =>
        toggle
          .setValue(wrapEnabled)
          .onChange(async (value) => {
            plugin.settings.fileExplorerWrap = value;
            await plugin.saveSettings();
            this.display();
          })
      );

    let draftWrapMinChars = plugin.settings.wrapMinChars;

    const wrapMinSetting = new Setting(containerEl)
      .setName("换行最小字符数")
      .setDesc("超过这个字符数才换行；小于等于该数值的保持单行。")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.wrapMinChars))
          .setValue(String(plugin.settings.wrapMinChars))
          .setDisabled(wrapSubDisabled)
          .onChange((value) => {
            draftWrapMinChars = value;
          })
      )
      .addButton((button) =>
        button
          .setButtonText("应用")
          .setCta()
          .setDisabled(wrapSubDisabled)
          .onClick(async () => {
            const parsed = parseInt(draftWrapMinChars, 10);
            plugin.settings.wrapMinChars = Number.isFinite(parsed)
              ? Math.max(0, parsed)
              : DEFAULT_SETTINGS.wrapMinChars;
            await plugin.saveSettings();
            this.display();
          })
      );
    wrapMinSetting.settingEl.classList.toggle("valar-setting-faded", wrapSubDisabled);

    const wrapOnEditSetting = new Setting(containerEl)
      .setName("重命名时也换行")
      .setDesc("开启后，编辑文件名时也能多行显示完整内容。")
      .addToggle((toggle) =>
        toggle
          .setValue(plugin.settings.wrapOnEdit)
          .setDisabled(wrapSubDisabled)
          .onChange(async (value) => {
            plugin.settings.wrapOnEdit = value;
            await plugin.saveSettings();
          })
      );
    wrapOnEditSetting.settingEl.classList.toggle("valar-setting-faded", wrapSubDisabled);
  }
}
