/**
 * 远端文本文件在线编辑器。
 *
 * 这个模块只会被 file-manager 通过 `import()` 按需加载，CodeMirror 及其语言包
 * 因此不会进入首屏 / 终端首屏 chunk。语言包与 markdown 预览依赖（marked、
 * DOMPurify）同样在真正打开对应文件时才加载。
 */
import { EditorState, type Extension, type Text } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import {
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { AutosaveController, editorAutosaveDelay, editorAutosaveInterval, type AutosavePhase } from './autosave';
import { editorLanguageFor, isMarkdownFile } from './file-language';
import './file-editor.css';

interface LocalizedText {
  zh: string;
  en: string;
}

interface EditorCopy {
  save: string;
  saveShortcut: string;
  preview: string;
  source: string;
  close: string;
  dialog: string;
  dirty: string;
  clean: string;
  saved: string;
  saving: string;
  previewing: string;
  empty: string;
  fullscreen: string;
  exitFullscreen: string;
  autosavePending: string;
  autosaveSaving: string;
  autosavePaused: string;
}

export interface EditorDocument {
  path: string;
  name: string;
  content: string;
  /** 打开时的远端修改时间（秒级），保存时作为冲突校验基准。 */
  mtime: number;
}

export type EditorSaveResult = 'started' | 'retry' | 'failed';

export interface FileEditorOptions {
  localize: (copy: LocalizedText) => string;
  /** 关闭请求（按钮 / Esc），由 FileManager 统一做未保存确认。 */
  requestClose: () => void;
  /**
   * Ctrl/Cmd+S、「保存」按钮或自动保存到点。`retry` 表示通道被占用、稍后再试；
   * `failed` 表示这次没启动（FileManager 已经通过 markSaveFailed 给出原因）。
   */
  requestSave: (content: string, origin: 'manual' | 'auto') => EditorSaveResult;
}

const LIGHT_TEXT = '#e9f0f3';
const ACCENT = '#69e6b4';

/**
 * 只在文本真的变化时写 DOM。状态标签是 `aria-live` 区域，每敲一个字都重写
 * 会让读屏软件把整句重新播报一遍。
 */
function setLiveText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

const theme = EditorView.theme({
  '&': {
    height: '100%',
    color: LIGHT_TEXT,
    backgroundColor: '#0d1219',
    fontSize: '12px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'Cascadia Code, SFMono-Regular, Consolas, Liberation Mono, monospace',
    lineHeight: '1.55',
  },
  '.cm-content': { caretColor: ACCENT, padding: '6px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: ACCENT },
  '.cm-gutters': { backgroundColor: '#0a0f15', color: '#5b6b78', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'rgba(105, 230, 180, 0.06)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(105, 230, 180, 0.08)', color: '#9fb3c0' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'rgba(105, 230, 180, 0.24)',
  },
  '.cm-panels': { backgroundColor: '#0d1219', color: LIGHT_TEXT },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid #253341' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid #253341' },
  '.cm-textfield': { backgroundColor: '#080b10', color: LIGHT_TEXT, border: '1px solid #253341' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: '#151d26', color: LIGHT_TEXT, border: '1px solid #253341' },
  '.cm-searchMatch': { backgroundColor: 'rgba(240, 200, 105, 0.25)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(240, 200, 105, 0.45)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'rgba(105, 230, 180, 0.18)',
    outline: '1px solid rgba(105, 230, 180, 0.5)',
  },
}, { dark: true });

const highlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: '#5b7585', fontStyle: 'italic' },
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: '#c792ea' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: '#a5d6a7' },
  { tag: [tags.number, tags.bool, tags.null], color: '#f0c869' },
  { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: ACCENT },
  { tag: [tags.propertyName, tags.attributeName, tags.variableName], color: '#8fd3ff' },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName], color: '#ffd580' },
  { tag: [tags.heading, tags.strong], color: ACCENT, fontWeight: '600' },
  { tag: [tags.link, tags.url], color: '#8fd3ff', textDecoration: 'underline' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.invalid, color: '#ff7575' },
  { tag: [tags.punctuation, tags.bracket], color: '#8b9aa6' },
]);

const hookedSanitizers = new WeakSet<object>();

async function languageSupport(name: string): Promise<Extension> {
  const lower = name.toLowerCase();
  switch (editorLanguageFor(name)) {
    case 'javascript': {
      const { javascript } = await import('@codemirror/lang-javascript');
      return javascript({ jsx: lower.endsWith('.jsx') });
    }
    case 'typescript': {
      const { javascript } = await import('@codemirror/lang-javascript');
      return javascript({ typescript: true, jsx: lower.endsWith('.tsx') });
    }
    case 'css': {
      const { css } = await import('@codemirror/lang-css');
      return css();
    }
    case 'html': {
      const { html } = await import('@codemirror/lang-html');
      return html();
    }
    case 'json': {
      const { json } = await import('@codemirror/lang-json');
      return json();
    }
    case 'markdown': {
      const { markdown } = await import('@codemirror/lang-markdown');
      return markdown();
    }
    case 'yaml': {
      const { yaml } = await import('@codemirror/lang-yaml');
      return yaml();
    }
    case 'python': {
      const { python } = await import('@codemirror/lang-python');
      return python();
    }
    case 'sql': {
      const { sql } = await import('@codemirror/lang-sql');
      return sql();
    }
    case 'xml': {
      const { xml } = await import('@codemirror/lang-xml');
      return xml();
    }
    case 'shell': {
      const { shell } = await import('@codemirror/legacy-modes/mode/shell');
      return StreamLanguage.define(shell);
    }
    default:
      return [];
  }
}

const COPY: Record<keyof EditorCopy, LocalizedText> = {
  save: { zh: '保存', en: 'Save' },
  saveShortcut: { zh: '保存（Ctrl+S）', en: 'Save (Ctrl+S)' },
  preview: { zh: '预览', en: 'Preview' },
  source: { zh: '源码', en: 'Source' },
  close: { zh: '关闭编辑器', en: 'Close editor' },
  dialog: { zh: '文件编辑器', en: 'File editor' },
  dirty: { zh: '未保存', en: 'Unsaved changes' },
  clean: { zh: '无修改', en: 'No changes' },
  saved: { zh: '已保存', en: 'Saved' },
  saving: { zh: '正在保存…', en: 'Saving…' },
  previewing: { zh: '预览中', en: 'Preview' },
  empty: { zh: '文件为空', en: 'Empty file' },
  fullscreen: { zh: '全屏', en: 'Fullscreen' },
  exitFullscreen: { zh: '还原', en: 'Exit fullscreen' },
  autosavePending: { zh: '等待自动保存', en: 'Auto-save pending' },
  autosaveSaving: { zh: '自动保存中…', en: 'Auto-saving…' },
  autosavePaused: { zh: '自动保存已暂停 · 请确认远端版本', en: 'Auto-save paused · verify remote version' },
};

export class FileEditor {
  static async create(options: FileEditorOptions, file: EditorDocument): Promise<FileEditor> {
    const editor = new FileEditor(options, file);
    await editor.mount();
    return editor;
  }

  readonly element: HTMLElement;
  private readonly options: FileEditorOptions;
  private readonly file: EditorDocument;
  private readonly title: HTMLElement;
  private readonly pathLabel: HTMLElement;
  private readonly stateLabel: HTMLElement;
  private readonly autosaveLabel: HTMLElement;
  private readonly saveButton: HTMLButtonElement;
  private readonly previewButton: HTMLButtonElement;
  private readonly fullscreenButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly host: HTMLElement;
  private readonly preview: HTMLElement;
  private readonly markdown: boolean;
  private view: EditorView | null = null;
  private savedDocument: Text | null = null;
  private savingDocument: Text | null = null;
  private dirty = false;
  private saving = false;
  private previewing = false;
  private disposed = false;
  /** 全屏只是同一个容器的 class 切换，绝不重建 CodeMirror（保住 undo 栈与光标）。 */
  private fullscreen = false;
  /** 自动保存状态机随编辑器一起按需加载，不进入首屏 chunk。 */
  private readonly autosave: AutosaveController;
  private autosavePhase: AutosavePhase = 'idle';
  /** 载入远端版本时抑制自动保存计时，否则会立刻把刚读到的内容再存回去。 */
  private applyingRemote = false;
  /** 一次性状态：'saved' 或保存失败消息；内容变化后清空。 */
  private statusOverride: { saved: true } | { error: string } | null = null;
  /** 打开编辑器前的焦点元素；关闭后还给它（对话框不是新页面）。 */
  private readonly returnFocus: HTMLElement | null;

  private constructor(options: FileEditorOptions, file: EditorDocument) {
    this.options = options;
    this.file = file;
    this.markdown = isMarkdownFile(file.name);
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.autosave = new AutosaveController({
      save: () => this.runAutoSave(),
      delayMs: () => editorAutosaveDelay(this.view?.state.doc.length ?? 0),
      minIntervalMs: () => editorAutosaveInterval(this.view?.state.doc.length ?? 0),
      onPhaseChange: (phase) => {
        this.autosavePhase = phase;
        this.renderAutosave();
      },
    });
    this.element = document.createElement('div');
    this.element.className = 'file-editor';
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-modal', 'true');
    this.element.tabIndex = -1;
    this.element.innerHTML = `
      <header class="file-editor-header">
        <div class="file-editor-heading">
          <span class="file-editor-title" id="file-editor-title"></span>
          <span class="file-editor-path"></span>
        </div>
        <div class="file-editor-actions">
          <span class="file-editor-autosave" role="status" aria-live="polite" data-state="idle" hidden></span>
          <span class="file-editor-state" role="status" aria-live="polite"></span>
          <button class="file-editor-button" type="button" data-action="preview" hidden></button>
          <button class="file-editor-button" type="button" data-action="fullscreen" aria-pressed="false"></button>
          <button class="file-editor-button primary" type="button" data-action="save"></button>
          <button class="file-editor-button icon" type="button" data-action="close"></button>
        </div>
      </header>
      <div class="file-editor-body">
        <div class="file-editor-host"></div>
        <div class="file-editor-preview" hidden></div>
      </div>`;
    this.title = this.element.querySelector('.file-editor-title')!;
    this.pathLabel = this.element.querySelector('.file-editor-path')!;
    this.stateLabel = this.element.querySelector('.file-editor-state')!;
    this.autosaveLabel = this.element.querySelector('.file-editor-autosave')!;
    this.saveButton = this.element.querySelector('[data-action="save"]')!;
    this.previewButton = this.element.querySelector('[data-action="preview"]')!;
    this.fullscreenButton = this.element.querySelector('[data-action="fullscreen"]')!;
    this.closeButton = this.element.querySelector('[data-action="close"]')!;
    this.host = this.element.querySelector('.file-editor-host')!;
    this.preview = this.element.querySelector('.file-editor-preview')!;
    this.title.textContent = file.name;
    this.pathLabel.textContent = file.path;
    this.pathLabel.title = file.path;
    this.element.setAttribute('aria-labelledby', this.title.id);
    this.previewButton.hidden = !this.markdown;
    this.previewButton.addEventListener('click', () => void this.togglePreview());
    this.fullscreenButton.addEventListener('click', () => this.toggleFullscreen());
    this.saveButton.addEventListener('click', () => this.requestSave());
    this.closeButton.addEventListener('click', () => this.options.requestClose());
    // 冒泡阶段监听：让 CodeMirror 先处理它自己的按键（搜索面板的 Esc、Tab 缩进），
    // 我们再决定要不要继续冒泡到 document。
    this.element.addEventListener('keydown', (event) => this.handleKeydown(event));
    this.setLanguage();
  }

  private async mount(): Promise<void> {
    // 保留远端文件原本的换行风格，避免「打开再保存」把 CRLF 改成 LF。
    const separator = this.file.content.includes('\r\n')
      ? '\r\n'
      : this.file.content.includes('\r')
        ? '\r'
        : null;
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      syntaxHighlighting(highlightStyle),
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => { this.requestSave(); return true; } },
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      theme,
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || this.applyingRemote) return;
        this.dirty = update.state.doc !== this.savedDocument;
        if (update.transactions.some((transaction) => transaction.isUserEvent('undo') || transaction.isUserEvent('redo'))) {
          this.dirty = !this.savedDocument?.eq(update.state.doc);
        }
        this.statusOverride = null;
        // 停止输入 3 秒后自动保存；保存期间的输入由状态机合并。
        this.autosave.schedule();
        this.renderState();
      }),
    ];
    if (separator) extensions.push(EditorState.lineSeparator.of(separator));
    try {
      extensions.push(await languageSupport(this.file.name));
    } catch {
      // 语言包加载失败不阻塞编辑，退化为纯文本。
      this.statusOverride = { error: this.options.localize({ zh: '语法高亮不可用，以纯文本打开。', en: 'Syntax highlighting unavailable; opened as plain text.' }) };
    }
    if (this.disposed) return;
    this.view = new EditorView({
      state: EditorState.create({ doc: this.file.content, extensions }),
      parent: this.host,
    });
    this.savedDocument = this.view.state.doc;
    this.renderState();
  }

  /** 当前编辑区内容与最后一次保存内容不一致。 */
  isDirty(): boolean {
    return this.dirty;
  }

  content(): string {
    return this.view?.state.sliceDoc() ?? this.file.content;
  }

  isSaving(): boolean {
    return this.saving;
  }

  focus(): void {
    this.view?.focus();
  }

  markSaving(): void {
    this.savingDocument = this.view?.state.doc ?? null;
    this.saving = true;
    this.statusOverride = null;
    this.autosave.beginSaving();
    this.renderState();
  }

  markSaved(content: string, mtime: number | null): void {
    this.saving = false;
    this.savedDocument = this.savingDocument;
    this.savingDocument = null;
    this.dirty = this.view !== null && !this.savedDocument?.eq(this.view.state.doc);
    if (mtime !== null) this.file.mtime = mtime;
    // 保存期间又有输入时不能显示「已保存」，等合并的那次保存完成。
    this.statusOverride = this.isDirty() ? null : { saved: true };
    // 成功即恢复自动保存（含强制覆盖后解除暂停）；有合并输入会再排一次。
    if (mtime === null) this.autosave.pause();
    else this.autosave.succeed();
    this.renderState();
  }

  setFullscreen(fullscreen: boolean): void {
    if (this.disposed || this.fullscreen === fullscreen) return;
    this.fullscreen = fullscreen;
    this.element.classList.toggle('is-fullscreen', fullscreen);
    this.setLanguage();
    this.view?.requestMeasure();
    this.focus();
  }

  toggleFullscreen(): void {
    this.setFullscreen(!this.fullscreen);
  }

  /**
   * 保存失败。默认停止自动保存；冲突场景由 `keepPaused` 保住暂停态，
   * 直到用户强制覆盖成功或重新载入远端版本。
   */
  markSaveFailed(message: string, keepPaused = false): void {
    this.saving = false;
    this.statusOverride = { error: message };
    if (keepPaused) this.autosave.pause();
    else this.autosave.fail(false);
    this.renderState();
  }

  /** 远端 mtime 冲突：暂停自动保存，绝不静默覆盖。 */
  pauseAutosave(): void {
    this.autosave.pause();
  }

  isAutosavePaused(): boolean {
    return this.autosave.current === 'paused';
  }

  cancelAutosave(): void {
    this.autosave.cancel();
  }

  /** 冲突后「以远端为准」：整篇换成远端内容，并把它作为新的保存基准。 */
  applyRemoteContent(content: string, mtime: number): void {
    if (this.disposed || !this.view) return;
    this.applyingRemote = true;
    try {
      this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: content } });
    } finally {
      this.applyingRemote = false;
    }
    this.savedDocument = this.view.state.doc;
    this.savingDocument = null;
    this.dirty = false;
    this.file.mtime = mtime;
    this.saving = false;
    this.statusOverride = null;
    this.autosave.cancel();
    this.renderState();
  }

  setLanguage(): void {
    const copy = this.copy();
    this.saveButton.textContent = copy.save;
    this.saveButton.title = copy.saveShortcut;
    this.saveButton.setAttribute('aria-label', copy.saveShortcut);
    this.previewButton.textContent = this.previewing ? copy.source : copy.preview;
    const fullscreenLabel = this.fullscreen ? copy.exitFullscreen : copy.fullscreen;
    this.fullscreenButton.textContent = fullscreenLabel;
    this.fullscreenButton.title = fullscreenLabel;
    this.fullscreenButton.setAttribute('aria-label', fullscreenLabel);
    this.fullscreenButton.setAttribute('aria-pressed', String(this.fullscreen));
    this.closeButton.textContent = '✕';
    this.closeButton.setAttribute('aria-label', copy.close);
    this.closeButton.title = copy.close;
    this.element.setAttribute('aria-label', copy.dialog);
    this.renderAutosave();
    this.renderState();
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.autosave.cancel();
    this.view?.destroy();
    this.view = null;
    this.element.remove();
    this.restoreFocus();
  }

  /** 把焦点还给打开编辑器前的元素；它已被移除 / 禁用 / 锁在 inert 里时放弃。 */
  private restoreFocus(): void {
    const target = this.returnFocus;
    if (!target || !target.isConnected || target.closest('[inert]')) return;
    if ('disabled' in target && (target as { disabled: boolean }).disabled) return;
    // 用户已经把焦点移到别处（例如点了别的控件）时不抢回来。
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    target.focus();
  }

  private copy(): EditorCopy {
    const localized = {} as EditorCopy;
    for (const key of Object.keys(COPY) as Array<keyof EditorCopy>) {
      localized[key] = this.options.localize(COPY[key]);
    }
    return localized;
  }

  private renderState(): void {
    if (this.disposed) return;
    const copy = this.copy();
    const dirty = this.isDirty();
    this.element.classList.toggle('is-dirty', dirty);
    if (this.saving) setLiveText(this.stateLabel, copy.saving);
    else if (this.statusOverride && 'saved' in this.statusOverride) setLiveText(this.stateLabel, dirty ? copy.dirty : copy.saved);
    else if (this.statusOverride) setLiveText(this.stateLabel, this.statusOverride.error);
    else if (this.previewing) setLiveText(this.stateLabel, copy.previewing);
    else if (dirty) setLiveText(this.stateLabel, copy.dirty);
    else setLiveText(this.stateLabel, copy.clean);
    this.saveButton.disabled = this.saving || !dirty;
    this.saveButton.textContent = copy.save;
    this.previewButton.textContent = this.previewing ? copy.source : copy.preview;
  }

  private renderAutosave(): void {
    const phase = this.autosavePhase;
    this.element.dataset.autosave = phase;
    this.autosaveLabel.dataset.state = phase;
    this.autosaveLabel.hidden = phase === 'idle';
    if (phase === 'idle') {
      setLiveText(this.autosaveLabel, '');
      return;
    }
    const copy = this.copy();
    setLiveText(this.autosaveLabel, phase === 'paused'
      ? copy.autosavePaused
      : phase === 'saving' ? copy.autosaveSaving : copy.autosavePending);
  }

  private reconcileDirty(): boolean {
    if (this.view && this.savedDocument) this.dirty = !this.savedDocument.eq(this.view.state.doc);
    this.renderState();
    return this.dirty;
  }

  private requestSave(): void {
    if (this.disposed || this.saving || !this.view) return;
    if (!this.reconcileDirty()) return;
    this.options.requestSave(this.content(), 'manual');
  }

  /** 防抖到点：内容没变就回到 idle，通道忙则稍后重试。 */
  private runAutoSave(): void {
    if (this.disposed || !this.view) {
      this.autosave.cancel();
      return;
    }
    if (!this.reconcileDirty()) {
      this.autosave.succeed();
      return;
    }
    if (this.saving) {
      this.autosave.defer();
      return;
    }
    const result = this.options.requestSave(this.content(), 'auto');
    if (result === 'retry') this.autosave.defer();
  }

  private async togglePreview(): Promise<void> {
    if (this.disposed || !this.markdown || !this.view) return;
    if (this.previewing) {
      this.previewing = false;
      this.preview.hidden = true;
      this.host.hidden = false;
      this.setLanguage();
      this.view.focus();
      return;
    }
    this.previewing = true;
    this.host.hidden = true;
    this.preview.hidden = false;
    // 预览层本身可聚焦：否则点完预览焦点掉到 body，挂在容器上的 Esc / Ctrl+S 收不到。
    this.preview.tabIndex = 0;
    this.preview.focus();
    this.setLanguage();
    this.preview.textContent = this.options.localize({ zh: '正在渲染预览…', en: 'Rendering preview…' });
    try {
      const [{ marked }, purifyModule] = await Promise.all([import('marked'), import('dompurify')]);
      const DOMPurify = purifyModule.default;
      if (!hookedSanitizers.has(DOMPurify)) {
        hookedSanitizers.add(DOMPurify);
        DOMPurify.addHook('afterSanitizeAttributes', (node: Node) => {
          if (!(node instanceof Element)) return;
          if (node.tagName === 'A') {
            node.setAttribute('target', '_blank');
            node.setAttribute('rel', 'noopener noreferrer');
          }
          if (node.tagName === 'IMG') {
            node.setAttribute('loading', 'lazy');
            node.setAttribute('referrerpolicy', 'no-referrer');
          }
        });
      }
      const raw = await marked.parse(this.content());
      const clean = DOMPurify.sanitize(raw, {
        USE_PROFILES: { html: true },
        FORBID_TAGS: ['style', 'form', 'input', 'button', 'select', 'textarea', 'iframe', 'object', 'embed', 'link', 'meta', 'base'],
        FORBID_ATTR: ['style'],
        ALLOW_DATA_ATTR: false,
      });
      if (this.disposed || !this.previewing) return;
      this.preview.innerHTML = clean;
      if (!clean.trim()) this.preview.textContent = this.copy().empty;
    } catch {
      if (this.disposed || !this.previewing) return;
      this.preview.textContent = this.options.localize({ zh: '预览渲染失败。', en: 'Could not render the preview.' });
    }
  }

  private handleKeydown(event: KeyboardEvent): void {
    // CodeMirror 已经消费的按键（搜索面板的 Esc、Tab 缩进等）：这里只阻断冒泡。
    // 否则 Esc 会继续冒到 document 上的处理器，把连接面板一起收起（并设为 inert）。
    if (event.defaultPrevented) {
      if (event.key === 'Escape') event.stopPropagation();
      return;
    }
    const mod = event.ctrlKey || event.metaKey;
    // 预览模式下 CodeMirror 不在焦点上，快捷键要在覆盖层统一拦截。
    if (mod && !event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      this.requestSave();
      return;
    }
    if (mod && !event.altKey && event.shiftKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      event.stopPropagation();
      this.toggleFullscreen();
      return;
    }
    if (event.key === 'Tab') {
      this.trapTab(event);
      return;
    }
    if (event.key !== 'Escape') return;
    // 搜索面板还开着：让 CodeMirror 独占 Esc，别让 document 把连接面板关掉。
    if (this.element.querySelector('.cm-panel.cm-search')) {
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    // 全屏时第一次 Esc 只退出全屏，第二次才走关闭确认。
    if (this.fullscreen) {
      this.setFullscreen(false);
      return;
    }
    this.options.requestClose();
  }

  /** 对话框内 Tab 首尾回绕；CodeMirror 自己的 Tab 缩进已被它先消费，不受影响。 */
  private trapTab(event: KeyboardEvent): void {
    const focusable = this.focusableElements();
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    const outside = !this.element.contains(active);
    if (event.shiftKey && (outside || active === first)) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && (outside || active === last)) {
      event.preventDefault();
      first.focus();
    }
  }

  /** 当前可见、可聚焦的后代元素，按 DOM 顺序。 */
  private focusableElements(): HTMLElement[] {
    const selector = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
    return [...this.element.querySelectorAll<HTMLElement>(selector)]
      .filter((node) => node.getClientRects().length > 0);
  }
}
