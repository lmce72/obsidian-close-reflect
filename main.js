// src/plugin.ts
var import_obsidian7 = require("obsidian");

// src/modal.ts
var import_obsidian2 = require("obsidian");

// src/render.ts
var import_obsidian = require("obsidian");
function renderReflection(app, host, component, data, options) {
  const panel = host.createDiv({ cls: "close-reflect-panel" });
  panel.createDiv({ cls: "close-reflect-title", text: data.title });
  const body = panel.createDiv({ cls: "close-reflect-body" });
  import_obsidian.MarkdownRenderer.render(app, data.content, body, "", component).catch((error) => {
    console.error("[close-reflect] markdown render failed:", error);
  });
  const row = panel.createDiv({ cls: "modal-button-container" });
  const accentIndex = data.buttons.findIndex((button) => button.action === "stay");
  for (let i = 0;i < data.buttons.length; i++) {
    const button = data.buttons[i];
    const el = row.createEl("button", {
      text: button.label,
      cls: i === (accentIndex >= 0 ? accentIndex : 0) ? "mod-cta" : ""
    });
    if (options.interactive) {
      el.addEventListener("click", () => options.onChoose?.(button));
    } else {
      el.disabled = true;
    }
  }
  return panel;
}

// src/modal.ts
var OVERLAY_Z_INDEX = 10050;

class ReflectOverlay {
  app;
  options;
  outcome = null;
  closed = false;
  renderHost = new import_obsidian2.Component;
  rootEl = null;
  panelEl = null;
  keyHandler = null;
  constructor(app, options) {
    this.app = app;
    this.options = options;
  }
  open() {
    const root = document.body.createDiv({ cls: "close-reflect-overlay" });
    root.style.zIndex = String(OVERLAY_Z_INDEX);
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    this.renderHost.load();
    const panel = renderReflection(this.app, root, this.renderHost, {
      title: this.options.title,
      content: this.options.content,
      buttons: this.options.buttons
    }, {
      interactive: true,
      onChoose: (button) => {
        this.outcome = { kind: "button", button };
        this.close();
      }
    });
    panel.setAttribute("tabindex", "-1");
    const titleEl = panel.querySelector(".close-reflect-title");
    if (titleEl) {
      titleEl.id = "close-reflect-title";
      root.setAttribute("aria-labelledby", titleEl.id);
    }
    this.keyHandler = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.outcome = { kind: "cancel" };
        this.close();
      }
    };
    document.addEventListener("keydown", this.keyHandler, true);
    this.rootEl = root;
    this.panelEl = panel;
    panel.focus();
  }
  close() {
    if (this.closed)
      return;
    this.closed = true;
    if (this.keyHandler) {
      document.removeEventListener("keydown", this.keyHandler, true);
      this.keyHandler = null;
    }
    this.renderHost.unload();
    this.rootEl?.remove();
    this.rootEl = null;
    this.panelEl = null;
    this.options.onClose(this.outcome ?? { kind: "cancel" });
  }
  get element() {
    return this.rootEl;
  }
}

// src/note-text.ts
function splitFrontmatter(text) {
  const match = /^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match)
    return { frontmatter: "", body: text };
  return { frontmatter: match[0], body: text.slice(match[0].length) };
}
function stripFrontmatter(text) {
  return splitFrontmatter(text).body;
}

// src/settings.ts
var import_obsidian6 = require("obsidian");

// src/edit-modal.ts
var import_obsidian5 = require("obsidian");

// src/button-list-editor.ts
var import_obsidian4 = require("obsidian");

// src/file-suggest.ts
var import_obsidian3 = require("obsidian");

class NoteSuggest extends import_obsidian3.AbstractInputSuggest {
  appRef;
  onPick;
  constructor(app, inputEl, onPick) {
    super(app, inputEl);
    this.appRef = app;
    this.onPick = onPick;
  }
  getSuggestions(query) {
    const needle = query.trim().toLowerCase();
    return this.appRef.vault.getMarkdownFiles().filter((file) => needle === "" || file.path.toLowerCase().includes(needle)).sort((a, b) => a.path.localeCompare(b.path)).slice(0, 30);
  }
  renderSuggestion(file, el) {
    el.textContent = file.path;
  }
  selectSuggestion(file) {
    this.setValue(file.path);
    this.onPick(file);
    this.close();
  }
}

// src/types.ts
var BUTTON_ACTION_KINDS = ["stay", "leave", "openNote", "runCommand", "openUrl"];
var BUTTON_ACTION_LABELS = {
  stay: "Cancel the quit",
  leave: "Let the app close",
  openNote: "Open a note",
  runCommand: "Run a command",
  openUrl: "Open a URL"
};
var MAX_REMEMBERED_CHARS = 50000;
var DEFAULT_SETTINGS = {
  source: "inline",
  content: [
    "今天有没有看一下长期看板的进度？",
    "",
    "有没有落下待办清单的事情？",
    "",
    "有没有忘记今天打卡，记录做了什么？",
    "",
    "*检查并记录这些，更有利于后续的方向掌控！*",
    "",
    "→ [[10-看板]]"
  ].join(`
`),
  linkedPath: "",
  linkedCache: "",
  linkedCachedAt: "",
  title: "退出前，先看一眼",
  buttons: [
    { id: "leave", label: "都做了", action: "leave", target: "" },
    { id: "stay", label: "有没做的，先做", action: "stay", target: "" }
  ],
  intercepts: 2,
  timeoutMs: 30000,
  timeoutAction: "stay",
  writeDiagnostics: true,
  diagPath: "Components/History/closeReflectDiag.json",
  logToConsole: false
};
var LEGACY_DEFAULT_LABEL_STAY = "有没做的，先做";
var LEGACY_DEFAULT_LABEL_LEAVE = "都做了";
var buttonIdCounter = 0;
function createButtonId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch (error) {
    console.error("[close-reflect] randomUUID unavailable; falling back to a counter:", error);
  }
  buttonIdCounter += 1;
  return `btn-${Date.now().toString(36)}-${buttonIdCounter}`;
}
function normalizeButton(raw) {
  if (!raw || typeof raw !== "object")
    return null;
  const stored = raw;
  const action = BUTTON_ACTION_KINDS.includes(stored.action) ? stored.action : "stay";
  return {
    id: typeof stored.id === "string" && stored.id !== "" ? stored.id : createButtonId(),
    label: typeof stored.label === "string" ? stored.label : "",
    action,
    target: typeof stored.target === "string" ? stored.target : ""
  };
}
function legacyLabel(value, fallback) {
  return typeof value === "string" && value !== "" ? value : fallback;
}
function migrateSettings(raw) {
  const stored = raw && typeof raw === "object" ? raw : {};
  const merged = Object.assign({}, DEFAULT_SETTINGS, stored);
  const storedButtons = stored.buttons;
  const buttons = Array.isArray(storedButtons) ? storedButtons.map(normalizeButton).filter((button) => button !== null) : [];
  if (buttons.length === 0) {
    buttons.push({ id: "leave", label: legacyLabel(stored.labelLeave, LEGACY_DEFAULT_LABEL_LEAVE), action: "leave", target: "" }, { id: "stay", label: legacyLabel(stored.labelStay, LEGACY_DEFAULT_LABEL_STAY), action: "stay", target: "" });
  }
  merged.buttons = buttons;
  merged.title = typeof merged.title === "string" ? merged.title : DEFAULT_SETTINGS.title;
  merged.content = typeof merged.content === "string" ? merged.content : DEFAULT_SETTINGS.content;
  delete merged.labelStay;
  delete merged.labelLeave;
  return merged;
}

// src/button-list-editor.ts
class ButtonListEditor {
  app;
  buttons;
  onChange;
  listEl;
  constructor(app, hostEl, buttons, onChange) {
    this.app = app;
    this.buttons = buttons;
    this.onChange = onChange;
    this.listEl = hostEl.createDiv({ cls: "close-reflect-button-list" });
  }
  render() {
    this.listEl.empty();
    for (let index = 0;index < this.buttons.length; index++) {
      this.renderRow(index);
    }
    new import_obsidian4.ButtonComponent(this.listEl).setButtonText("Add button").onClick(() => {
      this.buttons.push({ id: createButtonId(), label: "New button", action: "stay", target: "" });
      this.render();
      this.onChange();
    });
  }
  renderRow(index) {
    const button = this.buttons[index];
    const row = this.listEl.createDiv({ cls: "close-reflect-button-row" });
    new import_obsidian4.TextComponent(row).setPlaceholder("Label").setValue(button.label).onChange((value) => {
      button.label = value;
      this.onChange();
    });
    const actionOptions = {};
    for (const kind of BUTTON_ACTION_KINDS)
      actionOptions[kind] = BUTTON_ACTION_LABELS[kind];
    new import_obsidian4.DropdownComponent(row).addOptions(actionOptions).setValue(button.action).onChange((value) => {
      button.action = value;
      button.target = "";
      this.render();
      this.onChange();
    });
    this.renderTarget(row, button);
    new import_obsidian4.ExtraButtonComponent(row).setIcon("trash").setTooltip("Remove this button").onClick(() => {
      this.buttons.splice(index, 1);
      this.render();
      this.onChange();
    });
  }
  renderTarget(row, button) {
    const cell = row.createDiv({ cls: "close-reflect-button-target" });
    switch (button.action) {
      case "openNote":
        this.renderNoteTarget(cell, button);
        return;
      case "runCommand":
        this.renderCommandTarget(cell, button);
        return;
      case "openUrl":
        new import_obsidian4.TextComponent(cell).setPlaceholder("https://example.com").setValue(button.target).onChange((value) => {
          button.target = value.trim();
          this.onChange();
        });
        return;
      case "stay":
      case "leave":
        cell.createSpan({ cls: "setting-item-description", text: "No target needed." });
        return;
    }
  }
  renderNoteTarget(cell, button) {
    const text = new import_obsidian4.TextComponent(cell).setPlaceholder("Note path").setValue(button.target);
    text.onChange((value) => {
      button.target = value.trim();
      this.onChange();
    });
    new NoteSuggest(this.app, text.inputEl, (file) => {
      button.target = file.path;
      text.setValue(file.path);
      this.onChange();
    });
  }
  renderCommandTarget(cell, button) {
    const commands = this.listCommands();
    if (!commands) {
      console.warn("[close-reflect] the command registry is unavailable; falling back to a raw command id");
      new import_obsidian4.TextComponent(cell).setPlaceholder("Command id").setValue(button.target).onChange((value) => {
        button.target = value.trim();
        this.onChange();
      });
      return;
    }
    new import_obsidian4.DropdownComponent(cell).addOptions(commands).setValue(button.target).onChange((value) => {
      button.target = value;
      this.onChange();
    });
  }
  listCommands() {
    const registry = this.app.commands;
    const commands = registry?.commands;
    if (!commands)
      return null;
    const options = {};
    for (const id of Object.keys(commands).sort((a, b) => (commands[a]?.name ?? a).localeCompare(commands[b]?.name ?? b))) {
      options[id] = commands[id]?.name ?? id;
    }
    return Object.keys(options).length > 0 ? options : null;
  }
}

// src/markdown-editor.ts
function requireCandidates() {
  const candidates = [];
  const fromWindow = window.require;
  if (typeof fromWindow === "function")
    candidates.push(fromWindow);
  if (require !== fromWindow) {
    candidates.push(require);
  }
  return candidates;
}
function loadModule(id) {
  let lastError = null;
  for (const requireFn of requireCandidates()) {
    try {
      const loaded = requireFn(id);
      if (loaded)
        return loaded;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError)
    console.error(`[close-reflect] cannot load ${id}:`, lastError);
  return null;
}
var obsidian = null;
var CmState = null;
var CmView = null;
function ensureModules() {
  if (obsidian && CmState && CmView)
    return true;
  const obsidianModule = loadModule("obsidian");
  const cmState = loadModule("@codemirror/state");
  const cmView = loadModule("@codemirror/view");
  if (!obsidianModule || !cmState || !cmView || !cmState.EditorSelection || !cmView.EditorView) {
    return false;
  }
  obsidian = obsidianModule;
  CmState = cmState;
  CmView = cmView;
  return true;
}
function isMarkdownEditorAvailable() {
  return ensureModules();
}
var baseClassCache = null;
function resolveEditorPrototype(app) {
  if (baseClassCache)
    return baseClassCache;
  if (!ensureModules())
    throw new Error("the CodeMirror modules are unavailable");
  const registry = app.embedRegistry;
  if (!registry || !registry.embedByExtension) {
    throw new Error("app.embedRegistry is unavailable (an Obsidian internal that may have changed)");
  }
  let file = null;
  try {
    file = app.workspace.getActiveFile();
  } catch (error) {
    file = null;
  }
  if (!file || file.extension !== "md") {
    try {
      file = app.vault.getMarkdownFiles()[0] ?? null;
    } catch (error) {
      file = null;
    }
  }
  if (!file) {
    file = new obsidian.TFile(app.vault, "__close_reflect_probe__.md");
  }
  const host = document.createElement("div");
  let embed = null;
  try {
    embed = registry.embedByExtension.md({ app, containerEl: host }, file, "");
    embed.editable = true;
    embed.showEditor();
    const editMode = embed.editMode;
    if (!editMode)
      throw new Error("the probe editor never initialised its editMode");
    const Base = Object.getPrototypeOf(Object.getPrototypeOf(editMode)).constructor;
    if (typeof Base !== "function")
      throw new Error("the prototype walk did not reach a constructor");
    baseClassCache = Base;
    return Base;
  } finally {
    try {
      if (embed && embed.editMode)
        embed.editMode.destroy();
    } catch (error) {
      console.warn("[close-reflect] could not destroy the probe editMode:", error);
    }
    try {
      if (embed)
        embed.unload();
    } catch (error) {
      console.warn("[close-reflect] could not unload the probe embed:", error);
    }
    try {
      host.remove();
    } catch (error) {}
  }
}
var patchRefCount = 0;
var originalSetActiveLeaf = null;
var patchedSetActiveLeaf = null;
var liveEditors = [];
function anyEmbeddedEditorFocused() {
  for (const editor of liveEditors) {
    try {
      if (editor.editor?.cm?.hasFocus)
        return true;
      if (editor.activeCM?.hasFocus)
        return true;
    } catch (error) {}
  }
  return false;
}
function installActiveLeafPatch(app) {
  patchRefCount++;
  if (patchRefCount > 1)
    return;
  try {
    const workspace = app.workspace;
    originalSetActiveLeaf = workspace.setActiveLeaf;
    patchedSetActiveLeaf = function(...args) {
      if (anyEmbeddedEditorFocused())
        return;
      return originalSetActiveLeaf.apply(this, args);
    };
    workspace.setActiveLeaf = patchedSetActiveLeaf;
  } catch (error) {
    console.error("[close-reflect] could not install the setActiveLeaf patch:", error);
  }
}
function uninstallActiveLeafPatch(app) {
  patchRefCount = Math.max(0, patchRefCount - 1);
  if (patchRefCount > 0)
    return;
  try {
    const workspace = app.workspace;
    if (originalSetActiveLeaf && workspace.setActiveLeaf === patchedSetActiveLeaf) {
      workspace.setActiveLeaf = originalSetActiveLeaf;
    }
  } catch (error) {
    console.error("[close-reflect] could not restore the setActiveLeaf patch:", error);
  }
  originalSetActiveLeaf = null;
  patchedSetActiveLeaf = null;
}

class EditorAdapter {
  view;
  constructor(view) {
    this.view = view;
  }
  getDoc() {
    return this;
  }
  getValue() {
    return this.view.state.doc.toString();
  }
  setValue(value) {
    const doc = this.view.state.doc;
    this.view.dispatch({ changes: { from: 0, to: doc.length, insert: value } });
  }
  getLine(line) {
    return this.view.state.doc.line(line + 1).text;
  }
  lineCount() {
    return this.view.state.doc.lines;
  }
  lastLine() {
    return this.lineCount() - 1;
  }
  getSelection() {
    const selection = this.view.state.selection.main;
    return this.view.state.doc.sliceString(selection.from, selection.to);
  }
  somethingSelected() {
    return !this.view.state.selection.main.empty;
  }
  getRange(from, to) {
    return this.view.state.doc.sliceString(this.posToOffset(from), this.posToOffset(to));
  }
  replaceSelection(text) {
    const transaction = this.view.state.changeByRange((range) => ({
      changes: { from: range.from, to: range.to, insert: text },
      range: CmState.EditorSelection.cursor(range.from + text.length)
    }));
    this.view.dispatch(transaction);
  }
  replaceRange(text, from, to) {
    this.view.dispatch({
      changes: { from: this.posToOffset(from), to: this.posToOffset(to ?? from), insert: text }
    });
  }
  getCursor(which) {
    const selection = this.view.state.selection.main;
    switch (which) {
      case "from":
        return this.offsetToPos(selection.from);
      case "to":
        return this.offsetToPos(selection.to);
      case "anchor":
        return this.offsetToPos(selection.anchor);
      default:
        return this.offsetToPos(selection.head);
    }
  }
  listSelections() {
    const self = this;
    return this.view.state.selection.ranges.map((range) => ({
      anchor: self.offsetToPos(range.anchor),
      head: self.offsetToPos(range.head)
    }));
  }
  setCursor(line, ch) {
    if (typeof line === "number") {
      this.setSelection({ line, ch: ch ?? 0 });
      return;
    }
    this.setSelection(line);
  }
  setSelection(from, to) {
    this.view.dispatch({
      selection: CmState.EditorSelection.range(this.posToOffset(from), this.posToOffset(to ?? from))
    });
  }
  setSelections(ranges, main) {
    if (ranges.length === 0)
      return;
    const self = this;
    this.view.dispatch({
      selection: CmState.EditorSelection.create(ranges.map((range) => CmState.EditorSelection.range(self.posToOffset(range.anchor), self.posToOffset(range.head ?? range.anchor))), main || 0)
    });
  }
  focus() {
    this.view.focus();
  }
  blur() {
    this.view.contentDOM.blur();
  }
  hasFocus() {
    return this.view.hasFocus;
  }
  transaction(transactionData) {
    if (transactionData.replaceSelection !== undefined) {
      this.replaceSelection(transactionData.replaceSelection);
      return;
    }
    const self = this;
    const changes = transactionData.changes == null ? undefined : transactionData.changes.map((change) => ({
      from: self.posToOffset(change.from),
      to: self.posToOffset(change.to ?? change.from),
      insert: change.text
    }));
    const selections = transactionData.selections != null ? transactionData.selections : transactionData.selection ? [transactionData.selection] : undefined;
    const spec = {};
    if (changes)
      spec.changes = changes;
    if (selections && selections.length > 0) {
      spec.selection = CmState.EditorSelection.create(selections.map((selection) => CmState.EditorSelection.range(self.posToOffset(selection.from), self.posToOffset(selection.to ?? selection.from))));
    }
    this.view.dispatch(spec);
  }
  posToOffset(position) {
    const doc = this.view.state.doc;
    const lineNumber = Math.max(1, Math.min(position.line + 1, doc.lines));
    const line = doc.line(lineNumber);
    return Math.max(line.from, Math.min(line.from + position.ch, line.to));
  }
  offsetToPos(offset) {
    const doc = this.view.state.doc;
    const clamped = Math.max(0, Math.min(offset, doc.length));
    const line = doc.lineAt(clamped);
    return { line: line.number - 1, ch: clamped - line.from };
  }
}
var EDITOR_DEFAULTS = {
  value: "",
  file: undefined,
  placeholder: "",
  onChange: (_value) => {}
};
var editorClass = null;
function makeEditorClass(BaseClass) {
  return class EmbeddableMarkdownEditor extends BaseClass {
    destroyedFlag = false;
    onFocusIn;
    onBlurHandler;
    constructor(app, containerEl, options) {
      super(app, containerEl, {
        app,
        onMarkdownScroll: () => {},
        getMode: () => "source"
      });
      if (!this.owner || !this.editor || !this.editor.cm) {
        throw new Error("the editor base class did not provide owner/editor (Obsidian internals changed)");
      }
      this.app = app;
      this.options = Object.assign({}, EDITOR_DEFAULTS, options);
      this.scope = new obsidian.Scope(app.scope);
      this.scope.register(["Mod"], "Enter", () => true);
      this.scope.register(["Mod", "Shift"], "Enter", () => true);
      this.owner.editMode = this;
      this.owner.editor = this.editor;
      this.owner.file = this.getActiveEditorFile();
      this.owner.app = app;
      this.activeEditorOwner = {
        editMode: this,
        editor: new EditorAdapter(this.editor.cm),
        file: this.getActiveEditorFile(),
        getMode: () => "source"
      };
      this.set(this.options.value || "");
      liveEditors.push(this);
      installActiveLeafPatch(app);
      this.onFocusIn = () => {
        try {
          this.app.keymap.pushScope(this.scope);
          this.activeEditorOwner.file = this.getActiveEditorFile();
          this.app.workspace.activeEditor = this.activeEditorOwner;
        } catch (error) {
          console.error("[close-reflect] editor focus handler failed:", error);
        }
      };
      this.onBlurHandler = () => {
        try {
          this.app.keymap.popScope(this.scope);
        } catch (error) {
          console.error("[close-reflect] editor blur handler failed:", error);
        }
      };
      this.editor.cm.contentDOM.addEventListener("focusin", this.onFocusIn);
      this.editor.cm.contentDOM.addEventListener("blur", this.onBlurHandler);
    }
    get value() {
      return this.editor.cm.state.doc.toString();
    }
    setValue(value) {
      this.set(value);
    }
    getActiveEditorFile() {
      if (this.options.file !== undefined)
        return this.options.file ?? null;
      try {
        return this.app.workspace.getActiveFile();
      } catch (error) {
        return null;
      }
    }
    setFile(file) {
      this.options.file = file;
      if (this.activeEditorOwner)
        this.activeEditorOwner.file = file;
      if (this.owner)
        this.owner.file = file;
    }
    buildLocalExtensions() {
      const extensions = super.buildLocalExtensions();
      try {
        extensions.push(CmView.tooltips({ parent: document.body }));
      } catch (error) {
        console.warn("[close-reflect] could not inject the tooltips extension:", error);
      }
      if (this.options.placeholder)
        extensions.push(CmView.placeholder(this.options.placeholder));
      return extensions;
    }
    onUpdate(update, changed) {
      super.onUpdate(update, changed);
      if (changed) {
        try {
          this.options.onChange(this.value);
        } catch (error) {
          console.error("[close-reflect] editor onChange threw:", error);
        }
      }
    }
    destroy() {
      try {
        if (this.destroyedFlag)
          return;
        this.destroyedFlag = true;
        try {
          this.editor.cm.contentDOM.removeEventListener("focusin", this.onFocusIn);
        } catch (error) {}
        try {
          this.editor.cm.contentDOM.removeEventListener("blur", this.onBlurHandler);
        } catch (error) {}
        const index = liveEditors.indexOf(this);
        if (index >= 0)
          liveEditors.splice(index, 1);
        uninstallActiveLeafPatch(this.app);
        try {
          this.app.keymap.popScope(this.scope);
        } catch (error) {}
        try {
          if (this.app.workspace.activeEditor === this.activeEditorOwner) {
            this.app.workspace.activeEditor = null;
          }
        } catch (error) {}
        try {
          if (this._loaded)
            this.unload();
        } catch (error) {
          console.warn("[close-reflect] could not unload the editor:", error);
        }
        try {
          this.containerEl.empty();
        } catch (error) {}
        if (typeof super.destroy === "function")
          super.destroy();
      } catch (error) {
        console.error("[close-reflect] could not destroy the editor:", error);
      }
    }
    onunload() {
      this.destroy();
    }
  };
}
function createMarkdownEditor(app, containerEl, options = {}) {
  if (!isMarkdownEditorAvailable())
    return null;
  try {
    if (!editorClass)
      editorClass = makeEditorClass(resolveEditorPrototype(app));
    const editor = new editorClass(app, containerEl, options);
    return {
      getValue: () => editor.value,
      setValue: (value) => editor.setValue(value),
      focus: () => {
        try {
          editor.editor.cm.focus();
        } catch (error) {}
      },
      destroy: () => editor.destroy()
    };
  } catch (error) {
    console.error("[close-reflect] could not create the embedded editor; falling back to a textarea:", error);
    return null;
  }
}

// src/edit-modal.ts
var PREVIEW_DEBOUNCE_MS = 250;

class ContentEditModal extends import_obsidian5.Modal {
  plugin;
  onSaved;
  draft;
  linkedBodyAtLoad = null;
  editor = null;
  previewComponent = null;
  previewTimer = null;
  previewHostEl = null;
  constructor(app, plugin, onSaved) {
    super(app);
    this.plugin = plugin;
    this.onSaved = onSaved;
    const settings = plugin.settings;
    this.draft = {
      title: settings.title,
      content: settings.content,
      buttons: settings.buttons.map((button) => ({ ...button }))
    };
  }
  onOpen() {
    this.setTitle("Edit the reflection");
    this.modalEl.addClass("close-reflect-edit-modal");
    const grid = this.contentEl.createDiv({ cls: "close-reflect-edit-grid" });
    const left = grid.createDiv({ cls: "close-reflect-edit-left" });
    const right = grid.createDiv({ cls: "close-reflect-edit-right" });
    this.renderTitleField(left);
    if (this.plugin.settings.source === "linked")
      this.renderLinkedRow(left);
    this.renderEditorArea(left);
    this.renderButtonList(left);
    new import_obsidian5.Setting(right).setName("Preview").setHeading();
    this.previewHostEl = right.createDiv({ cls: "close-reflect-preview" });
    const footer = this.contentEl.createDiv({ cls: "modal-button-container" });
    new import_obsidian5.ButtonComponent(footer).setButtonText("Cancel").onClick(() => this.close());
    new import_obsidian5.ButtonComponent(footer).setButtonText("Save").setCta().onClick(() => {
      this.save();
    });
    if (this.plugin.settings.source === "linked") {
      this.loadLinkedBody();
    } else {
      this.schedulePreview();
    }
  }
  onClose() {
    this.teardownPreview();
    this.editor?.destroy();
    this.editor = null;
    this.contentEl.empty();
  }
  renderTitleField(host) {
    new import_obsidian5.Setting(host).setName("Title").setDesc("Shown in the overlay title bar.").addText((text) => text.setValue(this.draft.title).onChange((value) => {
      this.draft.title = value;
      this.schedulePreview();
    }));
  }
  renderLinkedRow(host) {
    const path = this.plugin.settings.linkedPath.trim();
    new import_obsidian5.Setting(host).setName("Linked note").setDesc(path === "" ? "No note chosen yet — pick one on the settings page under Content. Nothing will be saved back." : path).addButton((button) => button.setButtonText("Open the note").setDisabled(path === "").onClick(() => {
      this.app.workspace.openLinkText(path, "", false);
    })).addButton((button) => button.setButtonText("Reload from the note").setDisabled(path === "").onClick(() => {
      this.loadLinkedBody();
    }));
  }
  renderEditorArea(host) {
    new import_obsidian5.Setting(host).setName("Text").setHeading();
    const editorHost = host.createDiv({ cls: "close-reflect-editor-host" });
    this.editor = createMarkdownEditor(this.app, editorHost, {
      value: this.draft.content,
      file: this.app.workspace.getActiveFile(),
      placeholder: "Overlay text…",
      onChange: (value) => {
        this.draft.content = value;
        this.schedulePreview();
      }
    });
    if (this.editor)
      return;
    console.warn("[close-reflect] falling back to a textarea for the overlay text");
    const area = editorHost.createEl("textarea", { cls: "close-reflect-setting-textarea" });
    area.value = this.draft.content;
    area.addEventListener("input", () => {
      this.draft.content = area.value;
      this.schedulePreview();
    });
  }
  renderButtonList(host) {
    new import_obsidian5.Setting(host).setName("Buttons").setHeading();
    const listEditor = new ButtonListEditor(this.app, host, this.draft.buttons, () => this.schedulePreview());
    listEditor.render();
  }
  async loadLinkedBody() {
    const body = await this.plugin.readLinkedBody();
    this.linkedBodyAtLoad = body;
    if (body === null) {
      console.warn("[close-reflect] the linked note could not be read; saving will not write anything");
      return;
    }
    this.draft.content = body;
    this.editor?.setValue(body);
    if (!this.editor) {
      const area = this.contentEl.querySelector(".close-reflect-setting-textarea");
      if (area)
        area.value = body;
    }
    this.schedulePreview();
  }
  schedulePreview() {
    if (this.previewTimer !== null)
      window.clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = null;
      this.refreshPreview();
    }, PREVIEW_DEBOUNCE_MS);
  }
  refreshPreview() {
    const host = this.previewHostEl;
    if (!host || !host.isConnected)
      return;
    host.empty();
    this.previewComponent?.unload();
    const component = new import_obsidian5.Component;
    component.load();
    this.previewComponent = component;
    try {
      renderReflection(this.app, host, component, {
        title: this.draft.title,
        content: this.draft.content,
        buttons: this.draft.buttons
      }, { interactive: false });
    } catch (error) {
      console.error("[close-reflect] preview render failed:", error);
    }
  }
  teardownPreview() {
    if (this.previewTimer !== null) {
      window.clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
    this.previewComponent?.unload();
    this.previewComponent = null;
    this.previewHostEl = null;
  }
  async save() {
    const settings = this.plugin.settings;
    settings.title = this.draft.title;
    settings.buttons = this.draft.buttons.map((button) => ({ ...button }));
    if (settings.source === "inline") {
      settings.content = this.draft.content;
    }
    try {
      await this.plugin.saveSettings();
    } catch (error) {
      console.error("[close-reflect] saving the reflection failed:", error);
    }
    if (settings.source === "linked") {
      await this.saveLinkedBody();
    }
    this.close();
    this.onSaved();
  }
  async saveLinkedBody() {
    if (this.linkedBodyAtLoad === null) {
      console.warn("[close-reflect] not writing the linked note: it was never read");
      return;
    }
    if (this.draft.content === this.linkedBodyAtLoad)
      return;
    try {
      await this.plugin.writeLinkedBody(this.draft.content, this.linkedBodyAtLoad);
      this.linkedBodyAtLoad = this.draft.content;
    } catch (error) {
      console.error("[close-reflect] could not write the linked note:", error);
    }
  }
}

// src/settings.ts
class CloseReflectSettingTab extends import_obsidian6.PluginSettingTab {
  plugin;
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    const settings = this.plugin.settings;
    const save = () => this.plugin.saveSettings();
    new import_obsidian6.Setting(containerEl).setName("Content").setHeading();
    new import_obsidian6.Setting(containerEl).setName("Content source").setDesc("Write the text here, or render it from a note in the vault.").addDropdown((dropdown) => dropdown.addOption("inline", "Inline text").addOption("linked", "Linked note").setValue(settings.source).onChange(async (value) => {
      settings.source = value;
      await save();
      this.display();
    }));
    new import_obsidian6.Setting(containerEl).setName("Title, text and buttons").setDesc(settings.source === "linked" ? "Title and buttons, with a preview of the linked note." : "The overlay title, its text, and its action buttons.").addButton((button) => button.setButtonText("Edit…").setCta().onClick(() => {
      try {
        new ContentEditModal(this.app, this.plugin, () => this.display()).open();
      } catch (error) {
        console.error("[close-reflect] could not open the edit modal:", error);
      }
    }));
    if (settings.source === "linked") {
      new import_obsidian6.Setting(containerEl).setName("Linked note").setDesc("The note whose contents the overlay shows. Start typing to search.").addText((text) => {
        text.setValue(settings.linkedPath).onChange(async (value) => {
          settings.linkedPath = value.trim();
          await save();
        });
        new NoteSuggest(this.app, text.inputEl, async (file) => {
          settings.linkedPath = file.path;
          await save();
          await this.plugin.refreshLinkedCache();
          this.display();
        });
      });
      const remembered = settings.linkedCachedAt ? `Remembered copy saved ${settings.linkedCachedAt}, ${settings.linkedCache.length} characters.` : "Nothing remembered yet.";
      new import_obsidian6.Setting(containerEl).setName("Remembered copy").setDesc(`Shown when the note cannot be read (moved, deleted, or the vault is shutting down). ${remembered}`).addButton((button) => button.setButtonText("Refresh now").onClick(async () => {
        await this.plugin.refreshLinkedCache();
        this.display();
      }));
    }
    new import_obsidian6.Setting(containerEl).setName("Behaviour").setHeading();
    new import_obsidian6.Setting(containerEl).setName("Interceptions before release").setDesc("How many quits to interrupt. Once spent, later quits close without asking.").addText((text) => {
      text.inputEl.type = "number";
      text.setValue(String(settings.intercepts)).onChange(async (value) => {
        const parsed = Number.parseInt(value, 10);
        settings.intercepts = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
        await save();
      });
    });
    new import_obsidian6.Setting(containerEl).setName("Interception budget now").setDesc(`Quits interrupted so far this session: ${this.plugin.getInterceptCount()}.`).addButton((button) => button.setButtonText("Reset").onClick(() => {
      this.plugin.resetInterceptCount();
      this.display();
    }));
    new import_obsidian6.Setting(containerEl).setName("Release timeout").setDesc("Milliseconds to wait for an answer before the timeout action below is taken.").addText((text) => {
      text.inputEl.type = "number";
      text.setValue(String(settings.timeoutMs)).onChange(async (value) => {
        const parsed = Number.parseInt(value, 10);
        settings.timeoutMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 30000;
        await save();
      });
    });
    new import_obsidian6.Setting(containerEl).setName("When the timeout expires").setDesc("What an unanswered prompt does. Cancelling keeps the app open; letting it close is the safety net that stops a broken overlay from trapping the app.").addDropdown((dropdown) => dropdown.addOption("stay", "Cancel the quit and stay open").addOption("leave", "Let the app close").setValue(settings.timeoutAction).onChange(async (value) => {
      settings.timeoutAction = value;
      await save();
    }));
    new import_obsidian6.Setting(containerEl).setName("Diagnostics").setHeading();
    new import_obsidian6.Setting(containerEl).setName("Write diagnostics to a file").setDesc("Appends one entry per quit attempt: which layers covered the overlay, and whether frames were still being produced.").addToggle((toggle) => toggle.setValue(settings.writeDiagnostics).onChange(async (value) => {
      settings.writeDiagnostics = value;
      await save();
    }));
    new import_obsidian6.Setting(containerEl).setName("Diagnostics file").setDesc("Vault-relative path. The last 20 entries are kept.").addText((text) => text.setValue(settings.diagPath).onChange(async (value) => {
      settings.diagPath = value.trim();
      await save();
    }));
    new import_obsidian6.Setting(containerEl).setName("Developer log").setDesc("Echo the same diagnostics to the console, and write a crash-safe step-by-step trace to close-reflect-trace.log in the system temp folder. Errors are always logged regardless of this setting.").addToggle((toggle) => toggle.setValue(settings.logToConsole).onChange(async (value) => {
      settings.logToConsole = value;
      await save();
    }));
  }
}

// src/actions.ts
function actionNeedsTarget(action) {
  return action === "openNote" || action === "runCommand" || action === "openUrl";
}
function performButtonAction(app, button, report) {
  const target = button.target.trim();
  if (actionNeedsTarget(button.action) && target === "") {
    report(`button "${button.label}" has no target; nothing to do`, null);
    return;
  }
  try {
    switch (button.action) {
      case "openNote":
        app.workspace.openLinkText(target, "", false);
        return;
      case "runCommand":
        runCommand(app, target, button, report);
        return;
      case "openUrl":
        window.open(target, "_blank");
        return;
      case "stay":
      case "leave":
        return;
    }
  } catch (error) {
    report(`button "${button.label}" failed:`, error);
  }
}
function runCommand(app, commandId, button, report) {
  const registry = app.commands;
  if (!registry || typeof registry.executeCommandById !== "function") {
    report(`cannot run the command for button "${button.label}": the command registry is unavailable`, null);
    return;
  }
  if (!registry.executeCommandById(commandId)) {
    report(`button "${button.label}" points at a command that is not registered:`, commandId);
  }
}

// src/plugin.ts
var DIAG_LIMIT = 60;
var HEARTBEAT_MS = 2000;
var TRACE_ENABLED = true;
var traceEnabled = false;
function syncTraceSwitch(enabled) {
  traceEnabled = enabled;
}
var traceRequire = window.require ?? require;
var traceFs = traceRequire ? traceRequire("fs") : null;
var tracePath = traceRequire ? traceRequire("os").tmpdir() + "/close-reflect-trace.log" : null;
function trace(message, extra) {
  if (!TRACE_ENABLED || !traceEnabled || !traceFs || !tracePath)
    return;
  try {
    const stamp = `${Date.now()} +${Math.round(performance.now())}ms`;
    traceFs.appendFileSync(tracePath, `${stamp} ${message}${extra ? " " + JSON.stringify(extra) : ""}
`);
  } catch (error) {
    console.error("[close-reflect] trace write failed:", error);
  }
}
function describeOutcome(outcome) {
  if (outcome.kind === "button") {
    return { kind: outcome.kind, id: outcome.button.id, action: outcome.button.action };
  }
  return { kind: outcome.kind };
}

class CloseReflectPlugin extends import_obsidian7.Plugin {
  interceptCount = 0;
  holding = false;
  veto = false;
  vetoTimer = null;
  leaving = false;
  leavingTimer = null;
  originalWindowClose = null;
  closePatched = false;
  liveModal = null;
  obsidianQuitHook = null;
  unloaded = false;
  heartbeatTimer = null;
  heartbeatTick = 0;
  traceTimer = null;
  mainWindowGuard = null;
  pendingCloseEvent = null;
  async onload() {
    trace("onload:begin", { tracePath, hasRequire: !!traceRequire });
    this.unloaded = false;
    await this.loadSettings();
    this.addSettingTab(new CloseReflectSettingTab(this.app, this));
    this.refreshLinkedCache();
    window.__closeReflectBound = true;
    this.standDownLegacyBuild();
    this.captureObsidianQuitHook();
    this.registerEvent(this.app.workspace.on("quit", (tasks) => this.handleQuit(tasks)));
    this.registerDomEvent(window, "beforeunload", (event) => this.handleBeforeUnload(event));
    this.installWindowClosePatch();
    this.installMainWindowGuard();
    this.app.workspace.onLayoutReady(() => {
      if (!this.unloaded)
        this.captureObsidianQuitHook();
    });
    this.addCommand({
      id: "preview-reflection-modal",
      name: "Preview the reflection modal",
      callback: () => {
        this.preview();
      }
    });
    this.log("loaded");
    trace("onload:end", { closePatched: this.closePatched, hookCaptured: !!this.obsidianQuitHook });
  }
  onunload() {
    trace("onunload");
    this.unloaded = true;
    this.pendingCloseEvent = null;
    this.stopHeartbeat();
    this.holding = false;
    this.clearVeto("unload");
    this.leaving = false;
    if (this.leavingTimer !== null) {
      window.clearTimeout(this.leavingTimer);
      this.leavingTimer = null;
    }
    if (this.closePatched && this.originalWindowClose) {
      window.close = this.originalWindowClose;
      this.closePatched = false;
    }
    if (this.mainWindowGuard) {
      try {
        this.mainWindowGuard.win.removeListener("close", this.mainWindowGuard.handler);
      } catch (error) {
        this.error("failed to remove the main window close guard:", error);
      }
      this.mainWindowGuard = null;
    }
    if (this.liveModal) {
      try {
        this.liveModal.close();
      } catch (error) {
        this.error("failed to close the overlay on unload:", error);
      }
      this.liveModal = null;
    }
  }
  standDownLegacyBuild() {
    try {
      const legacy = window.__closeReflect;
      if (legacy && typeof legacy.unbind === "function") {
        legacy.unbind();
        this.log("stood the DataviewJS build down");
      }
    } catch (error) {
      this.error("failed to stand the DataviewJS build down:", error);
    }
  }
  captureObsidianQuitHook() {
    try {
      const hook = window.onbeforeunload;
      if (typeof hook === "function") {
        this.obsidianQuitHook = hook;
        this.log("captured Obsidian's quit hook");
      }
      trace("captureQuitHook", { captured: !!this.obsidianQuitHook, type: typeof hook });
    } catch (error) {
      this.error("failed to capture Obsidian's quit hook:", error);
    }
  }
  async loadSettings() {
    this.settings = migrateSettings(await this.loadData());
    syncTraceSwitch(this.settings.logToConsole);
  }
  async saveSettings() {
    await this.saveData(this.settings);
    syncTraceSwitch(this.settings.logToConsole);
  }
  getInterceptCount() {
    return this.interceptCount;
  }
  resetInterceptCount() {
    this.interceptCount = 0;
    this.log("intercept counter reset");
  }
  preview() {
    this.showModal().then((outcome) => {
      this.log("preview outcome:", describeOutcome(outcome));
    });
  }
  async resolveContent() {
    const settings = this.settings;
    if (settings.source !== "linked")
      return settings.content;
    const path = settings.linkedPath.trim();
    if (path === "")
      return settings.content;
    try {
      const file = this.app.vault.getAbstractFileByPath(import_obsidian7.normalizePath(path));
      if (file instanceof import_obsidian7.TFile && file.extension === "md") {
        return await this.readNoteBody(file);
      }
      this.warn("linked note not found; using the remembered copy");
    } catch (error) {
      this.error("reading the linked note failed; using the remembered copy:", error);
    }
    return settings.linkedCache !== "" ? settings.linkedCache : settings.content;
  }
  async readNoteBody(file) {
    return stripFrontmatter(await this.app.vault.cachedRead(file));
  }
  async readLinkedBody() {
    const path = this.settings.linkedPath.trim();
    if (path === "")
      return null;
    try {
      const file = this.app.vault.getAbstractFileByPath(import_obsidian7.normalizePath(path));
      if (!(file instanceof import_obsidian7.TFile) || file.extension !== "md")
        return null;
      return await this.readNoteBody(file);
    } catch (error) {
      this.error("reading the linked note for editing failed:", error);
      return null;
    }
  }
  async writeLinkedBody(body, expectedBody) {
    const path = this.settings.linkedPath.trim();
    if (path === "")
      throw new Error("no linked note is configured");
    const file = this.app.vault.getAbstractFileByPath(import_obsidian7.normalizePath(path));
    if (!(file instanceof import_obsidian7.TFile) || file.extension !== "md") {
      throw new Error(`the linked note is not a Markdown file: ${path}`);
    }
    await this.app.vault.process(file, (data) => {
      const parts = splitFrontmatter(data);
      if (parts.body !== expectedBody) {
        this.warn("the linked note changed underneath the editor; saving over it anyway");
      }
      return parts.frontmatter + body;
    });
    await this.refreshLinkedCache();
    this.log("linked note body written back:", path);
  }
  async refreshLinkedCache() {
    const settings = this.settings;
    if (settings.source !== "linked")
      return;
    const path = settings.linkedPath.trim();
    if (path === "") {
      if (settings.linkedCache !== "" || settings.linkedCachedAt !== "") {
        settings.linkedCache = "";
        settings.linkedCachedAt = "";
        await this.saveSettings();
      }
      return;
    }
    try {
      const file = this.app.vault.getAbstractFileByPath(import_obsidian7.normalizePath(path));
      if (!(file instanceof import_obsidian7.TFile) || file.extension !== "md") {
        this.warn("cannot remember a copy: no markdown note at", path);
        return;
      }
      const text = await this.readNoteBody(file);
      settings.linkedCache = text.length > MAX_REMEMBERED_CHARS ? text.slice(0, MAX_REMEMBERED_CHARS) : text;
      settings.linkedCachedAt = new Date().toISOString();
      await this.saveSettings();
      this.log("remembered copy refreshed:", path, settings.linkedCache.length, "chars");
    } catch (error) {
      this.error("refreshing the remembered copy failed:", error);
    }
  }
  handleQuit(tasks) {
    trace("handleQuit:enter", { leaving: this.leaving, holding: this.holding, count: this.interceptCount });
    try {
      if (this.leaving) {
        this.log("leave was chosen; not intercepting this quit");
        trace("handleQuit:skip-leaving");
        return;
      }
      if (this.holding) {
        this.log("already prompting; not intercepting again");
        trace("handleQuit:skip-holding");
        return;
      }
      if (this.interceptCount >= this.settings.intercepts) {
        this.log("interception budget spent; allowing the quit");
        trace("handleQuit:skip-budget");
        return;
      }
      this.interceptCount += 1;
      this.log(`interception #${this.interceptCount}`);
      if (!tasks || typeof tasks.addPromise !== "function") {
        this.warn("Tasks.addPromise unavailable; cannot defer the quit");
        trace("handleQuit:skip-no-addPromise");
        return;
      }
      this.holding = true;
      this.startHeartbeat();
      this.markCloseEvent("holding");
      const sequence = this.writeDiagnostic("quit-intercepted").then(() => {
        trace("seq:diag-written");
        return this.showModal();
      }).then((outcome) => this.applyOutcome(outcome));
      tasks.addPromise(sequence);
      trace("handleQuit:promise-added");
    } catch (error) {
      this.holding = false;
      this.stopHeartbeat();
      trace("handleQuit:threw", { error: String(error) });
      this.error("quit hook threw; allowing this quit:", error);
    }
  }
  applyOutcome(outcome) {
    trace("seq:settled", { outcome: describeOutcome(outcome) });
    this.stopHeartbeat();
    this.holding = false;
    try {
      if (this.letsTheQuitThrough(outcome)) {
        this.log("quit allowed through:", describeOutcome(outcome));
        this.allowTheQuit();
        return this.writeDiagnostic("quit-settled", { outcome: describeOutcome(outcome) });
      }
      this.raiseVeto();
      this.dismissSavingOverlay();
      if (outcome.kind === "button" && outcome.button.action !== "stay") {
        performButtonAction(this.app, outcome.button, (message, error) => this.error(message, error));
      }
    } catch (error) {
      this.error("handling the prompt outcome threw:", error);
    }
    return this.writeDiagnostic("quit-settled", { outcome: describeOutcome(outcome) });
  }
  letsTheQuitThrough(outcome) {
    if (outcome.kind === "error")
      return true;
    if (outcome.kind === "timeout")
      return this.settings.timeoutAction === "leave";
    if (outcome.kind === "button")
      return outcome.button.action === "leave";
    return false;
  }
  getEffectiveButtons() {
    if (this.settings.buttons.length > 0)
      return this.settings.buttons;
    this.warn('no buttons configured; falling back to a single "cancel the quit" button');
    return [{ id: "fallback-stay", label: "Cancel the quit", action: "stay", target: "" }];
  }
  showModal() {
    trace("showModal:enter");
    return new Promise((resolve) => {
      let settled = false;
      let timedOut = false;
      let timer = null;
      const finish = (outcome) => {
        if (settled)
          return;
        trace("showModal:finish", { outcome: describeOutcome(outcome), timedOut });
        settled = true;
        if (timer !== null)
          window.clearTimeout(timer);
        this.liveModal = null;
        resolve(outcome);
      };
      timer = window.setTimeout(() => {
        timedOut = true;
        this.warn("prompt timed out; applying the timeout action");
        if (this.liveModal) {
          try {
            this.liveModal.close();
          } catch (error) {
            this.error("failed to close the timed-out prompt:", error);
          }
        }
        finish({ kind: "timeout" });
      }, this.settings.timeoutMs);
      this.resolveContent().then((content) => {
        trace("showModal:content-resolved", { settled, chars: content.length });
        if (settled)
          return;
        const overlay = new ReflectOverlay(this.app, {
          title: this.settings.title,
          content,
          buttons: this.getEffectiveButtons(),
          onClose: (outcome) => {
            if (timedOut)
              return;
            finish(outcome);
          }
        });
        this.liveModal = overlay;
        overlay.open();
        trace("showModal:overlay-opened", {
          inBody: !!overlay.element && document.body.contains(overlay.element)
        });
        window.setTimeout(() => {
          this.measureRaf().then((rafAlive) => {
            return this.writeDiagnostic("modal-shown", { rafAlive });
          });
        }, 250);
      }).catch((error) => {
        this.error("failed to open the overlay; releasing the quit:", error);
        finish({ kind: "error" });
      });
    });
  }
  raiseVeto() {
    this.veto = true;
    this.markCloseEvent("veto");
    if (this.vetoTimer !== null)
      window.clearTimeout(this.vetoTimer);
    this.vetoTimer = window.setTimeout(() => {
      this.vetoTimer = null;
      if (this.veto) {
        this.veto = false;
        this.warn("veto flag expired unused");
        this.rearmQuitHook("veto-expired");
      }
    }, 5000);
    this.log("veto raised; the follow-up close will be swallowed");
  }
  rearmQuitHook(source) {
    trace("rearmQuitHook", { source, captured: !!this.obsidianQuitHook, slotNull: window.onbeforeunload === null });
    if (!this.obsidianQuitHook)
      return;
    if (window.onbeforeunload !== null)
      return;
    try {
      window.onbeforeunload = this.obsidianQuitHook;
      this.log("Obsidian quit hook re-armed:", source);
      this.writeDiagnostic("quit-hook-rearmed", { source });
    } catch (error) {
      this.error("failed to re-arm Obsidian's quit hook:", error);
    }
  }
  clearVeto(reason) {
    this.veto = false;
    if (this.vetoTimer !== null) {
      window.clearTimeout(this.vetoTimer);
      this.vetoTimer = null;
    }
    this.log("veto cleared:", reason);
  }
  allowTheQuit() {
    this.leaving = true;
    if (this.leavingTimer !== null)
      window.clearTimeout(this.leavingTimer);
    this.leavingTimer = window.setTimeout(() => {
      this.leavingTimer = null;
      if (this.leaving) {
        this.leaving = false;
        this.warn("leave did not close the app; re-arming interception");
      }
    }, 8000);
  }
  installWindowClosePatch() {
    if (this.closePatched)
      return;
    try {
      const original = window.close;
      this.originalWindowClose = original;
      window.close = () => {
        trace("window.close:called", { holding: this.holding, veto: this.veto, caller: this.callerStack().slice(0, 120) });
        if (this.holding) {
          this.log("window.close() swallowed while prompting");
          this.writeDiagnostic("window-close-swallowed", { whileHolding: true, caller: this.callerStack() });
          return;
        }
        if (this.veto) {
          this.clearVeto("consumed-by-window.close");
          this.rearmQuitHook("consumed-by-window.close");
          this.log('window.close() swallowed after "stay"');
          this.writeDiagnostic("window-close-swallowed", { whileHolding: false, caller: this.callerStack() });
          return;
        }
        this.log("window.close() forwarded");
        original.call(window);
      };
      this.closePatched = true;
      this.log("window.close patched");
    } catch (error) {
      this.error("failed to patch window.close:", error);
    }
  }
  installMainWindowGuard() {
    try {
      const host = window;
      const remote = host.electron?.remote;
      const win = host.electronWindow ?? remote?.getCurrentWindow?.() ?? null;
      trace("mainWindowGuard:probe", { hasElectron: !!host.electron, hasRemote: !!remote, hasWindow: !!win });
      if (!win || typeof win.on !== "function") {
        this.warn("main window handle unavailable; the three-second close guard stays in force");
        return;
      }
      const handler = (event) => {
        this.pendingCloseEvent = event;
        trace("mainWindowGuard:close-seen", { holding: this.holding, veto: this.veto });
      };
      win.on("close", handler);
      this.mainWindowGuard = { win, handler };
      this.log("main window close guard installed");
    } catch (error) {
      this.error("failed to install the main window close guard:", error);
    }
  }
  dismissSavingOverlay() {
    try {
      const doc = window.document;
      const container = doc.querySelector(".progress-bar-container");
      if (container)
        container.remove();
      doc.body.removeClass("in-progress");
      trace("savingOverlay:dismissed", { found: !!container });
      this.log("saving screen dismissed", container ? "" : "(none was up)");
    } catch (error) {
      this.error("failed to dismiss the saving screen:", error);
    }
  }
  markCloseEvent(reason) {
    const event = this.pendingCloseEvent;
    if (!event)
      return;
    try {
      event.preventDefault?.();
      trace("mainWindowGuard:close-marked", { reason, holding: this.holding, veto: this.veto });
    } catch (error) {
      this.error("failed to mark the window close event:", error);
    }
  }
  handleBeforeUnload(event) {
    const holding = this.holding;
    const veto = this.veto;
    const legacy = event;
    const returnValueBefore = String(legacy.returnValue);
    this.writeDiagnostic("beforeunload", { holding, veto, returnValueBefore });
    if (!holding && !veto) {
      trace("beforeunload:pass-through", { returnValueBefore });
      return;
    }
    if (!holding) {
      this.clearVeto("consumed-by-beforeunload");
      this.rearmQuitHook("consumed-by-beforeunload");
    }
    trace("beforeunload:acting", { holding, veto, returnValueBefore });
    event.preventDefault();
    if (typeof legacy.returnValue !== "string" || legacy.returnValue === "") {
      legacy.returnValue = "Reflecting...";
    }
    trace("beforeunload:done", { returnValueAfter: String(legacy.returnValue), defaultPrevented: event.defaultPrevented });
    this.log("unload cancelled", holding ? "while prompting" : 'after "stay"');
  }
  callerStack() {
    try {
      throw new Error("trace");
    } catch (error) {
      const lines = String(error.stack || "").split(`
`);
      return lines.slice(2, 8).map((line) => line.trim()).join(" | ");
    }
  }
  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTick = 0;
    this.traceTimer = window.setInterval(() => {
      trace("alive");
    }, 250);
    this.heartbeatTimer = window.setInterval(() => {
      this.heartbeatTick += 1;
      this.writeDiagnostic("heartbeat", { tick: this.heartbeatTick });
    }, HEARTBEAT_MS);
  }
  stopHeartbeat() {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.traceTimer !== null) {
      window.clearInterval(this.traceTimer);
      this.traceTimer = null;
    }
  }
  measureRaf() {
    return new Promise((resolve) => {
      let fired = false;
      try {
        window.requestAnimationFrame(() => {
          fired = true;
        });
      } catch (error) {
        this.error("requestAnimationFrame unavailable:", error);
        return resolve(false);
      }
      window.setTimeout(() => resolve(fired), 300);
    });
  }
  snapshot(phase, extra) {
    const entry = {
      at: new Date().toISOString(),
      phase,
      interceptCount: this.interceptCount,
      holding: this.holding,
      veto: this.veto,
      leaving: this.leaving,
      heartbeatTick: this.heartbeatTick,
      closePatched: this.closePatched,
      appVersion: this.app.appVersion ?? null,
      visibility: document.visibilityState,
      hidden: document.hidden,
      hasFocus: document.hasFocus(),
      overlayOpen: this.liveModal !== null,
      ourZ: null,
      ourRect: null,
      topmost: null,
      weAreTopmost: null,
      covering: []
    };
    try {
      const ours = document.querySelector(".close-reflect-overlay");
      if (ours) {
        const rect = ours.getBoundingClientRect();
        entry.ourZ = window.getComputedStyle(ours).zIndex;
        entry.ourRect = [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)];
        const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + 20);
        entry.topmost = top ? String(top.className || top.tagName) : null;
        entry.weAreTopmost = !!(top && (ours === top || ours.contains(top)));
      }
      const mine = Number.parseInt(String(entry.ourZ ?? "0"), 10) || 0;
      const covering = [];
      document.querySelectorAll("body > div, .modal-container, .modal, .notice-container").forEach((el) => {
        const style = window.getComputedStyle(el);
        if (style.position !== "fixed" && style.position !== "absolute")
          return;
        const z = Number.parseInt(style.zIndex || "0", 10) || 0;
        if (z <= mine)
          return;
        const rect = el.getBoundingClientRect();
        if (rect.width < 100 || rect.height < 60)
          return;
        covering.push({
          z,
          cls: String(el.className).slice(0, 70),
          text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60)
        });
      });
      entry.covering = covering.slice(0, 10);
    } catch (error) {
      entry.diagError = String(error);
    }
    if (extra) {
      for (const key of Object.keys(extra))
        entry[key] = extra[key];
    }
    return entry;
  }
  diagChain = Promise.resolve();
  writeDiagnostic(phase, extra) {
    const entry = this.snapshot(phase, extra);
    if (this.settings.logToConsole)
      this.log("diagnostic", JSON.stringify(entry));
    if (!this.settings.writeDiagnostics)
      return Promise.resolve();
    const run = this.diagChain.then(() => this.appendDiagnostic(entry));
    this.diagChain = run.catch(() => {
      return;
    });
    return run;
  }
  async appendDiagnostic(entry) {
    try {
      const path = this.settings.diagPath;
      const raw = await this.app.vault.adapter.read(path).catch(() => "");
      let entries = [];
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed))
          entries = parsed;
      } catch (error) {
        this.log("diagnostics file was unreadable; starting a new log:", error);
      }
      entries.push(entry);
      if (entries.length > DIAG_LIMIT)
        entries = entries.slice(entries.length - DIAG_LIMIT);
      const payload = JSON.stringify(entries, null, 1);
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof import_obsidian7.TFile) {
        await this.app.vault.process(existing, () => payload);
      } else {
        await this.app.vault.adapter.write(path, payload);
      }
    } catch (error) {
      this.error("diagnostic write failed:", error);
    }
  }
  log(...args) {
    if (this.settings?.logToConsole)
      console.log("[close-reflect]", ...args);
  }
  warn(...args) {
    if (this.settings?.logToConsole)
      console.warn("[close-reflect]", ...args);
  }
  error(...args) {
    console.error("[close-reflect]", ...args);
  }
}

// src/main.ts
module.exports = CloseReflectPlugin;
