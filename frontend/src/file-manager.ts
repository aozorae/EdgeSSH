import type { FileListView } from './file-list-view';
import { TextReadBuffer } from './file-text-buffer';
import { MAX_EDITOR_FILE_SIZE, isEditableTextFile } from './file-language';
import type { EditorDocument, EditorSaveResult, FileEditor } from './file-editor';
import { expectedMtimeFor, nextMtimeBaseline } from './editor-mtime';
// 按主机记住路径的模块在连接成功后才按需加载，首屏不带这段逻辑。
import type { StorageLike } from './file-paths';

export const MAX_SFTP_FILE_SIZE = 64 * 1024 * 1024;
export const SFTP_UPLOAD_CHUNK_SIZE = 64 * 1024;

export interface FileManagerElements {
  panel: HTMLElement;
  path: HTMLInputElement;
  back: HTMLButtonElement;
  up: HTMLButtonElement;
  home: HTMLButtonElement;
  refresh: HTMLButtonElement;
  upload: HTMLButtonElement;
  download: HTMLButtonElement;
  edit: HTMLButtonElement;
  mkdir: HTMLButtonElement;
  rename: HTMLButtonElement;
  delete: HTMLButtonElement;
  uploadInput: HTMLInputElement;
  tableBody: HTMLTableSectionElement;
  loading: HTMLElement;
  empty: HTMLElement;
  error: HTMLElement;
  status: HTMLElement;
  progress: HTMLElement;
  progressLabel: HTMLElement;
  progressBar: HTMLProgressElement;
  progressCancel: HTMLButtonElement;
}

export interface FileManagerOptions {
  elements: FileManagerElements;
  getLanguage?: () => string;
  confirm?: (message: string) => boolean | Promise<boolean>;
  prompt?: (message: string, defaultValue?: string) => string | null | Promise<string | null>;
  onError?: (message: string) => void;
  onStatus?: (message: string) => void;
}

export interface SFTPEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number | string;
  mtime: string | number;
  permissions: string | number;
  uid?: string | number;
  gid?: string | number;
  owner?: string;
  group?: string;
}

/** Listener invoked whenever the FileManager's current working directory changes. */
export type CwdChangeListener = (cwd: string) => void;

interface LocalizedText {
  zh: string;
  en: string;
}

interface PendingRequest {
  generation: number;
  operation: string;
  path: string;
  historyMode?: 'push' | 'none' | 'index';
  historyIndex?: number;
  /** 这是「恢复上次目录」的请求；失败时回落 / 并提示，而不是当普通错误。 */
  restorePath?: boolean;
}

/** 上传来源：本地文件或编辑器里的文本内容。 */
interface UploadSource {
  name: string;
  size: number;
  slice(start: number, end: number): Promise<ArrayBuffer>;
}

interface UploadState {
  generation: number;
  requestId: string;
  source: UploadSource;
  path: string;
  /** 仅在编辑器保存时设置：用于 mtime 冲突校验与保存回调。 */
  expectedMtime?: number | null;
  editorContent?: string;
  /** 这次保存是否由自动保存触发（决定冲突后是「恢复自动保存」还是保留草稿）。 */
  autoSave?: boolean;
  /** 保存结束时回调（关闭 / 断开前的 flush 用它等待结果）。 */
  editorDone?: (completed: boolean) => void;
  sent: number;
  acknowledged: number;
  awaitingAck: boolean;
  endSent: boolean;
  readyForData: boolean;
  cancelling: boolean;
  cancelSent: boolean;
}

interface DownloadState {
  generation: number;
  requestId: string;
  path: string;
  name: string;
  expectedSize: number | null;
  received: number;
  chunks: ArrayBuffer[];
  started: boolean;
  cancelling: boolean;
  cancelSent: boolean;
}

type SocketData = string | ArrayBuffer | ArrayBufferView | Blob;
type JsonRecord = Record<string, unknown>;
type FilePathsModule = typeof import('./file-paths');

const DISCONNECTED: LocalizedText = {
  zh: '连接 SSH 后即可管理文件',
  en: 'Connect to SSH to manage files',
};

const DISCONNECTED_CHANNEL: LocalizedText = {
  zh: '文件管理连接已断开',
  en: 'File management connection lost',
};

const EDITOR_LEAVE_COPY: LocalizedText = {
  zh: '编辑器中有未保存的修改，继续将丢失这些修改。仍要继续吗？',
  en: 'The editor has unsaved changes. Continue and lose them?',
};

// Auto-reconnect for the file manager after an unexpected drop.
const RECONNECT_MAX_ATTEMPTS = 3;
const RECONNECT_DELAYS: readonly number[] = [1000, 2000, 4000];

function requiredElement<T extends Element>(root: ParentNode, id: string): T {
  const node = root.querySelector<T>(`#${id}`);
  if (!node) throw new Error(`Missing file manager element #${id}`);
  return node;
}

export function collectFileManagerElements(root: ParentNode = document): FileManagerElements {
  return {
    panel: requiredElement(root, 'file-manager-panel'),
    path: requiredElement(root, 'file-manager-path'),
    back: requiredElement(root, 'file-back'),
    up: requiredElement(root, 'file-up'),
    home: requiredElement(root, 'file-home'),
    refresh: requiredElement(root, 'file-refresh'),
    upload: requiredElement(root, 'file-upload'),
    download: requiredElement(root, 'file-download'),
    edit: requiredElement(root, 'file-edit'),
    mkdir: requiredElement(root, 'file-mkdir'),
    rename: requiredElement(root, 'file-rename'),
    delete: requiredElement(root, 'file-delete'),
    uploadInput: requiredElement(root, 'file-upload-input'),
    tableBody: requiredElement(root, 'file-table-body'),
    loading: requiredElement(root, 'file-manager-loading'),
    empty: requiredElement(root, 'file-manager-empty'),
    error: requiredElement(root, 'file-manager-error'),
    status: requiredElement(root, 'file-manager-status'),
    progress: requiredElement(root, 'file-manager-progress'),
    progressLabel: requiredElement(root, 'file-manager-progress-label'),
    progressBar: requiredElement(root, 'file-manager-progress-bar'),
    progressCancel: requiredElement(root, 'file-manager-progress-cancel'),
  };
}

function normalizePath(input: string): string {
  if (typeof input !== 'string' || input.length === 0 || new TextEncoder().encode(input).length > 4096) throw new Error('Invalid path');
  if (!input.startsWith('/') || /[\0-\x1f\x7f]/.test(input)) throw new Error('Invalid path');
  return input;
}

function validateName(input: string): string {
  const name = input;
  if (!name || name === '.' || name === '..' || name.length > 255 || name.includes('/') || /[\0-\x1f\x7f]/.test(name)) {
    throw new Error('Invalid file name');
  }
  return name;
}

function joinPath(parent: string, name: string): string {
  return normalizePath(`${parent.endsWith('/') ? parent : `${parent}/`}${validateName(name)}`);
}

function parentPath(path: string): string {
  let normalized = normalizePath(path);
  while (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  if (normalized === '/') return '/';
  return normalized.slice(0, normalized.lastIndexOf('/')) || '/';
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** localStorage 在隐私模式 / 被禁用时可能直接抛错，这里统一降级为「不记录」。 */
function resolvePathStorage(): Pick<StorageLike, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function fileSizeValue(value: unknown): number | string | null {
  const numeric = numberValue(value);
  if (numeric !== null) return numeric;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  return value.replace(/^0+(?=\d)/, '');
}

function sizeExceedsLimit(value: number | string): boolean {
  if (typeof value === 'number') return value > MAX_SFTP_FILE_SIZE;
  const limit = String(MAX_SFTP_FILE_SIZE);
  return value.length > limit.length || (value.length === limit.length && value > limit);
}

function transferSize(value: unknown): number | null {
  const size = fileSizeValue(value);
  if (size === null || sizeExceedsLimit(size)) return null;
  return typeof size === 'number' ? size : Number(size);
}

export class FileManager {
  private readonly elements: FileManagerElements;
  private readonly getLanguage: () => string;
  private readonly confirmAction: NonNullable<FileManagerOptions['confirm']>;
  private readonly promptAction: NonNullable<FileManagerOptions['prompt']>;
  private readonly onError?: FileManagerOptions['onError'];
  private readonly onStatus?: FileManagerOptions['onStatus'];
  private readonly bindings = new AbortController();

  private socket: WebSocket | null = null;
  private generation = 0;
  private requestSequence = 0;
  private ready = false;
  private cwd = '/';
  private homePath = '/';
  private history = ['/'];
  private historyIndex = 0;
  private entries: SFTPEntry[] = [];
  private selectedIndex = -1;
  private listView: FileListView | null = null;
  private pending = new Map<string, PendingRequest>();
  private activeListRequest: string | null = null;
  private uploadState: UploadState | null = null;
  private downloadState: DownloadState | null = null;
  /** 当前打开的在线编辑器（按需动态加载）。 */
  private editor: FileEditor | null = null;
  private textRead: TextReadBuffer | null = null;
  /** 编辑器对应的远端文档元数据：path + 打开时的 mtime。 */
  private editorDocument: EditorDocument | null = null;
  /** 正在读取的文本文件请求；与 pending 里的 readText 对应。 */
  private editorRequest: { requestId: string; path: string; name: string } | null = null;
  /** 冲突后「以远端为准」的读取请求。 */
  private reloadRequest: { requestId: string; path: string } | null = null;
  /** 正在进行的编辑器保存；关闭 / 断开前的 flush 用它等待结果。 */
  private activeEditorSave: { promise: Promise<boolean>; resolve: (completed: boolean) => void } | null = null;
  /** 当前主机 id；临时连接没有 id，不写 localStorage。 */
  private hostId: string | null = null;
  private readonly pathStorage: Pick<StorageLike, 'getItem' | 'setItem'> | null;
  private paths: FilePathsModule | null = null;
  private pathsLoading: Promise<FilePathsModule | null> | null = null;
  /** 恢复上次目录失败后，等回落列表返回时展示的提示。 */
  private listNotice: LocalizedText | null = null;
  /** 冲突确认框正开着：关闭 / 断开不要在同一次交互里再弹第二个确认。 */
  private conflictPending = false;
  private disconnectPreparation: Promise<boolean> | null = null;
  private uploadConfirmationPending = false;
  private messageQueue: Promise<void> = Promise.resolve();
  private statusCopy: LocalizedText = DISCONNECTED;
  /** Auto-reconnect state: true while the SSH session is alive and we want a file channel. */
  private wantConnection = false;
  /** Last attach URL, saved for reconnection. */
  private url: string | null = null;
  /** Pending reconnect timer id, null when idle. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Current reconnect attempt count (0 = no attempt). */
  private reconnectAttempts = 0;
  /** Pending tree-view directory fetch promises, keyed by `tree-` prefixed requestId. */
  private treeLists = new Map<string, {
    resolve: (value: { path: string; entries: SFTPEntry[]; isTruncated: boolean }) => void;
    reject: (error: Error) => void;
    generation: number;
  }>();
  /** Registered cwd-change listeners, notified on every successful cwd mutation. */
  private cwdListeners = new Set<CwdChangeListener>();

  constructor(options: FileManagerOptions) {
    this.elements = options.elements;
    this.getLanguage = options.getLanguage ?? (() => document.documentElement.lang || 'zh-CN');
    this.confirmAction = options.confirm ?? ((message) => window.confirm(message));
    this.promptAction = options.prompt ?? ((message, value) => window.prompt(message, value));
    this.onError = options.onError;
    this.onStatus = options.onStatus;
    this.pathStorage = resolvePathStorage();
    this.bindControls();
    this.renderDisconnected();
  }

  attach(url: string): void {
    this.clearReconnectTimer();
    // 自动重连沿用同一个页面状态：编辑器里的草稿不能因为一次断线就被丢掉。
    this.resetConnection(true);
    this.wantConnection = true;
    this.url = url;
    let target: URL;
    try {
      target = new URL(url, window.location.href);
      if (target.protocol === 'http:') target.protocol = 'ws:';
      if (target.protocol === 'https:') target.protocol = 'wss:';
      const expectedProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      if (target.host !== window.location.host || target.protocol !== expectedProtocol || target.username || target.password) {
        throw new Error('SFTP WebSocket must use the current origin');
      }
      target.hash = '';
    } catch (error) {
      this.showError(this.localize({ zh: '文件传输地址无效。', en: 'The file transfer address is invalid.' }));
      throw error;
    }

    const generation = this.generation;
    const socket = new WebSocket(target);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    this.setStatus({ zh: '正在连接文件服务…', en: 'Connecting to file service…' });

    socket.addEventListener('open', () => {
      if (!this.isCurrent(socket, generation)) return;
      if (this.reconnectAttempts > 0) {
        console.log(
          `[WS-Reconnect] ${new Date().toISOString()} | SFTP | reconnect_success | attempt=${this.reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS}`,
        );
      }
      this.reconnectAttempts = 0;
      this.init();
    });
    socket.addEventListener('message', (event: MessageEvent<SocketData>) => {
      this.messageQueue = this.messageQueue
        .then(() => this.handleSocketData(event.data, generation))
        .catch((error: unknown) => this.showError(error instanceof Error ? error.message : String(error)));
    });
    socket.addEventListener('error', () => {
      if (this.isCurrent(socket, generation)) {
        this.showError(this.localize({ zh: '文件服务连接失败。', en: 'The file service connection failed.' }));
      }
    });
    socket.addEventListener('close', (event: CloseEvent) => {
      if (!this.isCurrent(socket, generation)) return;
      console.log(
        `[WS-Reconnect] ${new Date().toISOString()} | SFTP | disconnect | code=${event.code} | reason="${event.reason}"`,
      );
      this.socket = null;
      this.ready = false;
      this.abortTransfers(false);
      this.pending.clear();
      this.editorRequest = null;
      this.reloadRequest = null;
      this.textRead = null;
      this.activeListRequest = null;
      this.rejectTreeLists(new Error('SFTP connection closed'));
      if (event.code !== 1000 && event.code !== 1005) {
        // Unexpected drop. Auto-reconnect unless the user intentionally tore the session down.
        if (this.wantConnection) {
          this.scheduleReconnect();
        } else {
          this.renderDisconnected(true, this.describeClose(event));
        }
      } else {
        this.renderDisconnected(true, this.describeClose(event));
      }
    });
  }

  init(): void {
    if (!this.isSocketOpen()) return;
    this.send({ type: 'sftp_init' });
    this.setStatus({ zh: '正在初始化 SFTP…', en: 'Initializing SFTP…' });
  }

  reset(): void {
    this.resetConnection(false);
  }

  /** 页面即将卸载时用：编辑器里还有没保存（且可能还在 3 秒防抖窗口内）的改动。 */
  hasUnsavedEditorChanges(): boolean {
    return this.editor?.isDirty() === true || this.editor?.isSaving() === true;
  }

  private resetConnection(preserveEditor: boolean): void {
    this.wantConnection = false;
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;
    this.generation++;
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    this.uploadConfirmationPending = false;
    this.pending.clear();
    this.activeListRequest = null;
    this.rejectTreeLists(new Error('SFTP session reset'));
    this.abortTransfers(false);
    if (socket) {
      if (socket.readyState === WebSocket.OPEN) {
        try { socket.send(JSON.stringify({ type: 'sftp_close' })); } catch { /* Socket is already unusable. */ }
      }
      if (socket.readyState < WebSocket.CLOSING) socket.close(1000, 'SFTP client reset');
    }
    this.cwd = '/';
    this.homePath = '/';
    this.history = ['/'];
    this.historyIndex = 0;
    this.entries = [];
    this.selectedIndex = -1;
    this.editorRequest = null;
    this.reloadRequest = null;
    this.textRead = null;
    if (preserveEditor) this.editor?.cancelAutosave();
    if (!preserveEditor) this.closeEditor();
    this.renderDisconnected();
  }

  destroy(): void {
    this.reset();
    this.cwdListeners.clear();
    this.bindings.abort();
  }

  list(path = this.cwd): string | null {
    return this.requestList(path, 'push');
  }

  navigate(path: string): void {
    let normalized: string;
    try {
      normalized = normalizePath(path);
    } catch {
      this.showError(this.localize({ zh: '请输入有效的绝对路径。', en: 'Enter a valid absolute path.' }));
      return;
    }
    void this.navigateGuarded(normalized, 'push');
  }

  back(): void {
    if (!this.ready || this.historyIndex <= 0) return;
    void this.navigateGuarded(this.history[this.historyIndex - 1], 'index', this.historyIndex - 1);
  }

  up(): void {
    if (this.ready) void this.navigateGuarded(parentPath(this.cwd), 'push');
  }

  home(): void {
    if (this.ready) void this.navigateGuarded(this.homePath, 'push');
  }

  /** 切目录前先确认编辑器里的未保存改动。 */
  private async navigateGuarded(
    path: string,
    historyMode: PendingRequest['historyMode'],
    historyIndex?: number,
  ): Promise<void> {
    if (!(await this.confirmEditorDiscard())) return;
    if (!this.ready) return;
    this.requestList(path, historyMode, historyIndex);
  }

  private async confirmEditorDiscard(): Promise<boolean> {
    if (!this.editor?.isDirty()) return true;
    const answer = this.confirmAction(this.localize(EDITOR_LEAVE_COPY));
    return typeof answer === 'boolean' ? answer : await answer;
  }

  refresh(): void {
    if (this.ready) this.requestList(this.cwd, 'none');
  }

  setLanguage(): void {
    this.updateStatusText(this.statusCopy);
    this.renderEntries();
    this.updateProgressLanguage();
    this.editor?.setLanguage();
    this.updateControls();
  }

  /** 未保存的编辑器内容会阻止切目录 / 断开连接；供 FilePage 与导航共用。 */
  confirmEditorLeave(): boolean {
    if (!this.editor?.isDirty()) return true;
    // confirmAction 默认是同步的 window.confirm；异步实现无法阻塞同步导航，按「停留」处理以避免丢改动。
    return this.confirmAction(this.localize(EDITOR_LEAVE_COPY)) === true;
  }

  setListView(view: FileListView | null): void {
    this.listView = view;
    this.renderEntries();
  }

  /** 由连接层告知当前主机 id；只有带 id 的连接才会记住路径。 */
  setHostId(hostId: string | null): void {
    this.hostId = hostId;
  }

  selectEntry(index: number): void {
    this.selectedIndex = this.entries[index] ? index : -1;
    this.updateControls();
  }

  activateIndex(index: number): void {
    this.selectEntry(index);
    this.activateEntry(this.selectedEntry());
  }

  /**
   * Fetch directory entries for the tree view **without** disturbing the
   * right-side panel (cwd, history, activeListRequest, or rendered entries).
   * Uses a `tree-` prefixed requestId so handleListResult / handleServerError
   * route the response to the tree channel instead of the normal list flow.
   */
  fetchDirectoryEntries(path: string): Promise<{ path: string; entries: SFTPEntry[]; isTruncated: boolean }> {
    if (!this.ready || !this.isSocketOpen()) {
      return Promise.reject(new Error(this.localize({ zh: 'SFTP 尚未就绪。', en: 'SFTP is not ready.' })));
    }
    let normalized: string;
    try {
      normalized = normalizePath(path);
    } catch {
      return Promise.reject(new Error(this.localize({ zh: '路径无效。', en: 'Invalid path.' })));
    }
    const requestId = `tree-${this.generation}-${++this.requestSequence}`;
    return new Promise((resolve, reject) => {
      this.treeLists.set(requestId, { resolve, reject, generation: this.generation });
      this.send({ type: 'sftp_list', requestId, path: normalized });
    });
  }

  /**
   * Register a listener that fires whenever the current working directory
   * changes (after a successful list navigation or sftp_ready). Returns an
   * unsubscribe function.
   */
  onCwdChange(listener: CwdChangeListener): () => void {
    this.cwdListeners.add(listener);
    return () => { this.cwdListeners.delete(listener); };
  }

  async upload(file: File, destination?: string): Promise<void> {
    if (!this.ready || this.hasTransfer() || this.uploadConfirmationPending) return;
    if (file.size > MAX_SFTP_FILE_SIZE) {
      this.showError(this.localize({ zh: '文件不能超过 64 MiB。', en: 'Files cannot exceed 64 MiB.' }));
      return;
    }
    let path: string;
    try { path = normalizePath(destination ?? joinPath(this.cwd, file.name)); } catch {
      this.showError(this.localize({ zh: '上传文件名无效。', en: 'The upload file name is invalid.' }));
      return;
    }
    const existing = this.entries.find((entry) => joinPath(this.cwd, entry.name) === path);
    const generation = this.generation;
    let overwrite = false;
    if (existing) {
      this.uploadConfirmationPending = true;
      this.updateControls();
      try {
        overwrite = await this.confirmAction(this.localize({
          zh: `“${existing.name}”已存在。是否覆盖？此操作无法撤销。`,
          en: `“${existing.name}” already exists. Overwrite it? This cannot be undone.`,
        }));
      } catch {
        if (generation === this.generation) {
          this.showError(this.localize({ zh: '无法确认是否覆盖文件。', en: 'Could not confirm whether to overwrite the file.' }));
        }
        return;
      } finally {
        if (generation === this.generation) {
          this.uploadConfirmationPending = false;
          this.updateControls();
        }
      }
      if (!overwrite) return;
    }
    if (generation !== this.generation || !this.ready || this.hasTransfer() || !this.isSocketOpen()) return;
    const requestId = this.createRequest('upload', path);
    this.uploadState = {
      generation: this.generation,
      requestId,
      source: { name: file.name, size: file.size, slice: (start, end) => file.slice(start, end).arrayBuffer() },
      path,
      sent: 0,
      acknowledged: 0,
      awaitingAck: false,
      endSent: false,
      readyForData: false,
      cancelling: false,
      cancelSent: false,
    };
    this.showProgress('upload', file.name, 0);
    this.send({ type: 'sftp_upload_start', requestId, path, size: file.size, overwrite });
    this.updateControls();
  }

  downloadSelected(): void {
    const entry = this.selectedEntry();
    if (!this.ready || !entry || entry.type !== 'file' || this.hasTransfer()) return;
    if (sizeExceedsLimit(entry.size)) {
      this.showError(this.localize({ zh: '文件不能超过 64 MiB。', en: 'Files cannot exceed 64 MiB.' }));
      return;
    }
    const path = joinPath(this.cwd, entry.name);
    const requestId = this.createRequest('download', path);
    this.downloadState = {
      generation: this.generation,
      requestId,
      path,
      name: entry.name,
      expectedSize: transferSize(entry.size),
      received: 0,
      chunks: [],
      started: false,
      cancelling: false,
      cancelSent: false,
    };
    this.showProgress('download', entry.name, 0);
    this.send({ type: 'sftp_download', requestId, path });
    this.updateControls();
  }

  cancelTransfer(): void {
    this.requestTransferCancel();
  }

  /** 文本白名单 + ≤ 2 MiB 才允许在线编辑；二进制 / 超限仍走下载。 */
  private canEdit(entry: SFTPEntry): boolean {
    if (entry.type !== 'file' || !isEditableTextFile(entry.name)) return false;
    const size = transferSize(entry.size);
    return size !== null && size <= MAX_EDITOR_FILE_SIZE;
  }

  private editHint(entry: SFTPEntry | null): string {
    if (!entry || entry.type !== 'file') {
      return this.localize({ zh: '仅文本文件支持在线编辑', en: 'Only text files can be edited online' });
    }
    if (!isEditableTextFile(entry.name)) {
      return this.localize({ zh: '该类型不支持在线编辑，请下载后查看', en: 'This file type cannot be edited online; download it instead' });
    }
    return this.localize({ zh: '文件超过 2 MiB，无法在线编辑', en: 'Files larger than 2 MiB cannot be edited online' });
  }

  private editSelected(): void {
    const entry = this.selectedEntry();
    if (!entry) return;
    if (!this.canEdit(entry)) {
      this.showError(this.editHint(entry));
      return;
    }
    void this.openEditor(entry);
  }

  private async openEditor(entry: SFTPEntry): Promise<void> {
    if (!this.ready || this.hasTransfer() || this.editorRequest || this.editor) return;
    if (!this.isSocketOpen()) return;
    let path: string;
    try {
      path = joinPath(this.cwd, entry.name);
    } catch {
      this.showError(this.localize({ zh: '文件名无效。', en: 'The file name is invalid.' }));
      return;
    }
    this.elements.error.hidden = true;
    const requestId = this.createRequest('readText', path);
    this.editorRequest = { requestId, path, name: entry.name };
    this.setStatus({ zh: `正在读取 ${entry.name}`, en: `Opening ${entry.name}` });
    this.updateControls();
    this.send({ type: 'sftp_read_text', requestId, path });
  }

  private async handleReadTextResult(message: JsonRecord): Promise<void> {
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    const request = this.editorRequest;
    if (!request || request.requestId !== requestId) return;
    try {
      this.pending.delete(requestId);
      const generation = this.generation;
      let path: string;
      try {
        path = normalizePath(typeof message.path === 'string' ? message.path : request.path);
      } catch {
        path = request.path;
      }
      const content = message.content;
      const size = numberValue(message.size);
      const mtime = numberValue(message.mtime);
      if (typeof content !== 'string' || size === null) {
        this.showError(this.localize({ zh: '文件服务返回了无法识别的文本内容。', en: 'The file service returned unreadable text content.' }));
        this.updateControls();
        return;
      }
      if (size > MAX_EDITOR_FILE_SIZE) {
        this.showError(this.localize({ zh: '文件超过 2 MiB，无法在线编辑。', en: 'Files larger than 2 MiB cannot be edited online.' }));
        this.updateControls();
        return;
      }
      let module: typeof import('./file-editor');
      try {
        module = await import('./file-editor');
      } catch {
        this.showError(this.localize({ zh: '编辑器组件加载失败，请刷新页面重试。', en: 'The editor failed to load. Refresh the page and try again.' }));
        this.updateControls();
        return;
      }
      if (generation !== this.generation || !this.ready || this.editorRequest !== request) return;
      const document: EditorDocument = {
        path,
        name: request.name,
        content,
        mtime: nextMtimeBaseline(mtime),
      };
      let editor: FileEditor;
      try {
        editor = await module.FileEditor.create({
          localize: (copy) => this.localize(copy),
          requestClose: () => void this.requestCloseEditor(),
          requestSave: (value, origin) => this.saveEditor(value, undefined, origin),
        }, document);
      } catch {
        this.showError(this.localize({ zh: '编辑器初始化失败。', en: 'The editor could not be initialized.' }));
        this.updateControls();
        return;
      }
      if (generation !== this.generation || this.editorRequest !== request) {
        editor.destroy();
        return;
      }
      this.editor = editor;
      if (mtime === null) editor.pauseAutosave();
      this.editorDocument = document;
      this.elements.panel.append(editor.element);
      editor.focus();
      this.setStatus({ zh: `正在编辑 ${request.name}`, en: `Editing ${request.name}` });
      this.updateControls();
    } finally {
      if (this.editorRequest === request) this.editorRequest = null;
      this.updateControls();
    }
  }

  /**
   * 编辑器保存：复用上传通道（临时文件 + rename）。expectedMtime 为打开时的
   * 远端 mtime，null 表示用户已确认强制覆盖。
   */
  private saveEditor(
    content: string,
    expectedMtime?: number | null,
    origin: 'manual' | 'auto' = 'manual',
    done?: (completed: boolean) => void,
  ): EditorSaveResult {
    const editor = this.editor;
    const document = this.editorDocument;
    if (!editor || !document) return 'failed';
    const reject = (message: string): EditorSaveResult => {
      editor.markSaveFailed(message);
      done?.(false);
      return 'failed';
    };
    if (!this.ready || !this.isSocketOpen()) {
      return reject(this.localize({ zh: '保存失败：SFTP 连接已断开。', en: 'Save failed: the SFTP connection is closed.' }));
    }
    if (this.hasTransfer()) {
      // 自动保存遇到其他传输：通道忙，稍后重试；编辑器保存进行中的重复请求交给合并逻辑。
      if (origin === 'auto' || editor.isSaving()) {
        done?.(false);
        return 'retry';
      }
      return reject(this.localize({ zh: '保存失败：已有传输进行中，请稍后再试。', en: 'Save failed: another transfer is in progress. Try again shortly.' }));
    }
    if (expectedMtime === undefined && expectedMtimeFor(document.mtime) === null) {
      editor.pauseAutosave();
      if (origin === 'manual') void this.handleEditorConflict(content, false);
      done?.(false);
      return 'failed';
    }
    const bytes = new TextEncoder().encode(content);
    if (bytes.length > MAX_EDITOR_FILE_SIZE) {
      return reject(this.localize({ zh: '保存失败：内容超过 2 MiB 限制。', en: 'Save failed: the content exceeds the 2 MiB limit.' }));
    }
    // A null version is only allowed after the user explicitly confirms an overwrite.
    const mtimeCheck = expectedMtime === undefined ? expectedMtimeFor(document.mtime) : expectedMtime;
    const requestId = this.createRequest('upload', document.path);
    let resolveSave: (completed: boolean) => void = () => undefined;
    const promise = new Promise<boolean>((resolve) => { resolveSave = resolve; });
    this.activeEditorSave = { promise, resolve: resolveSave };
    this.uploadState = {
      generation: this.generation,
      requestId,
      source: {
        name: document.name,
        size: bytes.length,
        slice: (start, end) => Promise.resolve(bytes.slice(start, end).buffer as ArrayBuffer),
      },
      path: document.path,
      expectedMtime: mtimeCheck,
      editorContent: content,
      autoSave: origin === 'auto',
      editorDone: done,
      sent: 0,
      acknowledged: 0,
      awaitingAck: false,
      endSent: false,
      readyForData: false,
      cancelling: false,
      cancelSent: false,
    };
    this.showProgress('upload', document.name, 0);
    editor.markSaving();
    this.updateControls();
    const start: JsonRecord = { type: 'sftp_upload_start', requestId, path: document.path, size: bytes.length, overwrite: true };
    // Explicit null means a user-approved overwrite, not a missing version.
    start.expectedMtime = mtimeCheck;
    this.send(start);
    return 'started';
  }

  /** 结束一次编辑器保存：唤醒 flush 等待者并回调本次保存的 done。 */
  private completeEditorSave(state: UploadState, completed: boolean): void {
    const active = this.activeEditorSave;
    this.activeEditorSave = null;
    active?.resolve(completed);
    const done = state.editorDone;
    state.editorDone = undefined;
    done?.(completed);
  }

  /**
   * 关闭 / 断开前把未保存内容存掉。返回：
   * - saved：已保存（或本来就没有改动）
   * - paused：自动保存因冲突暂停，交由调用方走现有确认流程
   * - failed：尝试保存但失败（错误已提示），调用方必须阻止关闭 / 断开
   * - unavailable：连接或通道不可用，无法自动保存
   */
  private async flushEditor(): Promise<'saved' | 'paused' | 'failed' | 'unavailable'> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const editor = this.editor;
      if (!editor) return 'saved';
      if (this.activeEditorSave) {
        const completed = await this.activeEditorSave.promise;
        if (!completed) return editor.isAutosavePaused() ? 'paused' : 'failed';
        continue;
      }
      if (!editor.isDirty()) return 'saved';
      if (editor.isAutosavePaused()) return 'paused';
      if (!this.ready || !this.isSocketOpen()) return 'unavailable';
      if (this.hasTransfer()) return 'unavailable';
      const content = editor.content();
      const completed = await new Promise<boolean>((resolve) => {
        if (this.saveEditor(content, undefined, 'manual', resolve) !== 'started') resolve(false);
      });
      if (!completed) return editor.isAutosavePaused() ? 'paused' : 'failed';
    }
    return this.editor?.isDirty() === false ? 'saved' : 'failed';
  }

  /**
   * 断开 / 切换主机前调用：有未保存改动先自动保存。
   * 自动保存因冲突暂停时沿用一期的确认流程；真正保存失败则阻止断开。
   */
  prepareDisconnect(): Promise<boolean> {
    const editor = this.editor;
    if (!editor || (!editor.isDirty() && !editor.isSaving())) return Promise.resolve(true);
    if (this.conflictPending) return Promise.resolve(false);
    // 连点断开按钮时复用同一次保存，避免两次 flush 互相抢通道。
    this.disconnectPreparation ??= this.runPrepareDisconnect().finally(() => {
      this.disconnectPreparation = null;
    });
    return this.disconnectPreparation;
  }

  private async runPrepareDisconnect(): Promise<boolean> {
    const result = await this.flushEditor();
    if (result === 'saved') return true;
    if (result === 'paused' || result === 'unavailable') return this.confirmEditorLeave();
    return false;
  }

  private async requestCloseEditor(): Promise<void> {
    const editor = this.editor;
    if (!editor) return;
    if (!editor.isDirty() && !editor.isSaving()) {
      this.closeEditor();
      return;
    }
    const result = await this.flushEditor();
    if (this.editor !== editor) return;
    if (result === 'saved') {
      this.closeEditor();
      return;
    }
    // 保存失败或冲突确认还没结束：错误通道已提示，保持编辑器打开。
    if (result === 'failed' || (result === 'paused' && this.conflictPending)) return;
    const answer = this.confirmAction(this.localize({
      zh: '编辑器中有未保存的修改，关闭将丢失这些修改。仍要关闭吗？',
      en: 'The editor has unsaved changes. Close and lose them?',
    }));
    const allowed = typeof answer === 'boolean' ? answer : await answer;
    if (allowed) this.closeEditor();
  }

  private closeEditor(): void {
    if (!this.editor) return;
    const editor = this.editor;
    // 关掉编辑器后迟到的「以远端为准」读取不再有意义，连 pending 一起丢掉，
    // 否则它的失败会被当成普通错误弹到已经关闭的页面上。
    if (this.reloadRequest) this.pending.delete(this.reloadRequest.requestId);
    this.reloadRequest = null;
    this.editor = null;
    this.editorDocument = null;
    // 先把「编辑」按钮恢复成可用，destroy() 才把焦点还得到打开编辑器前的元素上。
    this.updateControls();
    editor.destroy();
  }

  /**
   * mtime 冲突：绝不静默覆盖。自动保存触发的冲突会暂停自动保存；
   * 选「放弃我的修改」时自动保存场景改为重新读取远端版本（手动保存保留草稿）。
   */
  private async handleEditorConflict(content: string, fromAutosave: boolean): Promise<void> {
    const editor = this.editor;
    if (!editor) return;
    editor.pauseAutosave();
    this.showError(this.localize({
      zh: '远端文件在你打开之后已被修改，已阻止覆盖。',
      en: 'The remote file changed after you opened it; the save was blocked.',
    }));
    this.conflictPending = true;
    let overwrite = false;
    try {
      const answer = this.confirmAction(this.localize({
        zh: '远端文件在你打开之后已被修改。你是要保留自己的版本（覆盖远端），还是放弃修改、以远端为准？',
        en: 'The remote file changed after you opened it. Keep your version (overwrite the remote), or discard your changes and reload the remote version?',
      }));
      overwrite = typeof answer === 'boolean' ? answer : await answer;
    } finally {
      this.conflictPending = false;
    }
    if (this.editor !== editor) return;
    if (overwrite) {
      this.saveEditor(editor.content(), null, fromAutosave ? 'auto' : 'manual');
      return;
    }
    if (!fromAutosave) {
      // 手动保存取消：保留草稿，自动保存继续暂停（一期行为，避免丢改动）。
      editor.markSaveFailed(this.localize({ zh: '保存已取消：远端版本较新。', en: 'Save cancelled: the remote version is newer.' }), true);
      return;
    }
    this.reloadEditorContent(editor);
  }

  /** 冲突后以远端为准：重新 sftp_read_text，成功后替换正文并恢复自动保存。 */
  private reloadEditorContent(editor: FileEditor): void {
    const document = this.editorDocument;
    if (this.editor !== editor || !document) return;
    if (!this.ready || !this.isSocketOpen() || this.hasTransfer()) {
      editor.markSaveFailed(this.localize({ zh: '无法读取远端版本：连接或传输不可用。', en: 'Could not read the remote version: the connection or transfer is unavailable.' }), true);
      return;
    }
    const requestId = this.createRequest('reloadEditor', document.path);
    this.reloadRequest = { requestId, path: document.path };
    this.send({ type: 'sftp_read_text', requestId, path: document.path });
    this.setStatus({ zh: '正在读取远端版本…', en: 'Reading the remote version…' });
  }

  private handleReloadResult(message: JsonRecord): void {
    const request = this.reloadRequest;
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    if (!request || request.requestId !== requestId) return;
    this.reloadRequest = null;
    this.pending.delete(requestId);
    const editor = this.editor;
    const document = this.editorDocument;
    if (!editor || !document) return;
    const content = message.content;
    const mtime = numberValue(message.mtime);
    if (typeof content !== 'string' || mtime === null) {
      const copy = this.localize({ zh: '文件服务返回了无法识别的文本内容。', en: 'The file service returned unreadable text content.' });
      editor.markSaveFailed(copy, true);
      this.showError(copy);
      return;
    }
    editor.applyRemoteContent(content, mtime);
    document.mtime = mtime;
    this.elements.error.hidden = true;
    this.setStatus({ zh: '已按远端版本重新载入', en: 'Reloaded the remote version' });
    this.updateControls();
  }

  private textErrorCopy(message: JsonRecord): string {
    const reason = message.reason;
    if (reason === 'too-large') {
      return this.localize({ zh: '文件超过 2 MiB，无法在线编辑。', en: 'Files larger than 2 MiB cannot be edited online.' });
    }
    if (reason === 'binary') {
      return this.localize({ zh: '文件包含二进制内容，无法在线编辑。', en: 'This file contains binary data and cannot be edited online.' });
    }
    if (reason === 'encoding') {
      return this.localize({ zh: '文件不是有效的 UTF-8 文本，无法在线编辑。', en: 'This file is not valid UTF-8 text and cannot be edited online.' });
    }
    return typeof message.message === 'string' && message.message
      ? message.message
      : this.localize({ zh: '无法打开该文件。', en: 'The file could not be opened.' });
  }

  async handle(data: SocketData): Promise<void> {
    await this.handleSocketData(data, this.generation);
  }

  private bindControls(): void {
    const signal = this.bindings.signal;
    this.elements.path.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      this.navigate(this.elements.path.value);
    }, { signal });
    this.elements.back.addEventListener('click', () => this.back(), { signal });
    this.elements.up.addEventListener('click', () => this.up(), { signal });
    this.elements.home.addEventListener('click', () => this.home(), { signal });
    this.elements.refresh.addEventListener('click', () => this.refresh(), { signal });
    this.elements.upload.addEventListener('click', () => this.elements.uploadInput.click(), { signal });
    this.elements.uploadInput.addEventListener('change', () => {
      const file = this.elements.uploadInput.files?.[0];
      this.elements.uploadInput.value = '';
      if (file) void this.upload(file);
    }, { signal });
    this.elements.download.addEventListener('click', () => this.downloadSelected(), { signal });
    this.elements.edit.addEventListener('click', () => this.editSelected(), { signal });
    this.elements.progressCancel.addEventListener('click', () => this.cancelTransfer(), { signal });
    this.elements.mkdir.addEventListener('click', () => void this.createDirectory(), { signal });
    this.elements.rename.addEventListener('click', () => void this.renameSelected(), { signal });
    this.elements.delete.addEventListener('click', () => void this.deleteSelected(), { signal });
    this.elements.tableBody.addEventListener('click', (event) => {
      const target = this.rowFromEvent(event);
      if (target) this.selectRow(target, true);
    }, { signal });
    this.elements.tableBody.addEventListener('focusin', (event) => {
      const target = this.rowFromEvent(event);
      if (target) this.selectRow(target, false);
    }, { signal });
    this.elements.tableBody.addEventListener('dblclick', (event) => {
      const target = this.rowFromEvent(event);
      if (!target) return;
      const entry = this.selectRow(target, true);
      this.activateEntry(entry);
    }, { signal });
    this.elements.tableBody.addEventListener('keydown', (event) => {
      const target = this.rowFromEvent(event);
      if (!target) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        this.activateEntry(this.selectRow(target, false));
        return;
      }
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const current = Number(target.dataset.index);
      const next = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? this.entries.length - 1
          : Math.max(0, Math.min(this.entries.length - 1, current + (event.key === 'ArrowUp' ? -1 : 1)));
      const nextRow = this.elements.tableBody.rows.item(next);
      if (nextRow) this.selectRow(nextRow, true);
    }, { signal });
  }

  private async handleSocketData(data: SocketData, generation: number): Promise<void> {
    if (generation !== this.generation) return;
    if (typeof data !== 'string') {
      await this.handleBinary(data, generation);
      return;
    }
    let message: JsonRecord;
    try {
      const parsed: unknown = JSON.parse(data);
      if (!isRecord(parsed)) throw new Error('Invalid SFTP response');
      message = parsed;
    } catch {
      this.showError(this.localize({ zh: '文件服务返回了无效响应。', en: 'The file service returned an invalid response.' }));
      return;
    }
    const type = typeof message.type === 'string' ? message.type : '';
    if (type === 'pong') return;
    if (type === 'sftp_ready') {
      this.handleReady(message);
      return;
    }
    if (type === 'sftp_list_result') {
      this.handleListResult(message);
      return;
    }
    if (type === 'sftp_read_text_start' && typeof message.requestId === 'string') {
      this.textRead = new TextReadBuffer(message.requestId, MAX_EDITOR_FILE_SIZE);
      return;
    }
    if (type === 'sftp_read_text_result') {
      const read = this.textRead;
      if (!read || read.requestId !== message.requestId) return;
      this.textRead = null;
      try { message.content = read.finish(numberValue(message.size)); }
      catch (error) {
        this.handleServerError({ type: 'sftp_error', requestId: message.requestId, message: String(error) });
        return;
      }
      if (this.reloadRequest && message.requestId === this.reloadRequest.requestId) {
        this.handleReloadResult(message);
        return;
      }
      await this.handleReadTextResult(message);
      return;
    }
    if (type === 'sftp_upload_ready') {
      await this.handleUploadReady(message);
      return;
    }
    if (type === 'sftp_upload_progress') {
      await this.handleUploadProgress(message);
      return;
    }
    if (type === 'sftp_upload_complete') {
      this.handleUploadComplete(message);
      return;
    }
    if (type === 'sftp_download_start') {
      this.handleDownloadStart(message);
      return;
    }
    if (type === 'sftp_download_progress') {
      this.handleDownloadProgress(message);
      return;
    }
    if (type === 'sftp_download_done') {
      this.handleDownloadDone(message);
      return;
    }
    if (type === 'sftp_upload_cancelled' || type === 'sftp_download_cancelled') {
      this.handleTransferCancelled(message, type === 'sftp_upload_cancelled' ? 'upload' : 'download');
      return;
    }
    if (type === 'sftp_error') {
      this.handleServerError(message);
      return;
    }
    if (type === 'sftp_closed') {
      this.socket?.close(1000, 'SFTP service closed');
      return;
    }
    if (type.endsWith('_result')) this.handleMutationResult(message);
  }

  private handleReady(message: JsonRecord): void {
    if (this.ready) return;
    let cwd: string;
    try { cwd = normalizePath(typeof message.cwd === 'string' ? message.cwd : '/'); } catch { cwd = '/'; }
    this.ready = true;
    this.cwd = cwd;
    this.emitCwdChange(cwd);
    this.homePath = cwd;
    this.history = [cwd];
    this.historyIndex = 0;
    this.elements.path.value = cwd;
    this.updateControls();
    void this.restoreRememberedDirectory(cwd);
  }

  /** 连上后回到该主机上次访问的目录；目录已失效时由 handleServerError 回落 /。 */
  private async restoreRememberedDirectory(home: string): Promise<void> {
    const generation = this.generation;
    const paths = await this.loadPathModule();
    if (generation !== this.generation || !this.ready) return;
    let remembered: string | null = null;
    if (paths && this.hostId) {
      const record = paths.readRememberedPath(this.pathStorage, this.hostId);
      if (record) {
        try {
          remembered = normalizePath(record.directory);
        } catch {
          remembered = null;
        }
      }
    }
    const restore = remembered !== null && remembered !== home ? remembered : null;
    this.elements.path.value = restore ?? home;
    this.requestList(restore ?? home, restore ? 'push' : 'none', undefined, restore !== null);
  }

  private loadPathModule(): Promise<FilePathsModule | null> {
    this.pathsLoading ??= import('./file-paths').then(
      (module) => {
        this.paths = module;
        return module;
      },
      () => null,
    );
    return this.pathsLoading;
  }

  private requestList(
    path: string,
    historyMode: PendingRequest['historyMode'],
    historyIndex?: number,
    restorePath = false,
  ): string | null {
    if (!this.ready || !this.isSocketOpen()) return null;
    let normalized: string;
    try { normalized = normalizePath(path); } catch {
      this.showError(this.localize({ zh: '请输入有效的绝对路径。', en: 'Enter a valid absolute path.' }));
      return null;
    }
    if (this.activeListRequest) this.pending.delete(this.activeListRequest);
    // 切目录会让还在途中的「打开编辑器」请求过期，避免迟到结果在新目录里弹出编辑器。
    if (this.editorRequest && normalized !== this.cwd) {
      this.pending.delete(this.editorRequest.requestId);
      this.editorRequest = null;
      this.updateControls();
    }
    const requestId = this.createRequest('list', normalized, { historyMode, historyIndex, restorePath });
    this.activeListRequest = requestId;
    this.elements.loading.hidden = false;
    this.elements.empty.hidden = true;
    this.elements.error.hidden = true;
    this.setStatus({ zh: `正在读取 ${normalized}`, en: `Loading ${normalized}` });
    this.send({ type: 'sftp_list', requestId, path: normalized });
    return requestId;
  }

  private handleListResult(message: JsonRecord): void {
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    // === Tree-view fetch: route to tree channel, never enter right-side rendering ===
    if (requestId.startsWith('tree-')) {
      this.resolveTreeList(message, requestId);
      return;
    }
    const pending = this.pending.get(requestId);
    if (!pending || pending.generation !== this.generation || pending.operation !== 'list') return;
    this.pending.delete(requestId);
    if (requestId !== this.activeListRequest) return;
    this.activeListRequest = null;
    let path: string;
    try { path = normalizePath(typeof message.path === 'string' ? message.path : pending.path); } catch {
      this.showError(this.localize({ zh: '文件服务返回了无效路径。', en: 'The file service returned an invalid path.' }));
      return;
    }
    if (!Array.isArray(message.entries)) {
      this.showError(this.localize({ zh: '文件服务返回了无效目录列表。', en: 'The file service returned an invalid directory listing.' }));
      return;
    }
    const entries = message.entries.map((entry) => this.parseEntry(entry)).filter((entry): entry is SFTPEntry => entry !== null);
    entries.sort((left, right) => {
      if (left.type === 'directory' && right.type !== 'directory') return -1;
      if (left.type !== 'directory' && right.type === 'directory') return 1;
      return left.name.localeCompare(right.name, this.isChinese() ? 'zh-CN' : 'en', { numeric: true, sensitivity: 'base' });
    });
    this.cwd = path;
    this.emitCwdChange(path);
    this.rememberDirectory(path);
    if (pending.historyMode === 'push' && this.history[this.historyIndex] !== path) {
      this.history = this.history.slice(0, this.historyIndex + 1);
      this.history.push(path);
      this.historyIndex = this.history.length - 1;
    } else if (pending.historyMode === 'index' && pending.historyIndex !== undefined) {
      this.historyIndex = pending.historyIndex;
    }
    this.entries = entries;
    this.selectedIndex = -1;
    this.elements.path.value = path;
    this.elements.loading.hidden = true;
    this.elements.error.hidden = true;
    this.elements.empty.hidden = entries.length !== 0;
    this.renderEntries();
    const truncated = message.isTruncated === true;
    const notice = this.listNotice;
    this.listNotice = null;
    this.setStatus(notice ?? {
      zh: `${entries.length} 个项目${truncated ? '（列表已截断）' : ''}`,
      en: `${entries.length} item${entries.length === 1 ? '' : 's'}${truncated ? ' (list truncated)' : ''}`,
    });
    this.updateControls();
  }

  private parseEntry(value: unknown): SFTPEntry | null {
    if (!isRecord(value) || typeof value.name !== 'string') return null;
    let name: string;
    try { name = validateName(value.name); } catch { return null; }
    const rawType = typeof value.type === 'string' ? value.type.toLowerCase() : 'other';
    const type: SFTPEntry['type'] = rawType === 'dir' || rawType === 'directory'
      ? 'directory'
      : rawType === 'file' || rawType === 'regular'
        ? 'file'
        : rawType === 'link' || rawType === 'symlink'
          ? 'symlink'
          : 'other';
    return {
      name,
      type,
      size: fileSizeValue(value.size) ?? 0,
      mtime: typeof value.mtime === 'string' || typeof value.mtime === 'number' ? value.mtime : '',
      permissions: typeof value.permissions === 'string' || typeof value.permissions === 'number' ? value.permissions : '',
      uid: typeof value.uid === 'string' || typeof value.uid === 'number' ? value.uid : undefined,
      gid: typeof value.gid === 'string' || typeof value.gid === 'number' ? value.gid : undefined,
      owner: typeof value.owner === 'string' ? value.owner : undefined,
      group: typeof value.group === 'string' ? value.group : undefined,
    };
  }

  private renderEntries(): void {
    this.elements.tableBody.replaceChildren();
    if (this.listView) {
      this.listView.render({
        chinese: this.isChinese(),
        selectedId: this.selectedEntry()?.name,
        items: this.entries.map((entry, index) => ({
          id: entry.name, name: entry.name, index, entry,
          columns: [
            entry.type === 'directory' ? '' : this.formatSize(entry.size),
            this.localize(this.typeLabel(entry.type)), this.formatDate(entry.mtime),
            String(entry.permissions), entry.owner ?? String(entry.uid ?? ''),
            entry.group ?? String(entry.gid ?? ''),
          ],
        })),
      });
      return;
    }
    const fragment = document.createDocumentFragment();
    this.entries.forEach((entry, index) => {
      const row = document.createElement('tr');
      row.dataset.index = String(index);
      row.tabIndex = index === this.rovingIndex() ? 0 : -1;
      row.setAttribute('aria-selected', String(index === this.selectedIndex));

      const nameCell = document.createElement('td');
      const nameWrap = document.createElement('span');
      nameWrap.className = 'file-name-cell';
      const icon = document.createElement('span');
      icon.className = `file-kind-icon ${entry.type}`;
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = entry.type === 'directory' ? '\u25a0' : entry.type === 'symlink' ? '\u2197' : '\u25a1';
      const name = document.createElement('span');
      name.textContent = entry.name;
      nameWrap.append(icon, name);
      nameCell.append(nameWrap);
      row.append(
        nameCell,
        this.cell(entry.type === 'directory' ? '' : this.formatSize(entry.size)),
        this.localizedCell(this.typeLabel(entry.type)),
        this.cell(this.formatDate(entry.mtime)),
        this.cell(String(entry.permissions ?? '')),
        this.cell(entry.owner ?? String(entry.uid ?? '')),
        this.cell(entry.group ?? String(entry.gid ?? '')),
      );
      fragment.append(row);
    });
    this.elements.tableBody.append(fragment);
  }

  private cell(text: string): HTMLTableCellElement {
    const cell = document.createElement('td');
    cell.textContent = text;
    cell.title = text;
    return cell;
  }

  private localizedCell(copy: LocalizedText): HTMLTableCellElement {
    const cell = this.cell(this.localize(copy));
    cell.dataset.i18nZh = copy.zh;
    cell.dataset.i18nEn = copy.en;
    return cell;
  }

  private rowFromEvent(event: Event): HTMLTableRowElement | null {
    const target = event.target instanceof Element ? event.target.closest<HTMLTableRowElement>('tr[data-index]') : null;
    if (!target || !this.elements.tableBody.contains(target)) return null;
    return target;
  }

  private selectRow(target: HTMLTableRowElement, focus: boolean): SFTPEntry | null {
    const index = Number(target.dataset.index);
    if (!Number.isInteger(index) || !this.entries[index]) return null;
    this.selectedIndex = index;
    for (const row of this.elements.tableBody.rows) {
      const selected = row === target;
      row.setAttribute('aria-selected', String(selected));
      row.tabIndex = selected ? 0 : -1;
    }
    if (focus) target.focus();
    this.updateControls();
    return this.entries[index];
  }

  private rovingIndex(): number {
    if (this.entries.length === 0) return -1;
    return this.selectedIndex >= 0 && this.selectedIndex < this.entries.length ? this.selectedIndex : 0;
  }

  private activateEntry(entry: SFTPEntry | null): void {
    if (!entry) return;
    if (entry.type === 'directory' || entry.type === 'symlink') {
      this.navigate(joinPath(this.cwd, entry.name));
    } else if (this.canEdit(entry)) {
      void this.openEditor(entry);
    } else {
      this.downloadSelected();
    }
  }

  private async createDirectory(): Promise<void> {
    if (!this.ready || this.hasTransfer()) return;
    const input = await this.promptAction(this.localize({ zh: '新文件夹名称', en: 'New folder name' }), '');
    if (input === null) return;
    let path: string;
    try { path = joinPath(this.cwd, input); } catch {
      this.showError(this.localize({ zh: '文件夹名称无效。', en: 'The folder name is invalid.' }));
      return;
    }
    const requestId = this.createRequest('mkdir', path);
    this.send({ type: 'sftp_mkdir', requestId, path });
    this.setStatus({ zh: '正在新建文件夹…', en: 'Creating folder…' });
  }

  private async renameSelected(): Promise<void> {
    const entry = this.selectedEntry();
    if (!this.ready || !entry || this.hasTransfer()) return;
    const input = await this.promptAction(this.localize({ zh: '输入新名称', en: 'Enter a new name' }), entry.name);
    if (input === null || input === entry.name) return;
    let newPath: string;
    try { newPath = joinPath(this.cwd, input); } catch {
      this.showError(this.localize({ zh: '文件名无效。', en: 'The file name is invalid.' }));
      return;
    }
    const oldPath = joinPath(this.cwd, entry.name);
    const requestId = this.createRequest('rename', oldPath);
    this.send({ type: 'sftp_rename', requestId, oldPath, newPath });
    this.setStatus({ zh: '正在重命名…', en: 'Renaming…' });
  }

  private async deleteSelected(): Promise<void> {
    const entry = this.selectedEntry();
    if (!this.ready || !entry || this.hasTransfer()) return;
    const confirmed = await this.confirmAction(this.localize({
      zh: `确定要删除“${entry.name}”吗？此操作无法撤销。`,
      en: `Delete “${entry.name}”? This cannot be undone.`,
    }));
    if (!confirmed) return;
    const path = joinPath(this.cwd, entry.name);
    const operation = entry.type === 'directory' ? 'rmdir' : 'delete';
    const requestId = this.createRequest(operation, path);
    this.send({ type: operation === 'rmdir' ? 'sftp_rmdir' : 'sftp_delete', requestId, path });
    this.setStatus({ zh: '正在删除…', en: 'Deleting…' });
  }

  private handleMutationResult(message: JsonRecord): void {
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    const pending = this.pending.get(requestId);
    if (!pending || pending.generation !== this.generation || !['mkdir', 'rename', 'delete', 'rmdir'].includes(pending.operation)) return;
    this.pending.delete(requestId);
    this.setStatus({ zh: '操作完成', en: 'Operation completed' });
    this.refresh();
  }

  private async handleUploadReady(message: JsonRecord): Promise<void> {
    const state = this.matchUpload(message);
    if (!state || state.sent !== 0) return;
    state.readyForData = true;
    if (state.cancelling) {
      this.sendUploadCancel(state);
      return;
    }
    await this.sendNextUploadChunk(state);
  }

  private async handleUploadProgress(message: JsonRecord): Promise<void> {
    const state = this.matchUpload(message);
    if (!state) return;
    const acknowledged = numberValue(message.loaded) ?? numberValue(message.transferred) ?? numberValue(message.received) ?? numberValue(message.bytes) ?? state.sent;
    state.acknowledged = Math.min(state.source.size, Math.max(state.acknowledged, acknowledged));
    state.awaitingAck = false;
    this.showProgress('upload', state.source.name, state.source.size === 0 ? 100 : (state.acknowledged / state.source.size) * 100);
    if (state.cancelling) {
      this.sendUploadCancel(state);
      return;
    }
    await this.sendNextUploadChunk(state);
  }

  private async sendNextUploadChunk(state: UploadState): Promise<void> {
    if (state !== this.uploadState || state.generation !== this.generation || !state.readyForData
      || state.cancelling || state.awaitingAck || state.endSent || !this.isSocketOpen()) return;
    if (state.sent >= state.source.size) {
      state.endSent = true;
      this.updateProgressLanguage();
      this.send({ type: 'sftp_upload_end', requestId: state.requestId });
      return;
    }
    const end = Math.min(state.source.size, state.sent + SFTP_UPLOAD_CHUNK_SIZE);
    const chunk = await state.source.slice(state.sent, end);
    if (state !== this.uploadState || state.generation !== this.generation || state.cancelling || !this.isSocketOpen()) return;
    this.socket!.send(chunk);
    state.sent = end;
    state.awaitingAck = true;
  }

  private handleUploadComplete(message: JsonRecord): void {
    const state = this.matchUpload(message);
    if (!state) return;
    this.pending.delete(state.requestId);
    this.uploadState = null;
    this.hideProgress();
    const mtime = numberValue(message.mtime);
    const savingEditor = state.editorContent !== undefined;
    if (savingEditor && this.editor && this.editorDocument) {
      // An unavailable post-save version pauses automatic writes until explicitly resolved.
      this.editorDocument.mtime = nextMtimeBaseline(mtime);
      this.editor.markSaved(state.editorContent!, mtime);
    }
    if (savingEditor) this.completeEditorSave(state, true);
    this.setStatus(savingEditor
      ? { zh: `已保存 ${state.source.name}`, en: `Saved ${state.source.name}` }
      : { zh: `已上传 ${state.source.name}`, en: `Uploaded ${state.source.name}` });
    this.updateControls();
    if (savingEditor) {
      const entry = this.entries.find((item) => joinPath(this.cwd, item.name) === state.path);
      if (entry) {
        entry.size = state.source.size;
        if (mtime !== null) entry.mtime = mtime;
        this.renderEntries();
      }
    } else this.refresh();
  }

  private handleDownloadStart(message: JsonRecord): void {
    const state = this.matchDownload(message);
    if (!state) return;
    state.started = true;
    const size = numberValue(message.size);
    state.expectedSize = size;
    if (state.cancelling) {
      this.sendDownloadCancel(state);
      return;
    }
    if (state.expectedSize !== null && state.expectedSize > MAX_SFTP_FILE_SIZE) {
      state.cancelling = true;
      this.setStatus({ zh: '正在取消传输…', en: 'Cancelling transfer…' });
      this.updateProgressLanguage();
      this.sendDownloadCancel(state);
    }
  }

  private handleDownloadProgress(message: JsonRecord): void {
    const state = this.matchDownload(message);
    if (!state || state.cancelling) return;
    const received = numberValue(message.loaded) ?? numberValue(message.transferred) ?? numberValue(message.sent) ?? numberValue(message.bytes) ?? state.received;
    const total = numberValue(message.total) ?? numberValue(message.size) ?? state.expectedSize;
    const percent = total && total > 0 ? Math.min(100, (received / total) * 100) : 0;
    this.showProgress('download', state.name, percent);
  }

  private async handleBinary(data: Exclude<SocketData, string>, generation: number): Promise<void> {
    const read = this.textRead;
    if (read) {
      const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer())
        : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
      if (generation !== this.generation || read !== this.textRead) return;
      try { read.append(bytes); }
      catch (error) {
        this.send({ type: 'sftp_download_cancel', requestId: read.requestId });
        this.handleServerError({ type: 'sftp_error', requestId: read.requestId, message: String(error) });
      }
      return;
    }
    const state = this.downloadState;
    if (!state || state.generation !== generation || generation !== this.generation) return;
    let buffer: ArrayBuffer;
    if (data instanceof Blob) buffer = await data.arrayBuffer();
    else if (ArrayBuffer.isView(data)) buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    else buffer = data;
    if (state !== this.downloadState || state.generation !== this.generation) return;
    if (state.cancelling) return;
    if (state.received + buffer.byteLength > MAX_SFTP_FILE_SIZE) {
      state.cancelling = true;
      this.setStatus({ zh: '正在取消传输…', en: 'Cancelling transfer…' });
      this.updateProgressLanguage();
      this.sendDownloadCancel(state);
      return;
    }
    state.chunks.push(buffer);
    state.received += buffer.byteLength;
    const total = state.expectedSize;
    this.showProgress('download', state.name, total && total > 0 ? (state.received / total) * 100 : 0);
  }

  private handleDownloadDone(message: JsonRecord): void {
    const state = this.matchDownload(message);
    if (!state) return;
    if (state.cancelling) {
      this.completeCancelledTransfer(state);
      return;
    }
    const doneSize = numberValue(message.size);
    const expectedSize = doneSize ?? state.expectedSize;
    if (expectedSize !== null && state.received !== expectedSize) {
      this.failTransfer(this.localize({ zh: '下载未完成，文件大小不匹配。', en: 'The download is incomplete: file size mismatch.' }));
      return;
    }
    this.pending.delete(state.requestId);
    this.downloadState = null;
    this.saveBlob(new Blob(state.chunks), state.name);
    this.hideProgress();
    this.setStatus({ zh: `已下载 ${state.name}`, en: `Downloaded ${state.name}` });
    this.updateControls();
  }

  private handleServerError(message: JsonRecord): void {
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    if (this.textRead?.requestId === requestId) this.textRead = null;
    // === Tree-view fetch error: route to tree channel, never enter right-side error handling ===
    if (requestId.startsWith('tree-')) {
      this.rejectTreeList(message, requestId);
      return;
    }
    const pending = requestId ? this.pending.get(requestId) : undefined;
    // 打开编辑器失败不依赖 pending 是否还在（读取请求可能已被取消）。
    if (pending?.operation === 'readText' || (requestId && this.editorRequest?.requestId === requestId)) {
      this.pending.delete(requestId);
      this.editorRequest = null;
      this.showError(this.textErrorCopy(message));
      this.updateControls();
      return;
    }
    // 冲突后「以远端为准」的重新读取失败：保留草稿与暂停状态，只报错。
    if (this.reloadRequest && requestId === this.reloadRequest.requestId) {
      this.pending.delete(requestId);
      this.reloadRequest = null;
      const reason = typeof message.message === 'string' && message.message
        ? message.message
        : this.localize({ zh: '无法读取远端版本。', en: 'Could not read the remote version.' });
      this.editor?.markSaveFailed(reason, true);
      this.showError(reason);
      return;
    }
    if (requestId && (!pending || pending.generation !== this.generation)) return;
    if (requestId) this.pending.delete(requestId);
    if (pending?.operation === 'list' && requestId !== this.activeListRequest) return;
    if (requestId === this.activeListRequest) {
      this.activeListRequest = null;
      this.elements.loading.hidden = true;
    }
    // 恢复上次目录失败：回落到 / 并提示一句，不把用户丢在错误面板里。
    if (pending?.operation === 'list' && pending.restorePath) {
      this.listNotice = {
        zh: '上次访问的目录已不可用，已回到 /。',
        en: 'The last visited folder is unavailable; returned to /.',
      };
      this.requestList('/', 'none');
      return;
    }
    const fallback = this.localize({ zh: '文件操作失败。', en: 'The file operation failed.' });
    const serverMessage = typeof message.message === 'string' && message.message ? message.message : fallback;
    const upload = requestId === this.uploadState?.requestId ? this.uploadState : null;
    const transfer = upload ?? (requestId === this.downloadState?.requestId ? this.downloadState : null);
    if (transfer) {
      this.abortTransfers(true);
    }
    if (upload?.editorContent !== undefined) {
      if (message.conflict === true) {
        void this.handleEditorConflict(upload.editorContent, upload.autoSave === true);
        return;
      }
      this.editor?.markSaveFailed(serverMessage);
      this.showError(serverMessage);
      return;
    }
    this.showError(serverMessage);
  }

  /** Resolve a pending tree-view fetch promise with parsed, sorted entries. */
  private resolveTreeList(message: JsonRecord, requestId: string): void {
    const entry = this.treeLists.get(requestId);
    if (!entry || entry.generation !== this.generation) return;
    this.treeLists.delete(requestId);
    let path: string;
    try { path = normalizePath(typeof message.path === 'string' ? message.path : ''); }
    catch {
      entry.reject(new Error(
        this.localize({ zh: '目录列表数据异常。', en: 'The directory listing response was malformed.' }),
        { cause: 'invalid path in tree list result' },
      ));
      return;
    }
    if (!Array.isArray(message.entries)) {
      entry.reject(new Error(
        this.localize({ zh: '目录列表数据异常。', en: 'The directory listing response was malformed.' }),
        { cause: 'invalid entries in tree list result' },
      ));
      return;
    }
    const entries = message.entries
      .map((raw) => this.parseEntry(raw))
      .filter((item): item is SFTPEntry => item !== null);
    entries.sort((left, right) => {
      if (left.type === 'directory' && right.type !== 'directory') return -1;
      if (left.type !== 'directory' && right.type === 'directory') return 1;
      return left.name.localeCompare(right.name, this.isChinese() ? 'zh-CN' : 'en', { numeric: true, sensitivity: 'base' });
    });
    entry.resolve({ path, entries, isTruncated: message.isTruncated === true });
  }

  /** Reject a single pending tree-view fetch promise with the server error message. */
  private rejectTreeList(message: JsonRecord, requestId: string): void {
    const entry = this.treeLists.get(requestId);
    if (!entry || entry.generation !== this.generation) return;
    this.treeLists.delete(requestId);
    const fallback = this.localize({ zh: '文件操作失败。', en: 'The file operation failed.' });
    const serverMessage = typeof message.message === 'string' && message.message ? message.message : fallback;
    entry.reject(new Error(serverMessage));
  }

  /** Reject all pending tree-view fetch promises (used on reset / close / destroy). */
  private rejectTreeLists(error: Error): void {
    this.treeLists.forEach((entry) => {
      entry.reject(error);
    });
    this.treeLists.clear();
  }

  /** 记录该主机最后成功列出的目录（localStorage 只存主机 id、路径、时间戳）。 */
  private rememberDirectory(directory: string): void {
    if (!this.hostId || !this.paths) return;
    this.paths.writeRememberedPath(this.pathStorage, this.hostId, directory);
  }

  /** Notify all registered cwd-change listeners. Listener errors are swallowed. */
  private emitCwdChange(cwd: string): void {
    this.cwdListeners.forEach((listener) => {
      try { listener(cwd); } catch { /* listener errors are non-fatal */ }
    });
  }

  private handleTransferCancelled(message: JsonRecord, operation: 'upload' | 'download'): void {
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    const state = operation === 'upload' ? this.uploadState : this.downloadState;
    if (!state || state.requestId !== requestId || state.generation !== this.generation || !state.cancelling) return;
    this.completeCancelledTransfer(state);
  }

  private completeCancelledTransfer(state: UploadState | DownloadState): void {
    if (state !== this.uploadState && state !== this.downloadState) return;
    this.pending.delete(state.requestId);
    this.abortTransfers(true);
    this.setStatus({ zh: '传输已取消', en: 'Transfer cancelled' });
  }

  private requestTransferCancel(): void {
    const upload = this.uploadState;
    const transfer = upload ?? this.downloadState;
    if (!transfer || transfer.cancelling || upload?.endSent) return;
    transfer.cancelling = true;
    this.setStatus({ zh: '正在取消传输…', en: 'Cancelling transfer…' });
    this.updateProgressLanguage();
    if (upload) this.sendUploadCancel(upload);
    else this.sendDownloadCancel(transfer as DownloadState);
  }

  private sendUploadCancel(state: UploadState): void {
    if (state !== this.uploadState || state.cancelSent || !state.readyForData || !this.isSocketOpen()) return;
    state.cancelSent = true;
    this.send({ type: 'sftp_upload_cancel', requestId: state.requestId });
  }

  private sendDownloadCancel(state: DownloadState): void {
    if (state !== this.downloadState || state.cancelSent || !state.started || !this.isSocketOpen()) return;
    state.cancelSent = true;
    this.send({ type: 'sftp_download_cancel', requestId: state.requestId });
  }

  private createRequest(operation: string, path: string, extra: Partial<PendingRequest> = {}): string {
    const requestId = `${this.generation}-${++this.requestSequence}`;
    this.pending.set(requestId, { generation: this.generation, operation, path, ...extra });
    return requestId;
  }

  private matchUpload(message: JsonRecord): UploadState | null {
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    const state = this.uploadState;
    return state && state.requestId === requestId && state.generation === this.generation ? state : null;
  }

  private matchDownload(message: JsonRecord): DownloadState | null {
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    const state = this.downloadState;
    return state && state.requestId === requestId && state.generation === this.generation ? state : null;
  }

  private send(message: JsonRecord): void {
    if (this.isSocketOpen()) this.socket!.send(JSON.stringify(message));
  }

  private isSocketOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private isCurrent(socket: WebSocket, generation: number): boolean {
    return this.socket === socket && this.generation === generation;
  }

  private hasTransfer(): boolean {
    return this.uploadState !== null || this.downloadState !== null || this.editorRequest !== null || this.reloadRequest !== null || this.textRead !== null;
  }

  private selectedEntry(): SFTPEntry | null {
    return this.selectedIndex >= 0 ? this.entries[this.selectedIndex] ?? null : null;
  }

  private abortTransfers(updateControls: boolean): void {
    // 编辑器保存被中断（断开 / 取消 / 服务端拒绝）时，必须把编辑器从「正在保存」状态里放出来。
    const interrupted = this.uploadState;
    const interruptedSave = interrupted?.editorContent !== undefined;
    this.uploadState = null;
    this.downloadState = null;
    this.hideProgress();
    if (interruptedSave && interrupted) {
      this.editor?.markSaveFailed(this.localize({ zh: '保存未完成，连接或传输已中断。', en: 'The save did not complete: the connection or transfer was interrupted.' }));
      this.completeEditorSave(interrupted, false);
    }
    if (updateControls) this.updateControls();
  }

  private failTransfer(message: string): void {
    const requestId = this.uploadState?.requestId ?? this.downloadState?.requestId;
    if (requestId) this.pending.delete(requestId);
    this.abortTransfers(true);
    this.showError(message);
  }

  private updateControls(): void {
    const selected = this.selectedEntry();
    const idle = this.ready && !this.hasTransfer() && !this.uploadConfirmationPending && this.editorRequest === null;
    this.elements.path.disabled = !this.ready;
    this.elements.back.disabled = !this.ready || this.historyIndex <= 0;
    this.elements.up.disabled = !this.ready || this.cwd === '/';
    // 列目录失败时 cwd 仍是上次成功路径，允许用主目录按钮恢复，而不把错误页锁在原处。
    this.elements.home.disabled = !this.ready || (this.cwd === this.homePath && this.elements.error.hidden);
    this.elements.refresh.disabled = !this.ready;
    this.elements.upload.disabled = !idle;
    this.elements.mkdir.disabled = !idle;
    this.elements.download.disabled = !idle || !selected || selected.type !== 'file' || sizeExceedsLimit(selected.size);
    const editable = selected !== null && this.canEdit(selected);
    this.elements.edit.disabled = !idle || this.editor !== null || !editable;
    const editLabel = editable || !selected
      ? this.localize({ zh: '编辑', en: 'Edit' })
      : this.editHint(selected);
    this.elements.edit.title = editLabel;
    this.elements.edit.setAttribute('aria-label', editLabel);
    this.elements.rename.disabled = !idle || !selected;
    this.elements.delete.disabled = !idle || !selected;
  }

  private renderDisconnected(channelLost = false, detail?: LocalizedText): void {
    this.entries = [];
    this.selectedIndex = -1;
    this.renderEntries();
    this.elements.loading.hidden = true;
    this.elements.empty.hidden = true;
    this.elements.error.hidden = true;
    this.elements.path.value = '/';
    this.hideProgress();
    if (channelLost) this.setStatus(detail ?? DISCONNECTED_CHANNEL);
    else this.updateStatusText(DISCONNECTED);
    this.updateControls();
  }

  private describeClose(event: CloseEvent): LocalizedText | undefined {
    if (event.code === 1000) return undefined;
    const codeInfo = this.isChinese()
      ? `代码 ${event.code}${event.reason ? `：${event.reason}` : ''}`
      : `code ${event.code}${event.reason ? `: ${event.reason}` : ''}`;
    const base = DISCONNECTED_CHANNEL;
    return { zh: `${base.zh}（${codeInfo}）`, en: `${base.en} (${codeInfo})` };
  }

  private showError(message: string): void {
    this.listNotice = null;
    this.elements.loading.hidden = true;
    this.elements.empty.hidden = true;
    this.elements.error.textContent = message;
    this.elements.error.hidden = false;
    this.updateStatusText({ zh: message, en: message });
    this.onError?.(message);
    this.updateControls();
  }

  private scheduleReconnect(): void {
    if (!this.wantConnection || !this.url || this.reconnectTimer !== null) return;
    this.reconnectAttempts++;
    if (this.reconnectAttempts > RECONNECT_MAX_ATTEMPTS) {
      console.log(
        `[WS-Reconnect] ${new Date().toISOString()} | SFTP | give_up | attempt=${this.reconnectAttempts - 1}/${RECONNECT_MAX_ATTEMPTS}`,
      );
      this.reconnectAttempts = 0;
      this.renderDisconnected(true, { zh: '文件管理重连失败。', en: 'File manager reconnect failed.' });
      return;
    }
    const delayIndex = this.reconnectAttempts - 1;
    const delay = delayIndex < RECONNECT_DELAYS.length
      ? RECONNECT_DELAYS[delayIndex]
      : RECONNECT_DELAYS[RECONNECT_DELAYS.length - 1];
    console.log(
      `[WS-Reconnect] ${new Date().toISOString()} | SFTP | reconnect_attempt | attempt=${this.reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS}`,
    );
    this.setStatus({
      zh: '文件管理连接已断开，正在重连…',
      en: 'File manager disconnected; reconnecting…',
    });
    const attempts = this.reconnectAttempts;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.wantConnection || !this.url) return;
      try {
        this.attach(this.url);
      } catch {
        console.log(
          `[WS-Reconnect] ${new Date().toISOString()} | SFTP | reconnect_failed | attempt=${attempts}/${RECONNECT_MAX_ATTEMPTS}`,
        );
        // attach() → reset() zeroed the counter; restore so the next
        // close handler's scheduleReconnect() continues accumulating.
        if (this.wantConnection) {
          this.reconnectAttempts = attempts;
        }
        this.scheduleReconnect();
        return;
      }
      // Successful attach(). The open handler will log reconnect_success
      // once the WebSocket actually connects; for now restore the counter
      // so that if a close fires before open confirms, back-off continues.
      if (this.wantConnection) {
        this.reconnectAttempts = attempts;
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setStatus(copy: LocalizedText): void {
    this.updateStatusText(copy);
    this.onStatus?.(this.localize(copy));
  }

  private updateStatusText(copy: LocalizedText): void {
    this.statusCopy = copy;
    this.elements.status.dataset.i18nZh = copy.zh;
    this.elements.status.dataset.i18nEn = copy.en;
    this.elements.status.textContent = this.localize(copy);
  }

  private showProgress(operation: 'upload' | 'download', name: string, percent: number): void {
    this.elements.progress.dataset.operation = operation;
    this.elements.progress.dataset.name = name;
    this.elements.progress.hidden = false;
    this.elements.progressCancel.disabled = false;
    this.elements.progressBar.value = Math.max(0, Math.min(100, percent));
    this.updateProgressLanguage();
  }

  private updateProgressLanguage(): void {
    if (this.elements.progress.hidden) return;
    const transfer = this.uploadState ?? this.downloadState;
    const operation = this.elements.progress.dataset.operation;
    const name = this.elements.progress.dataset.name ?? '';
    const verb = operation === 'upload'
      ? this.localize({ zh: '上传', en: 'Uploading' })
      : this.localize({ zh: '下载', en: 'Downloading' });
    this.elements.progressLabel.textContent = transfer?.cancelling
      ? this.localize({ zh: `正在取消 ${name}…`, en: `Cancelling ${name}…` })
      : `${verb} ${name} ${Math.round(this.elements.progressBar.value)}%`;
    this.elements.progressCancel.disabled = Boolean(transfer?.cancelling || this.uploadState?.endSent);
    this.elements.progressCancel.textContent = transfer?.cancelling
      ? this.localize({ zh: '取消中…', en: 'Cancelling…' })
      : this.localize({ zh: '取消', en: 'Cancel' });
  }

  private hideProgress(): void {
    this.elements.progress.hidden = true;
    this.elements.progressBar.value = 0;
    this.elements.progressLabel.textContent = '';
    this.elements.progressCancel.disabled = false;
    this.elements.progressCancel.textContent = this.localize({ zh: '取消', en: 'Cancel' });
    delete this.elements.progress.dataset.operation;
    delete this.elements.progress.dataset.name;
  }

  private formatSize(bytes: number | string): string {
    if (typeof bytes === 'string') return sizeExceedsLimit(bytes) ? '> 64 MiB' : this.formatSize(Number(bytes));
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KiB', 'MiB', 'GiB'];
    let value = bytes;
    let unit = -1;
    do { value /= 1024; unit++; } while (value >= 1024 && unit < units.length - 1);
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
  }

  private formatDate(value: string | number): string {
    if (value === '') return '';
    const numeric = typeof value === 'number' ? (value < 10_000_000_000 ? value * 1000 : value) : value;
    const date = new Date(numeric);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat(this.isChinese() ? 'zh-CN' : 'en', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date);
  }

  private typeLabel(type: SFTPEntry['type']): LocalizedText {
    if (type === 'directory') return { zh: '文件夹', en: 'Folder' };
    if (type === 'file') return { zh: '文件', en: 'File' };
    if (type === 'symlink') return { zh: '链接', en: 'Link' };
    return { zh: '其他', en: 'Other' };
  }

  private saveBlob(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private localize(copy: LocalizedText): string {
    return this.isChinese() ? copy.zh : copy.en;
  }

  private isChinese(): boolean {
    return this.getLanguage().toLowerCase().startsWith('zh');
  }
}
