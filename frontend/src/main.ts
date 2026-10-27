import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { createElement, Maximize, Minimize } from 'lucide';
import { historyKey, historyLabel } from './history';
import { normalizeHostAddress, sessionTargetKey, sessionTargetLabel } from './session-target';
import { listHosts, hostCredentials, saveHost, removeHost, updateHostSystem, type CloudHost, type Credentials, type HostSystemInfo } from './cloud-api';
import { Dashboard } from './dashboard';
import { FilePage } from './file-page';
import { Snippets } from './snippets';
import { Keychain, fillKeychainSelect } from './keychain';
import { resolveConnectionControl, resolveConnectionPanel } from './ui-state';
import { classifyHostKey, SSH_FINGERPRINT_RE, type HostKeyPrompt } from './host-key';
import { FileManager, collectFileManagerElements } from './file-manager';
import { FileTree } from './file-tree';
import { countryFlag } from './flags';
import { ProcessManager, collectProcessManagerElements, type NetworkSample } from './process-manager';
import { resetTerminalForConnection } from './terminal-session';
import { createTerminalTools, type TerminalToolsController } from './terminal-tools';
import { WebSocketReconnectManager } from './ws-reconnect';
import type { ReconnectLogEntry } from './ws-reconnect';
import { NET_SPARK_POINTS, type ConnectionState, type LocalizedMessage, type SessionContext } from './session-context';
import { MAX_SESSIONS_PER_TARGET, MAX_SESSIONS_TOTAL, SESSION_EVENT, SessionManager } from './session-manager';
import { createSessionTabBar } from './session-tabs';
import { forgetRestorableSession, loadRestorableSessions, saveRestorableSessions } from './session-store';
import type { RestorableSession } from './session-store';
import './style.css';

type AuthMethod = 'password' | 'publickey';
type Language = 'zh-CN' | 'en';
type Translation = readonly [zh: string, en: string];

type SavedProfile = CloudHost & Credentials;

type HistoryMutation =
  | { kind: 'upsert'; profile: SavedProfile }
  | { kind: 'delete'; target: string };

interface HistoryMutationResult {
  persisted: boolean;
  applied: boolean;
}

interface ConnectionConfig {
  type: 'connect';
  host: string;
  port: number;
  username: string;
  password?: string;
  authMethod: AuthMethod;
  privateKey?: string;
  keychainId?: string;
  keyPassphrase?: string;
  cols: number;
  rows: number;
  term: string;
  expectedFingerprint?: string;
}

interface ServerMessage {
  type?: string;
  event?: string;
  message?: string;
  retryable?: boolean;
  fingerprint?: string;
  expectedFingerprint?: string;
  keyType?: string;
  trusted?: boolean;
  latency?: number;
  colo?: string;
  ts?: number;
  algorithms?: Record<string, string>;
  url?: string;
  system?: unknown;
}

interface WSSHOptions {
  hostname?: string;
  host?: string;
  port?: string | number;
  username?: string;
  password?: string;
  privatekey?: string;
  privateKey?: string;
  command?: string;
  term?: string;
  encoding?: string;
  fingerprint?: string;
}

interface WSSHCompatibilityAPI {
  connect: ((options?: WSSHOptions) => Promise<void>) &
    ((host: string, port?: string | number, username?: string, password?: string, privateKey?: string) => Promise<void>);
  send: (data: string) => void;
  resize: () => void;
  set_encoding: (encoding: string) => void;
  reset_encoding: () => void;
  disconnect: () => void;
}

declare global {
  interface Window {
    wssh: WSSHCompatibilityAPI;
  }
}

const THEME_STORAGE_KEY = 'workers-webssh.theme';
const LANGUAGE_STORAGE_KEY = 'workers-webssh.language';
const MAX_KEY_BYTES = 65_536;
const PING_INTERVAL_MS = 25_000;
const CLIENT_CLOSE_SESSION_ERROR = 4000;
const SERVER_CLOSE_AUTH_DEFECT = 4001;
const CLIENT_CLOSE_PROTOCOL_ERROR = 4002;

function loadLanguage(): Language {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (stored === 'zh-CN' || stored === 'en') return stored;
  } catch {
    // Fall back to the browser language when storage is unavailable.
  }
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

let currentLanguage = loadLanguage();
const generatedTranslations = new Map<string, LocalizedMessage>();

function bilingual(zh: string, en: string): string {
  const translation = localized(zh, en);
  generatedTranslations.set(zh, translation);
  generatedTranslations.set(en, translation);
  return currentLanguage === 'zh-CN' ? zh : en;
}

function localized(zh: string, en: string): LocalizedMessage {
  return { zh, en };
}

function localize(message: LocalizedMessage): string {
  return bilingual(message.zh, message.en);
}

const STATIC_MESSAGE_TRANSLATIONS: Record<string, string> = {
  '请输入有效的主机名或 IP 地址。': 'Enter a valid hostname or IP address.',
  '端口必须介于 1 和 65535 之间。': 'Port must be between 1 and 65535.',
  '请输入有效的 SSH 用户名。': 'Enter a valid SSH username.',
  '主机指纹必须使用 SHA256:base64 格式。': 'Host fingerprint must use the SHA256:base64 format.',
  '请粘贴或选择 OpenSSH 私钥。': 'Paste or choose an OpenSSH private key.',
  '私钥大于 64 KiB。': 'The private key is larger than 64 KiB.',
  '仅支持 OpenSSH 私钥。': 'Only OpenSSH private keys are supported.',
  '请检查必填项和字段格式。': 'Check the required fields and their formats.',
};

function messageTranslation(message: string, alternate?: string): LocalizedMessage {
  if (alternate) return currentLanguage === 'zh-CN' ? localized(message, alternate) : localized(alternate, message);
  const generated = generatedTranslations.get(message);
  if (generated) return generated;
  const english = STATIC_MESSAGE_TRANSLATIONS[message];
  if (english) return localized(message, english);
  const staticChinese = Object.entries(STATIC_MESSAGE_TRANSLATIONS).find(([, value]) => value === message)?.[0];
  if (staticChinese) return localized(staticChinese, message);
  const chinese = SERVER_MESSAGE_TRANSLATIONS[message];
  if (chinese) return localized(chinese, message);
  const serverEnglish = Object.entries(SERVER_MESSAGE_TRANSLATIONS).find(([, value]) => value === message)?.[0];
  if (serverEnglish) return localized(message, serverEnglish);
  return localized(message, message);
}

function translate([zh, en]: Translation): string {
  return bilingual(zh, en);
}

const EVENT_LABELS: Record<string, Translation> = {
  session: ['会话', 'session'],
  connect: ['连接', 'connect'],
  transport: ['传输', 'transport'],
  authorization: ['授权', 'authorization'],
  disconnect: ['断开', 'disconnect'],
  protocol: ['协议', 'protocol'],
  status: ['状态', 'status'],
  ready: ['就绪', 'ready'],
  error: ['错误', 'error'],
  debug: ['调试', 'debug'],
  'host-key': ['主机密钥', 'host key'],
  sftp: ['文件管理', 'files'],
  system: ['系统', 'system'],
};

const SERVER_EVENT_MESSAGES: Record<string, Translation> = {
  version_exchange: ['正在交换 SSH 协议版本', 'Exchanging SSH protocol versions'],
  version_ready: ['版本交换完成，正在协商密钥', 'Version exchange complete; negotiating keys'],
  tcp_connecting: ['正在连接 SSH 服务器', 'Connecting to the SSH server'],
  authenticating: ['加密传输已建立，正在认证', 'Encrypted transport established; authenticating'],
  host_key_confirmation: ['发送凭据前请确认此主机密钥', 'Confirm this host key before credentials are sent'],
  auth_success: ['SSH 认证成功，正在打开终端', 'SSH authentication succeeded; opening ctx.terminal'],
  shell_ready: ['Shell 已就绪', 'Shell is ready'],
  ready: ['交互式 Shell 已就绪', 'Interactive shell ready'],
  remote_closed: ['SSH 服务器已关闭连接', 'The SSH server closed the connection'],
  remote_eof: ['SSH 服务器已结束输出', 'SSH server finished sending output'],
  session_ended: ['SSH 会话已结束', 'SSH session ended'],
  keepalive_timeout: ['SSH 保活响应超时', 'SSH keepalive timed out'],
};

const SERVER_MESSAGE_TRANSLATIONS: Record<string, string> = {
  'Invalid request origin': '请求来源无效',
  'Expected application/json': '请求必须使用 application/json',
  'Unable to create a session ticket': '无法创建会话票据',
  'Invalid SSH host': 'SSH 主机无效',
  'Invalid SSH port': 'SSH 端口无效',
  'Invalid SSH username': 'SSH 用户名无效',
  'Invalid authentication method': '身份认证方式无效',
  'Unsupported connection field': '包含不支持的连接字段',
  'Invalid ctx.terminal size': '终端尺寸无效',
  'Invalid host key fingerprint': '主机密钥指纹无效',
  'SSH authentication failed': 'SSH 认证失败',
  'Host key was not accepted': '主机密钥未被接受',
  'SSH host key signature verification failed': 'SSH 主机密钥签名验证失败',
  'The server does not support SSH 2.0': '服务器不支持 SSH 2.0',
  'SSH compression is not supported': '不支持 SSH 压缩',
  'Server-initiated SSH rekey is not supported': '不支持由服务器发起的 SSH 重新密钥交换',
  'SSH rekey is not supported by this ctx.terminal session': '当前终端会话不支持 SSH 重新密钥交换',
  'The SSH server closed the connection': 'SSH 服务器已关闭连接',
  'SSH session ended': 'SSH 会话已结束',
  'Shell is ready': 'Shell 已就绪',
  'Terminal is not ready': '终端尚未就绪',
  'Terminal input queue limit exceeded': '终端输入队列已超出限制',
  'SSH keepalive timed out': 'SSH 保活响应超时',
  'Session closed': '会话已关闭',
  'SSH session failed': 'SSH 会话失败',
};

function bilingualServerMessage(message: string | undefined, eventName?: string, fallback?: string, summary = 'SSH 状态更新'): string {
  const english = message?.trim() || fallback || eventName || 'SSH status';
  const eventText = eventName ? SERVER_EVENT_MESSAGES[eventName] : undefined;
  if (eventText && (!message || message === eventName || eventText[1] === english)) return translate(eventText);
  if (currentLanguage === 'en') return english;
  if (/[\u3400-\u9fff]/.test(english)) return english;
  const chinese = SERVER_MESSAGE_TRANSLATIONS[english];
  return chinese ?? english ?? summary;
}

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing UI element #${id}`);
  return node as T;
}

const ui = {
  panel: element<HTMLElement>('connection-panel'),
  panelToggle: element<HTMLButtonElement>('panel-toggle'),
  panelScrim: element<HTMLButtonElement>('panel-scrim'),
  profileList: element<HTMLElement>('profile-list'),
  profileCount: element<HTMLElement>('profile-count'),
  form: element<HTMLFormElement>('connection-form'),
  profileId: element<HTMLInputElement>('profile-id'),
  host: element<HTMLInputElement>('host'),
  port: element<HTMLInputElement>('port'),
  username: element<HTMLInputElement>('username'),
  password: element<HTMLInputElement>('password'),
  passwordField: element<HTMLElement>('password-field'),
  revealPassword: element<HTMLButtonElement>('reveal-password'),
  keyField: element<HTMLElement>('key-field'),
  keychainField: element<HTMLElement>('keychain-field'),
  keychainId: element<HTMLSelectElement>('keychain-id'),
  privateKey: element<HTMLTextAreaElement>('private-key'),
  keyFile: element<HTMLInputElement>('key-file'),
  keyPassphraseField: element<HTMLElement>('key-passphrase-field'),
  keyPassphrase: element<HTMLInputElement>('key-passphrase'),
  keyFileName: element<HTMLElement>('key-file-name'),
  initialCommand: element<HTMLInputElement>('initial-command'),
  termType: element<HTMLSelectElement>('term-type'),
  encoding: element<HTMLSelectElement>('encoding'),
  fingerprint: element<HTMLInputElement>('fingerprint'),
  formError: element<HTMLElement>('form-error'),
  connect: element<HTMLButtonElement>('connect-button'),
  shareLink: element<HTMLButtonElement>('share-link'),
  languageToggle: element<HTMLButtonElement>('language-toggle'),
  themeToggle: element<HTMLButtonElement>('theme-toggle'),
  sessionTitle: element<HTMLElement>('session-title'),
  sessionSubtitle: element<HTMLElement>('session-subtitle'),
  sessionFlag: element<HTMLElement>('session-flag'),
  liveOrb: element<HTMLElement>('live-orb'),
  liveOrbLabel: element<HTMLElement>('live-orb-label'),
  metricUptime: element<HTMLElement>('metric-uptime'),
  metricHostKey: element<HTMLElement>('metric-host-key'),
  resourceNetwork: element<HTMLElement>('resource-network'),
  resourceNetworkIface: element<HTMLElement>('resource-network-iface'),
  resourceNetworkSelect: element<HTMLSelectElement>('resource-network-select'),
  resourceNetworkRateUp: element<HTMLElement>('resource-network-rate-up'),
  resourceNetworkRateDown: element<HTMLElement>('resource-network-rate-down'),
  resourceNetworkSparkline: element<HTMLCanvasElement>('resource-network-sparkline'),
  terminalCard: element<HTMLElement>('terminal-card'),
  terminalStage: element<HTMLElement>('terminal-stage'),
  sessionTabs: element<HTMLElement>('session-tabs'),
  terminalEmpty: element<HTMLElement>('terminal-empty'),
  emptyConnect: element<HTMLButtonElement>('empty-connect'),
  clearTerminal: element<HTMLButtonElement>('clear-terminal'),
  fullscreenTerminal: element<HTMLButtonElement>('fullscreen-terminal'),
  eventMessage: element<HTMLElement>('event-message'),
  fileManagerTab: element<HTMLButtonElement>('file-manager-tab'),
  fileManagerPanel: element<HTMLElement>('file-manager-panel'),
  fullscreenFiles: element<HTMLButtonElement>('fullscreen-files'),
  exitFullscreenFiles: element<HTMLButtonElement>('exit-fullscreen-files'),
  fileTree: element<HTMLElement>('file-tree'),
  processManagerTab: element<HTMLButtonElement>('process-manager-tab'),
  processManagerPanel: element<HTMLElement>('process-manager-panel'),
  eventToggle: element<HTMLButtonElement>('event-toggle'),
  eventLog: element<HTMLElement>('event-log'),
  toastRegion: element<HTMLElement>('toast-region'),
  hostKeyDialog: element<HTMLDialogElement>('host-key-dialog'),
  hostKeyIcon: element<HTMLElement>('host-key-icon'),
  hostKeyEyebrow: element<HTMLElement>('host-key-eyebrow'),
  hostKeyTitle: element<HTMLElement>('host-key-title'),
  hostKeyDescription: element<HTMLElement>('host-key-description'),
  hostKeyTarget: element<HTMLElement>('host-key-target'),
  hostKeyType: element<HTMLElement>('host-key-type'),
  hostKeyExpectedRow: element<HTMLElement>('host-key-expected-row'),
  hostKeyExpectedFingerprint: element<HTMLElement>('host-key-expected-fingerprint'),
  hostKeyFingerprint: element<HTMLElement>('host-key-fingerprint'),
  rememberHostKey: element<HTMLInputElement>('remember-host-key'),
  rememberHostKeyLabel: element<HTMLElement>('remember-host-key-label'),
  rejectHostKey: element<HTMLButtonElement>('reject-host-key'),
  acceptHostKey: element<HTMLButtonElement>('accept-host-key'),
};

// ---------------------------------------------------------------------------
// Session tabs + per-session xterm hosts
//
// `#terminal-stage` carries one `.term-instance` per session; only the front
// session's host stays visible so every session keeps its own scrollback and
// rendered buffer across tab switches.
// ---------------------------------------------------------------------------

/** Single source for the toolbar orb, the file page badge and the tab dots. */
const SESSION_STATE_LABEL: Record<ConnectionState, LocalizedMessage> = {
  idle: localized('离线', 'Offline'),
  connecting: localized('连接中', 'Connecting'),
  connected: localized('在线', 'Online'),
  disconnecting: localized('正在断开', 'Disconnecting'),
  error: localized('错误', 'Error'),
};

const sessionTabBar = createSessionTabBar({
  container: ui.sessionTabs,
  localize: bilingual,
  stateLabel: (state) => localize(SESSION_STATE_LABEL[state]),
  onActivate: (id) => activateSession(id),
  onClose: (id) => closeSessionTab(id),
});

/** Create (once) and return the xterm host owned by this session. */
function mountTerminal(session: SessionContext): HTMLElement {
  let host = session.terminalEl;
  if (!host?.isConnected) {
    host = document.createElement('div');
    host.className = 'term-instance';
    host.dataset.session = session.id;
    // Insert before the empty overlay so an instance never covers its copy.
    ui.terminalStage.insertBefore(host, ui.terminalEmpty);
    session.terminalEl = host;
    session.terminalOpened = false;
  }
  if (!session.terminalOpened) {
    session.terminal.open(host);
    session.terminalOpened = true;
  }
  return host;
}

/**
 * One stage, many sessions: whichever instance belongs to the front session is
 * the only one allowed to take the space. The others keep their xterm buffer
 * untouched so coming back restores the scrollback exactly where it was.
 */
function showOnlyTerminal(session: SessionContext): void {
  const host = mountTerminal(session);
  for (const instance of ui.terminalStage.querySelectorAll<HTMLElement>('.term-instance')) {
    instance.hidden = instance !== host;
  }
}

/**
 * Hand the shared panels (file manager, tree, process manager) to one session.
 * The DOM is unique; the managers are per session, so everybody else must let
 * go first. Background managers keep polling their own channels.
 */
function mountSessionPanels(session: SessionContext): void {
  for (const summary of sessions.list()) {
    if (summary.id === session.id) continue;
    const other = sessions.get(summary.id);
    if (!other) continue;
    other.fileManager?.unmount();
    other.fileTree?.unmount();
    other.processManager?.unmount();
  }
  session.fileManager?.mount();
  session.fileTree?.mount();
  session.processManager?.mount();
  // The file panel is shared DOM too, so its page follows the new owner.
  filePage?.setManager(session.fileManager);
  // Throughput, uptime and friend widgets are one set on screen: drop the old
  // session's readings so its numbers are never read as the new one's.
  resetNetworkMetric();
  updateUptime();
}

/** Bring a session to the front: it becomes the only visible instance. */
function activateSession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  if (sessions.activeIdOrNull !== id) sessions.activate(id);
  // Everything below that reads `ctx` (status line, event log, resource meters)
  // follows the session being looked at.
  setFrontSession(session);
  session.terminal.focus();
}

/** Tabs earn their row only while something is live, or when several exist. */
function renderSessionTabs(): void {
  const live = sessions.list().filter((session) => session.state !== 'idle' || sessions.size > 1);
  sessionTabBar.render(live, sessions.activeIdOrNull);
}

/**
 * Closing a tab drops that one session's SSH connection; its context is retired
 * by `retireSession()` once teardown settles, and every other session — along
 * with their SFTP transfers and process polling — keeps running.
 */
function closeSessionTab(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  // `error` also needs the teardown — its socket is already gone but the
  // timers, auxiliary channels and UI state still have to be released.
  if (session.state !== 'idle') closeSession(session, bilingual('已关闭会话标签', 'Session tab closed'));
  renderSessionTabs();
}

function updateRevealPasswordButton(): void {
  const revealed = ui.password.type === 'text';
  ui.revealPassword.setAttribute('aria-pressed', revealed ? 'true' : 'false');
  ui.revealPassword.setAttribute('aria-label', revealed
    ? bilingual('隐藏密码', 'Hide password')
    : bilingual('显示密码', 'Show password'));
}

function applyLanguage(language: Language, persist = false): void {
  currentLanguage = language;
  document.documentElement.lang = language;
  document.documentElement.dataset.language = language;

  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-zh][data-i18n-en]')) {
    node.textContent = language === 'zh-CN' ? node.dataset.i18nZh! : node.dataset.i18nEn!;
  }
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-placeholder-zh][data-i18n-placeholder-en]')) {
    node.setAttribute('placeholder', language === 'zh-CN' ? node.dataset.i18nPlaceholderZh! : node.dataset.i18nPlaceholderEn!);
  }
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-aria-label-zh][data-i18n-aria-label-en]')) {
    node.setAttribute('aria-label', language === 'zh-CN' ? node.dataset.i18nAriaLabelZh! : node.dataset.i18nAriaLabelEn!);
  }
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-title-zh][data-i18n-title-en]')) {
    node.setAttribute('title', language === 'zh-CN' ? node.dataset.i18nTitleZh! : node.dataset.i18nTitleEn!);
  }
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-content-zh][data-i18n-content-en]')) {
    node.setAttribute('content', language === 'zh-CN' ? node.dataset.i18nContentZh! : node.dataset.i18nContentEn!);
  }

  const toggleLabel = language === 'zh-CN' ? '切换到英文' : 'Switch to Chinese';
  ui.languageToggle.dataset.language = language;
  ui.languageToggle.setAttribute('aria-label', toggleLabel);
  ui.languageToggle.title = toggleLabel;
  updateRevealPasswordButton();
  if (!ui.keyFile.files?.length) ui.keyFileName.textContent = bilingual('未选择文件', 'No file selected');
  ui.sessionSubtitle.textContent = localize(ctx.subtitle);
  ui.eventMessage.textContent = localize(ctx.eventMessage);
  if (currentFormError && !ui.formError.hidden) ui.formError.textContent = localize(currentFormError);
  for (const line of ui.eventLog.querySelectorAll<HTMLElement>('.event-line')) {
    const category = line.dataset.category ?? 'session';
    const label = line.querySelector<HTMLElement>('strong');
    const copy = line.querySelector<HTMLElement>('span');
    if (label) label.textContent = EVENT_LABELS[category] ? translate(EVENT_LABELS[category]) : bilingual('SSH 事件', category);
    if (copy?.dataset.messageZh && copy.dataset.messageEn) {
      copy.textContent = bilingual(copy.dataset.messageZh, copy.dataset.messageEn);
    }
  }
  if (ctx.fileManager) ctx.fileManager.setLanguage();
  if (ctx.fileTree) ctx.fileTree.setLanguage();
  if (ctx.processManager) ctx.processManager.setLanguage();
  terminalTools?.refreshLanguage();

  if (persist) {
    try { localStorage.setItem(LANGUAGE_STORAGE_KEY, language); } catch { /* Language still applies for this page. */ }
  }
}

let profiles: SavedProfile[] = [];
let dashboard: Dashboard | undefined;
let keychain: Keychain;
let filePage: FilePage | undefined;
let hostKeys: Record<string, string> = {};
// Rendering-only state that genuinely belongs to the page, not to a session.
let currentFormError: LocalizedMessage | null = null;
let passwordDirty = false;
let panelOpen = false;
let terminalTools: TerminalToolsController | undefined;
let historyPasswordLoading = false;
let historyPasswordLoadGeneration = 0;
let historyMutationSequence = 0;
let keyFileReadGeneration = 0;
let profileSaveTask: Promise<void> = Promise.resolve();
const latestHistoryMutation = new Map<string, number>();

// Session registry. `ctx` is whichever session is bound to the UI right now;
// every shared widget (terminal stage aside, the event log, the status bar, the
// resource block) answers to it and to nothing else. The other contexts stay
// alive in the registry — each owns its socket, auxiliary channels, terminal
// and managers — and the handlers below always capture their own session, so a
// background connection can never write into the session being looked at.
const sessions = new SessionManager();
let ctx: SessionContext = sessions.create();

/** True when `session` owns the shared UI, i.e. its events may repaint widgets. */
function isFront(session: SessionContext): boolean {
  return ctx === session;
}

// Per-connection throughput state now lives on SessionContext (one baseline map
// and ring buffer per session, so a second connection never produces a bogus
// one-shot rate spike). The helpers below read and write `ctx.*`.

const NET_RATE_UNITS = ['B', 'KB', 'MB', 'GB'] as const;

function formatNetworkRate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B/s';
  let v = value;
  let unitIndex = 0;
  while (v >= 1024 && unitIndex < NET_RATE_UNITS.length - 1) {
    v /= 1024;
    unitIndex += 1;
  }
  const text = v < 10 ? v.toFixed(1) : v.toFixed(0);
  return `${text}${NET_RATE_UNITS[unitIndex]}/s`;
}

function drawNetworkSparkline(): void {
  const canvas = ui.resourceNetworkSparkline;
  const dpr = window.devicePixelRatio && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  // Use clientWidth (CSS px) scaled by DPR for the backing store, so the
  // bitmap stays crisp on Hi-DPI displays without forcing the parent layout.
  const cssWidth = canvas.clientWidth || 184;
  const cssHeight = canvas.clientHeight || 22;
  const width = Math.max(1, Math.round(cssWidth * dpr));
  const height = Math.max(1, Math.round(cssHeight * dpr));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const surface = canvas.getContext('2d');
  if (!surface) return;
  surface.clearRect(0, 0, width, height);
  if (ctx.netSparkFilled === 0) return;
  // Build a chronological copy so the rest of the math is index-stable.
  const data = new Array<number>(NET_SPARK_POINTS).fill(0);
  const start = ctx.netSparkFilled < NET_SPARK_POINTS ? 0 : ctx.netSparkIdx;
  for (let i = 0; i < NET_SPARK_POINTS; i += 1) {
    data[i] = ctx.netSpark[(start + i) % NET_SPARK_POINTS];
  }
  let minimum = data[0];
  let maximum = data[0];
  for (const v of data) {
    if (v < minimum) minimum = v;
    if (v > maximum) maximum = v;
  }
  // `span = max(mx - mn, 1)` keeps the bar heights defined even when every
  // sample is identical (all bars collapse to the zero-line without div-by-zero).
  const span = Math.max(maximum - minimum, 1);
  const slot = width / NET_SPARK_POINTS;
  // Leave a small gap between bars; floor so a 1px slot still draws a visible bar.
  const barWidth = Math.max(1, Math.floor(slot * 0.7));
  surface.fillStyle = currentColorScheme() === 'light' ? '#0f7a58' : '#69e6b4';
  for (let i = 0; i < NET_SPARK_POINTS; i += 1) {
    const value = data[i];
    const normalized = (value - minimum) / span;
    const barHeight = Math.max(1, Math.round(normalized * (height - 1)));
    const x = Math.round(i * slot + ((slot - barWidth) / 2));
    const y = height - barHeight;
    surface.fillRect(x, y, barWidth, barHeight);
  }
}

// Rebuilds the `<select>` options only when the interface list changed, so a
// rapid tick cannot recreate the element under an open dropdown (which would
// drop focus). The iface label always follows the currently selected interface.
function syncNetworkSelectOptions(): void {
  const select = ui.resourceNetworkSelect;
  const existing = Array.from(select.options).map((option) => option.value);
  const unchanged = existing.length === ctx.netIfaceList.length
    && existing.every((value, index) => value === ctx.netIfaceList[index]);
  if (unchanged) return;
  select.replaceChildren();
  for (const iface of ctx.netIfaceList) {
    const option = document.createElement('option');
    option.value = iface;
    option.textContent = iface;
    select.append(option);
  }
}

// Reflects the current interface list / selection in the toolbar: a single
// interface keeps the plain-text label, two or more reveal the native select
// (which itself displays the chosen interface name, so the redundant
// plain-text label is hidden while the select is shown).
function updateNetworkIfaceLabel(): void {
  const select = ui.resourceNetworkSelect;
  const multi = ctx.netIfaceList.length > 1;
  ui.resourceNetworkIface.textContent = ctx.netSelectedIface ?? '-';
  ui.resourceNetworkIface.hidden = multi;
  select.hidden = !multi;
  if (multi) {
    syncNetworkSelectOptions();
    select.value = ctx.netSelectedIface ?? '';
  }
}

// Sole entry point for resetting the rate baseline. Called on interface
// switch (manual or automatic fallback) and on full teardown; do NOT clear
// baseline state by hand anywhere else.
function resetNetworkBaseline(): void {
  ctx.netBaselines.clear();
  ctx.netSpark.fill(0);
  ctx.netSparkIdx = 0;
  ctx.netSparkFilled = 0;
  drawNetworkSparkline();
  ui.resourceNetworkRateUp.textContent = `↑ ${formatNetworkRate(0)}`;
  ui.resourceNetworkRateDown.textContent = `↓ ${formatNetworkRate(0)}`;
}

function updateNetworkMetric(samples: NetworkSample[] | null, timestamp: number): void {
  if (!samples || samples.length === 0) {
    // The server may briefly stop sending a network section (e.g. busybox
    // sh without /sys/class/net). Don't tear down the toolbar block on a
    // single missing tick — only reset on a full teardown. The next valid
    // sample will overwrite the UI state.
    return;
  }
  if (ui.resourceNetwork.hidden) ui.resourceNetwork.hidden = false;

  // Deduplicated, order-preserving interface list for this tick. A tick may
  // carry the same interface twice (server fallback); only the first
  // occurrence is kept so the selector stays stable.
  const list: string[] = [];
  const seen = new Set<string>();
  for (const sample of samples) {
    if (seen.has(sample.iface)) continue;
    seen.add(sample.iface);
    list.push(sample.iface);
  }
  ctx.netIfaceList = list;

  // Resolve the selected interface: keep the user's choice while it is still
  // present, otherwise fall back to eth0 (or the first interface in order).
  const previousSelection = ctx.netSelectedIface;
  if (ctx.netSelectedIface === null || !ctx.netIfaceList.includes(ctx.netSelectedIface)) {
    ctx.netSelectedIface = ctx.netIfaceList.includes('eth0') ? 'eth0' : ctx.netIfaceList[0];
  }
  if (ctx.netSelectedIface !== previousSelection) {
    // Interface changed (user switch or automatic fallback): a fresh baseline
    // prevents a bogus one-shot rate spike across different counters.
    resetNetworkBaseline();
  }

  // Prune baselines for interfaces that disappeared (e.g. cable unplugged).
  for (const iface of ctx.netBaselines.keys()) {
    if (!ctx.netIfaceList.includes(iface)) ctx.netBaselines.delete(iface);
  }

  const selected = ctx.netSelectedIface;
  const sample = samples.find((entry) => entry.iface === selected);
  if (!sample) {
    // The selected interface is absent from this tick (mid-switch); keep the
    // current UI until the next tick provides it again.
    return;
  }

  const baseline = ctx.netBaselines.get(selected);
  if (!baseline) {
    // First sample for the selected interface: stash the counters and
    // timestamp; rate and sparkline both show zero until we have a second
    // sample to diff against.
    ctx.netBaselines.set(selected, { rx: sample.rxBytes, tx: sample.txBytes, ts: timestamp });
    drawNetworkSparkline();
    ui.resourceNetworkRateUp.textContent = `↑ ${formatNetworkRate(0)}`;
    ui.resourceNetworkRateDown.textContent = `↓ ${formatNetworkRate(0)}`;
    updateNetworkIfaceLabel();
    return;
  }

  // `timestamp` is in milliseconds; clamp to a tiny positive value so a
  // pathological zero/negative delta (rare clock skew) cannot divide-by-zero
  // or produce an infinite rate.
  const deltaSeconds = Math.max(0.001, (timestamp - baseline.ts) / 1000);
  const deltaRx = Math.max(0, sample.rxBytes - baseline.rx);
  const deltaTx = Math.max(0, sample.txBytes - baseline.tx);
  const rxRate = deltaRx / deltaSeconds;
  const txRate = deltaTx / deltaSeconds;
  ctx.netBaselines.set(selected, { rx: sample.rxBytes, tx: sample.txBytes, ts: timestamp });
  // Use the larger of the two rates as the sparkline magnitude so a
  // quiescent direction doesn't make the chart look half-dead.
  const magnitude = Math.max(rxRate, txRate);
  ctx.netSpark[ctx.netSparkIdx] = magnitude;
  ctx.netSparkIdx = (ctx.netSparkIdx + 1) % NET_SPARK_POINTS;
  if (ctx.netSparkFilled < NET_SPARK_POINTS) ctx.netSparkFilled += 1;
  drawNetworkSparkline();
  // `↑` = upload (tx), `↓` = download (rx) — match the toolbar arrow convention.
  ui.resourceNetworkRateUp.textContent = `↑ ${formatNetworkRate(txRate)}`;
  ui.resourceNetworkRateDown.textContent = `↓ ${formatNetworkRate(rxRate)}`;
  updateNetworkIfaceLabel();
}

function resetNetworkMetric(): void {
  // Idempotent: only touch the DOM / state if the block is currently visible
  // or still carries live state, so repeated resets (one per
  // ctx.processManager.reset() call site) are cheap.
  if (ui.resourceNetwork.hidden && ctx.netSelectedIface === null && ctx.netBaselines.size === 0) return;
  ui.resourceNetwork.hidden = true;
  ctx.netIfaceList = [];
  ctx.netSelectedIface = null;
  const select = ui.resourceNetworkSelect;
  select.replaceChildren();
  select.hidden = true;
  // Restore the default single-card presentation: the plain-text label is
  // visible again and the select is hidden, so a fresh session starts from a
  // clean state regardless of the previous multi-card visibility toggle.
  ui.resourceNetworkIface.hidden = false;
  ui.resourceNetworkIface.textContent = '-';
  resetNetworkBaseline();
}

// Terminal + auxiliary channels belong to the session, so every context gets
// its own set here. The xterm host lives in `#terminal-stage` and is created per
// session by `mountTerminal()`; the panel managers stay inert until
// `mountSessionPanels()` publishes them, which is what lets several sessions
// share one panel DOM without seeing each other's rows.
function attachSessionRuntime(session: SessionContext): void {
  session.terminal = new Terminal({
    allowProposedApi: false,
    convertEol: false,
    cursorBlink: true,
    cursorStyle: 'block',
    fontFamily: 'Cascadia Code, SFMono-Regular, Consolas, Liberation Mono, monospace',
    fontSize: 13,
    lineHeight: 1.18,
    letterSpacing: 0,
    scrollback: 10_000,
    tabStopWidth: 8,
    theme: terminalTheme(),
  });
  session.fitAddon = new FitAddon();
  session.terminal.loadAddon(session.fitAddon);
  session.terminal.loadAddon(new WebLinksAddon());
  session.terminal.onData((data) => terminalTools?.handleTerminalData(data));
  // Open against the session's own host instead of a page-wide `#terminal` node,
  // so a second session can get a sibling host inside the same stage.
  mountTerminal(session);
  // The callbacks below feed widgets owned by whoever is in front, so a
  // background session's SFTP/status chatter never reaches them.
  session.fileManager = new FileManager({
    elements: collectFileManagerElements(),
    getLanguage: () => currentLanguage,
    onError: (message) => { if (isFront(session)) event(message, 'sftp', true); },
    onStatus: (message) => { if (isFront(session)) event(message, 'sftp'); },
  });
  session.fileTree = new FileTree({
    container: ui.fileTree,
    fetchEntries: (path) => session.fileManager.fetchDirectoryEntries(path),
    getLanguage: () => currentLanguage,
    onNavigate: (path) => session.fileManager.navigate(path),
    onError: (message) => { if (isFront(session)) event(message, 'sftp', true); },
    initialRoot: '/',
  });
  session.fileManager.onCwdChange((cwd) => session.fileTree.setCwd(cwd));
  session.processManager = new ProcessManager({
    elements: collectProcessManagerElements(),
    getLanguage: () => currentLanguage,
    onError: (message) => { if (isFront(session)) event(message, 'process', true); },
    onReconnect: (zh, en) => { if (isFront(session)) event(bilingual(zh, en), 'process'); },
    onToast: (zh, en, kind) => { if (isFront(session)) toast(bilingual(zh, en), kind); },
    // One throughput graph on screen: only the visible session feeds it.
    onNetworkSample: (sample, timestamp) => { if (isFront(session)) updateNetworkMetric(sample, timestamp); },
  });
}

/** Fresh registry entry plus everything that lives per connection. */
function createSession(): SessionContext {
  const session = sessions.create();
  attachSessionRuntime(session);
  return session;
}

/**
 * The registry always keeps one empty placeholder alive so the workspace has a
 * terminal to write into. Adopting an existing connection has to grow it around
 * that placeholder rather than adding a second entry — otherwise one shell is
 * drawn as two tabs, one of them empty.
 */
function claimPlaceholderSession(): SessionContext {
  const placeholder = sessions
    .all()
    .find((candidate) => candidate.state === 'idle' && !candidate.socket && !candidate.backendSessionId);
  return placeholder ?? createSession();
}

attachSessionRuntime(ctx);
terminalTools = createTerminalTools({
  send: sendTerminalData,
  focusTerminal: () => ctx.terminal.focus(),
  refitTerminal: () => fitTerminal(true),
  localize: bilingual,
});
// Every session's panels start unmounted; whichever one is in front claims them.
mountSessionPanels(ctx);
// Registry changes that happen outside the connect flow — a retired tab, a
// dashboard action later on — still have to reach every session surface.
window.addEventListener(SESSION_EVENT, () => refreshSessionSurfaces());

/** Tab strip plus the file page picker: both list the live sessions. */
function refreshSessionSurfaces(): void {
  renderSessionTabs();
  filePage?.refreshSessions();
}

type ColorScheme = 'dark' | 'light';

function currentColorScheme(): ColorScheme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

// Declared as function bodies (not module-level consts) because `ctx.terminal` is
// constructed above and reads this palette during module evaluation.
function terminalTheme(scheme: ColorScheme = currentColorScheme()): Record<string, string> {
  if (scheme === 'light') {
    return {
      background: '#ffffff',
      foreground: '#1b2a30',
      cursor: '#0f7a58',
      cursorAccent: '#ffffff',
      selectionBackground: '#c7e8da',
      black: '#25343b',
      red: '#c63d4b',
      green: '#12825f',
      yellow: '#a86c0c',
      blue: '#246da8',
      magenta: '#7b3fa8',
      cyan: '#0f7285',
      white: '#4a5c64',
      brightBlack: '#6b8089',
      brightRed: '#e05a68',
      brightGreen: '#2aa37a',
      brightYellow: '#c98a1e',
      brightBlue: '#3d8fd0',
      brightMagenta: '#9b5fd0',
      brightCyan: '#1b97ad',
      brightWhite: '#0f2027',
    };
  }
  return {
    background: '#080d12',
    foreground: '#d7e2e6',
    cursor: '#69e6b4',
    cursorAccent: '#080d12',
    selectionBackground: '#294b43',
    black: '#121b22',
    red: '#ff7b82',
    green: '#69e6b4',
    yellow: '#f5c76b',
    blue: '#70b7ff',
    magenta: '#c69cff',
    cyan: '#67d8e7',
    white: '#d7e2e6',
    brightBlack: '#647782',
    brightRed: '#ff9a9f',
    brightGreen: '#94f2ca',
    brightYellow: '#ffe09b',
    brightBlue: '#a4d2ff',
    brightMagenta: '#ddc1ff',
    brightCyan: '#99edf5',
    brightWhite: '#f7fbfc',
  };
}

function applyTerminalTheme(): void {
  ctx.terminal.options.theme = terminalTheme();
  drawNetworkSparkline();
}

function passwordContext(profile: Pick<SavedProfile, 'host' | 'port' | 'username'>): string {
  return historyKey(profile.host, profile.port, profile.username);
}

async function loadProfiles(): Promise<SavedProfile[]> {
  const saved = await listHosts();
  hostKeys = Object.fromEntries(saved.filter((host) => host.fingerprint).map((host) => [passwordContext(host), host.fingerprint]));
  return saved;
}

async function persistHistoryMutation(mutation: HistoryMutation): Promise<HistoryMutationResult> {
  try {
    if (mutation.kind === 'upsert') {
      const profile = mutation.profile;
      const existing = profiles.find((host) => host.id === profile.id);
      await saveHost(profile, existing?.id);
    } else {
      const profile = profiles.find((host) => passwordContext(host) === mutation.target);
      if (profile) await removeHost(profile.id);
    }
    profiles = await loadProfiles();
    return { persisted: true, applied: true };
  } catch {
    return { persisted: false, applied: false };
  }
}

async function replaceRememberedHostKey(target: string, fingerprint: string): Promise<void> {
  hostKeys[target] = fingerprint;
  const profile = profiles.find((host) => passwordContext(host) === target);
  if (!profile) return;
  try {
    await saveHost({ ...profile, fingerprint }, profile.id);
    profiles = await loadProfiles();
  } catch {
    toast(bilingual('当前连接已接受指纹，但云端保存失败。', 'Fingerprint accepted for this session, but cloud saving failed.'), 'error');
  }
  renderProfiles();
}

function authMethod(): AuthMethod {
  const checked = ui.form.querySelector<HTMLInputElement>('input[name="authMethod"]:checked');
  return checked?.value === 'password' ? 'password' : 'publickey';
}

function usesKeychain(): boolean { return ui.form.querySelector<HTMLInputElement>('input[name="authMethod"]:checked')?.value === 'keychain'; }

function setAuthMethod(method: AuthMethod | 'keychain'): void {
  const radio = ui.form.querySelector<HTMLInputElement>(`input[name="authMethod"][value="${method}"]`);
  if (radio) radio.checked = true;
  ui.passwordField.hidden = method !== 'password';
  ui.keyField.hidden = method !== 'publickey';
  ui.keychainField.hidden = method !== 'keychain';
  // 「上传私钥」与「密钥链」两种公钥方式都要能填口令
  ui.keyPassphraseField.hidden = method !== 'publickey' && method !== 'keychain';
  ui.keychainId.required = method === 'keychain';
}

function cancelHistoryPasswordLoad(): void {
  if (!historyPasswordLoading) return;
  historyPasswordLoadGeneration++;
  historyPasswordLoading = false;
  setState(ctx.state);
}

function resetPasswordField(): void {
  ui.password.value = '';
  ui.password.type = 'password';
  passwordDirty = false;
  updateRevealPasswordButton();
}

function clearPrivateKeyFields(): void {
  keyFileReadGeneration++;
  ui.privateKey.value = '';
  ui.keyFile.value = '';
  ui.keyFileName.textContent = bilingual('未选择文件', 'No file selected');
}

function clearCredentials(): void {
  resetPasswordField();
  clearPrivateKeyFields();
  ui.keychainId.value = '';
  // 不同主机的口令必须隔离，否则切到未加密/其他口令的主机会带着上一个主机的口令发出去。
  ui.keyPassphrase.value = '';
}

// A stale async history-password decrypt must never overwrite the form. The
// connection lifecycle keeps the entered credentials in place (history can
// restore them anyway), so only the in-flight load is invalidated here.
function invalidateHistoryPasswordLoad(): void {
  historyPasswordLoadGeneration++;
  historyPasswordLoading = false;
}

function normalizeHost(host: string): string {
  return normalizeHostAddress(host);
}

function targetKey(host = normalizeHost(ui.host.value), port = Number(ui.port.value), username = ui.username.value.trim()): string {
  return sessionTargetKey(host, port, username);
}

function targetLabel(host: string, port: number, username: string): string {
  return sessionTargetLabel(host, port, username);
}

function applyFormDefaults(): void {
  if (!ui.username.value.trim()) ui.username.value = 'root';
  if (!ui.port.value.trim() && !ui.port.validity.badInput) ui.port.value = '22';
}

function readProfileFromForm(password: string): Promise<SavedProfile> {
  applyFormDefaults();
  if (password.length > 4096) throw new Error(bilingual('密码不能超过 4096 个字符。', 'Password cannot exceed 4096 characters.'));
  const host = normalizeHost(ui.host.value);
  const port = Number(ui.port.value);
  const username = ui.username.value.trim();
  const existing = profiles.find((item) => targetKey(item.host, item.port, item.username) === targetKey(host, port, username));
  const profile: SavedProfile = {
    id: existing?.id ?? crypto.randomUUID(),
    name: existing?.name ?? host,
    group: existing?.group ?? '个人',
    location: existing?.location ?? null,
    system: existing?.system ?? null,
    hasCredential: true,
    host,
    port,
    username,
    authMethod: authMethod(),
    initialCommand: ui.initialCommand.value,
    termType: ui.termType.value,
    encoding: ui.encoding.value,
    fingerprint: ui.fingerprint.value.trim(),
    updatedAt: Date.now(),
  };
  if (profile.authMethod === 'password') profile.password = password;
  else if (usesKeychain()) profile.keychainId = ui.keychainId.value;
  else profile.privateKey = ui.privateKey.value;
  if (profile.authMethod === 'publickey') profile.keyPassphrase = ui.keyPassphrase.value;
  return Promise.resolve(profile);
}

function validateProfileFields(): string | null {
  applyFormDefaults();
  const host = normalizeHost(ui.host.value);
  const port = Number(ui.port.value);
  const username = ui.username.value.trim();
  if (!host || host.length > 253 || /[\s/?#]/.test(host)) return bilingual('请输入有效的主机名或 IP 地址。', 'Enter a valid hostname or IP address.');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return bilingual('端口必须介于 1 和 65535 之间。', 'Port must be between 1 and 65535.');
  if (!username || username.length > 128 || /[\r\n\0]/.test(username)) return bilingual('请输入有效的 SSH 用户名。', 'Enter a valid SSH username.');
  const fingerprint = ui.fingerprint.value.trim();
  if (fingerprint && !SSH_FINGERPRINT_RE.test(fingerprint)) return bilingual('主机指纹必须使用 SHA256:base64 格式。', 'Host fingerprint must use the SHA256:base64 format.');
  return null;
}

function validateConnection(): string | null {
  const profileError = validateProfileFields();
  if (profileError) return profileError;
  if (usesKeychain()) {
    if (!ui.keychainId.value) return bilingual('请选择密钥链中的密钥。', 'Select a saved key.');
  } else if (authMethod() === 'publickey') {
    const key = ui.privateKey.value.trim();
    if (!key) return bilingual('请粘贴或选择 OpenSSH 私钥。', 'Paste or choose an OpenSSH private key.');
    if (new TextEncoder().encode(key).length > MAX_KEY_BYTES) return bilingual('私钥大于 64 KiB。', 'The private key is larger than 64 KiB.');
    if (!key.includes('BEGIN OPENSSH PRIVATE KEY')) return bilingual('仅支持 OpenSSH 私钥。', 'Only OpenSSH private keys are supported.');
  }
  return null;
}

function validateConnectForm(): string | null {
  applyFormDefaults();
  const browserInvalid = [...ui.form.elements].find((control): control is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement =>
    control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement
      ? !control.validity.valid
      : false);
  if (browserInvalid) return bilingual('请检查必填项和字段格式。', 'Check the required fields and their formats.');
  return validateConnection();
}

async function applyProfile(profile: SavedProfile): Promise<void> {
  const loadGeneration = ++historyPasswordLoadGeneration;
  const context = passwordContext(profile);
  clearCredentials();
  ui.profileId.value = profile.id;
  ui.host.value = profile.host;
  ui.port.value = String(profile.port);
  ui.username.value = profile.username;
  ui.initialCommand.value = profile.initialCommand;
  ui.termType.value = profile.termType;
  ui.encoding.value = profile.encoding;
  ui.fingerprint.value = profile.fingerprint || hostKeys[targetKey(profile.host, profile.port, profile.username)] || '';
  setAuthMethod(profile.keychainId ? 'keychain' : profile.authMethod);
  if (profile.keychainId) {
    fillKeychainSelect(ui.keychainId, keychain.keys, profile.keychainId);
    void keychain.load();
  }
  passwordDirty = false;
  historyPasswordLoading = true;
  setState(ctx.state);
  renderProfiles();
  let credentials: Credentials;
  try {
    credentials = await hostCredentials(profile.id);
  } catch (error) {
    if (loadGeneration === historyPasswordLoadGeneration) {
      historyPasswordLoading = false;
      setState(ctx.state);
    }
    throw error;
  }
  if (loadGeneration !== historyPasswordLoadGeneration) return;
  historyPasswordLoading = false;
  const selectionUnchanged = ui.profileId.value === profile.id
    && targetKey() === context
    && authMethod() === profile.authMethod
    && !passwordDirty;
  if (selectionUnchanged) {
    ui.password.value = credentials.password ?? '';
    ui.privateKey.value = credentials.privateKey ?? '';
    // 口令必须一并回填：终端页只对服务端发送私钥/密钥链引用，口令单独走 keyPassphrase 字段。
    // 漏掉这一项时加密私钥能保存也能「连接测试」通过，正式进终端却报「私钥已加密，请提供口令」。
    ui.keyPassphrase.value = credentials.keyPassphrase ?? '';
  }
  setState(ctx.state);
}

function clearForm(): void {
  historyPasswordLoadGeneration++;
  historyPasswordLoading = false;
  ui.form.reset();
  clearCredentials();
  ui.profileId.value = '';
  ui.port.value = '22';
  ui.username.value = 'root';
  ui.termType.value = 'xterm-256color';
  ui.encoding.value = 'utf-8';
  ui.fingerprint.value = '';
  ui.formError.hidden = true;
  currentFormError = null;
  setAuthMethod('password');
  setState(ctx.state);
  renderProfiles();
  ui.host.focus();
}

async function saveConnectedProfile(): Promise<void> {
  if (!ctx.pendingHistory || ctx.pendingHistory.generation !== ctx.generation) return;
  const operation = ctx.pendingHistory;
  ctx.pendingHistory = null;
  const connectedAt = Date.now();
  const mutation = ++historyMutationSequence;
  latestHistoryMutation.set(operation.target, mutation);
  let profile: SavedProfile;
  try {
    profile = await operation.profile;
  } catch {
    return;
  }
  if (passwordContext(profile) !== operation.target || latestHistoryMutation.get(operation.target) !== mutation) return;
  const key = targetKey(profile.host, profile.port, profile.username);
  const rememberedFingerprint = key === ctx.targetKey && ctx.rememberedFingerprint
    ? ctx.rememberedFingerprint
    : hostKeys[key] || profile.fingerprint || '';
  const saved: SavedProfile = {
    ...profile,
    fingerprint: rememberedFingerprint,
    updatedAt: connectedAt,
  };
  if (historyPasswordLoading && targetKey() === operation.target) {
    historyPasswordLoadGeneration++;
    historyPasswordLoading = false;
    setState(ctx.state);
  }
  const result = await persistHistoryMutation({ kind: 'upsert', profile: saved });
  if (!result.persisted) {
    renderProfiles();
    throw new Error('History persistence failed');
  }
  const retained = profiles.find((item) => passwordContext(item) === operation.target);
  if (targetKey() === operation.target && retained) ui.profileId.value = retained.id;
  renderProfiles();
  if (!result.applied) return;
  toast(bilingual('主机已加密保存至云端。', 'Host encrypted and saved to the cloud.'));
}

async function deleteProfile(id: string): Promise<void> {
  const removed = profiles.find((profile) => profile.id === id);
  if (!removed) return;
  const target = passwordContext(removed);
  latestHistoryMutation.set(target, ++historyMutationSequence);
  const result = await persistHistoryMutation({ kind: 'delete', target });
  if (!result.persisted) {
    renderProfiles();
    toast(bilingual('无法删除此历史记录。', 'This history entry could not be deleted.'), 'error');
    return;
  }
  if (targetKey() === target) clearForm();
  else renderProfiles();
}

function renderProfiles(): void {
  dashboard?.setHosts(profiles);
  // 名称和国旗来自主机列表，它可能比连接本身晚一步到达，所以每次重画都带上顶栏。
  renderSessionHeader();
  ui.profileList.replaceChildren();
  ui.profileCount.textContent = String(profiles.length);
  if (profiles.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-list';
    empty.textContent = bilingual('暂无历史记录', 'No connection history yet.');
    ui.profileList.append(empty);
    return;
  }

  for (const profile of profiles) {
    const card = document.createElement('div');
    card.className = `profile-card${profile.id === ui.profileId.value ? ' active' : ''}`;

    const main = document.createElement('button');
    main.className = 'profile-main';
    main.type = 'button';
    main.dataset.profileId = profile.id;
    // 与首页主机列表保持一致：图标用地区（国旗），并在 user@host:port 上方显示主机名称。
    const region = document.createElement('span');
    region.className = 'profile-avatar region';
    if (profile.location?.countryCode) {
      region.append(countryFlag(profile.location.countryCode));
      const place = profile.location.city || profile.location.region || profile.location.country;
      region.setAttribute('role', 'img');
      region.setAttribute('aria-label', [place, profile.location.country].filter(Boolean).join(' · '));
      region.title = [place, profile.location.region, profile.location.ip].filter(Boolean).join(' · ');
    } else {
      region.classList.add('unknown');
      region.textContent = '🌐';
      region.setAttribute('role', 'img');
      region.setAttribute('aria-label', bilingual('位置未知', 'Location unknown'));
      region.title = bilingual('位置未知', 'Location unknown');
    }
    const copy = document.createElement('span');
    copy.className = 'profile-copy';
    const label = targetLabel(profile.host, profile.port, profile.username);
    const displayName = profile.name?.trim() || label;
    const name = document.createElement('strong');
    name.className = 'profile-name';
    name.textContent = displayName;
    name.title = displayName;
    const address = document.createElement('span');
    address.className = 'profile-address';
    address.textContent = label;
    address.title = label;
    const lastConnected = document.createElement('time');
    const connectedAt = new Date(Math.min(profile.updatedAt, Date.now()));
    lastConnected.dateTime = connectedAt.toISOString();
    const formattedTime = new Intl.DateTimeFormat(currentLanguage, { dateStyle: 'medium', timeStyle: 'short' }).format(connectedAt);
    lastConnected.textContent = bilingual(`最后连接：${formattedTime}`, `Last connected: ${formattedTime}`);
    copy.append(name, address, lastConnected);
    main.append(region, copy);

    const remove = document.createElement('button');
    remove.className = 'profile-delete';
    remove.type = 'button';
    remove.dataset.deleteProfile = profile.id;
    remove.setAttribute('aria-label', bilingual(`删除 ${displayName}`, `Delete ${displayName}`));
    remove.textContent = '\u00d7';
    card.append(main, remove);
    ui.profileList.append(card);
  }
}

function readServerSystemInfo(value: unknown): HostSystemInfo | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const family = record.family;
  if (!['linux', 'darwin', 'freebsd', 'windows', 'unknown'].includes(String(family))) return null;
  const { distribution, name, version, architecture } = record;
  if (typeof distribution !== 'string' || typeof name !== 'string' || typeof version !== 'string' || typeof architecture !== 'string') return null;
  if (distribution.length > 40 || name.length > 120 || version.length > 80 || architecture.length > 32) return null;
  return {
    family: family as HostSystemInfo['family'],
    distribution,
    name,
    version,
    architecture,
  };
}

async function persistDetectedSystem(target: string, system: HostSystemInfo): Promise<void> {
  await profileSaveTask;
  const profile = profiles.find((item) => passwordContext(item) === target);
  if (!profile || JSON.stringify(profile.system) === JSON.stringify(system)) return;
  try {
    const updated = await updateHostSystem(profile.id, system);
    profiles = profiles.map((item) => item.id === updated.id ? { ...item, ...updated } : item);
    renderProfiles();
  } catch {
    toast(bilingual('系统信息已探测，但无法保存到主机记录。', 'System information was detected but could not be saved.'), 'error');
  }
}

function showFormError(message: string, alternate?: string): void {
  currentFormError = messageTranslation(message, alternate);
  ui.formError.textContent = localize(currentFormError);
  ui.formError.hidden = false;
  if (document.body.dataset.view === 'files') filePage?.setMessage(localize(currentFormError), true);
}

function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const item = document.createElement('div');
  item.className = `toast${kind === 'error' ? ' error' : ''}`;
  item.textContent = message;
  ui.toastRegion.append(item);
  window.setTimeout(() => item.remove(), 4_500);
}

/**
 * Whether the live session belongs to the target currently shown in the form.
 *
 * Selecting another entry from the cloud host list only refills the form — the
 * previous session stays online. Anything keyed off the global link state alone
 * (notably the connect button) would then offer "disconnect" for the *other*
 * host's session, so link state and form target must be checked together.
 */
function sessionOwnsFormTarget(): boolean {
  if (ctx.state !== 'connecting' && ctx.state !== 'connected' && ctx.state !== 'disconnecting') return false;
  return ctx.targetKey !== '' && ctx.targetKey === targetKey();
}

/** Paint the connect button for the host currently held by the form. */
function renderConnectControl(): void {
  const state: ConnectionState = sessionOwnsFormTarget() ? ctx.state : 'idle';
  const control = resolveConnectionControl(state, historyPasswordLoading);
  const controlLabel = control.action === 'cancel'
    ? bilingual('取消连接', 'Cancel connection')
    : control.action === 'disconnect'
      ? bilingual('断开', 'Disconnect')
      : control.action === 'disconnecting'
        ? bilingual('断开中...', 'Disconnecting...')
        : bilingual('连接', 'Connect');
  ui.connect.disabled = control.disabled;
  ui.connect.classList.toggle('is-danger', control.danger);
  ui.connect.dataset.action = control.action;
  ui.connect.querySelector<HTMLElement>('.button-icon')!.textContent = control.danger ? 'x' : '>_';
  ui.connect.querySelector<HTMLElement>('span:last-child')!.textContent = controlLabel;
  ui.connect.setAttribute('aria-label', controlLabel);
  ui.connect.title = ctx.backendSessionId || controlLabel;
}

function updateConnectionStatus(message: LocalizedMessage): void {
  ctx.subtitle = message;
  const text = localize(message);
  ui.sessionSubtitle.textContent = text;
  filePage?.setMessage(text);
  if (ctx.state === 'connecting' && sessionOwnsFormTarget()) {
    const btnSpan = ui.connect.querySelector<HTMLElement>('span:last-child');
    if (btnSpan) btnSpan.textContent = text;
  }
}

/**
 * Move one session to a new state. Only the front session repaints widgets;
 * everyone else just keeps its own summary (tab strip, dashboard badge) honest.
 */
function setSessionState(session: SessionContext, state: ConnectionState, label?: string): void {
  session.state = state;
  sessions.touch(session.id);
  // "What can the next page load ask the server for" is exactly "what is
  // connected right now", and this is the only place that answer changes.
  saveRestorableSessions(sessions.all());
  if (isFront(session)) setState(state, label);
  else renderSessionTabs();
}

function setState(state: ConnectionState, label?: string): void {
  ctx.state = state;
  ui.fullscreenFiles.disabled = state !== 'connected';
  filePage?.setConnection(state, profiles.find((profile) => passwordContext(profile) === ctx.targetKey)?.id, ctx.targetLabel);
  const stateLabel = label ?? localize(SESSION_STATE_LABEL[state]);
  ui.liveOrb.className = `live-orb ${state}`;
  ui.liveOrbLabel.textContent = stateLabel;
  ui.liveOrb.title = stateLabel;
  renderConnectControl();
  renderSessionTabs();
  terminalTools?.setConnected(state === 'connected');
}

function event(message: string, category = 'session', error = false, alternate?: string): void {
  const eventTranslation = messageTranslation(message, alternate);
  ctx.eventMessage = eventTranslation;
  ui.eventMessage.textContent = localize(ctx.eventMessage);
  const line = document.createElement('div');
  line.className = `event-line${error ? ' error' : ''}`;
  line.dataset.category = category;
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString([], { hour12: false });
  const type = document.createElement('strong');
  type.textContent = EVENT_LABELS[category] ? translate(EVENT_LABELS[category]) : bilingual('SSH 事件', category);
  const copy = document.createElement('span');
  copy.textContent = message;
  copy.dataset.messageZh = eventTranslation.zh;
  copy.dataset.messageEn = eventTranslation.en;
  // With several shells open the log mixes sessions: label whose it is.
  if (sessions.list().length > 1) {
    const tag = document.createElement('b');
    tag.className = 'event-session';
    tag.textContent = ctx.targetLabel;
    copy.prepend(tag);
  }
  line.append(time, type, copy);
  ui.eventLog.append(line);
  while (ui.eventLog.childElementCount > 100) ui.eventLog.firstElementChild?.remove();
  ui.eventLog.scrollTop = ui.eventLog.scrollHeight;
}

function fitTerminal(send = true): void {
  cancelAnimationFrame(ctx.resizeFrame);
  ctx.resizeFrame = requestAnimationFrame(() => {
    try {
      ctx.fitAddon.fit();
      // 握手完成前不能发 resize：此时服务端还没有会话，任何非 connect 消息都会被判成重复
      // 连接，进而把正在进行的握手一起掐断。进入终端必然会触发 ResizeObserver（布局变化），
      // 所以这个时序很容易命中；真实尺寸在 markReady 里补发一次。
      if (send && ctx.state === 'connected' && ctx.socket?.readyState === WebSocket.OPEN) {
        ctx.socket.send(JSON.stringify({ type: 'resize', cols: ctx.terminal.cols, rows: ctx.terminal.rows }));
      }
    } catch {
      // The ctx.terminal can be temporarily dimensionless during a panel drawer transition.
    }
  });
}

function setPanelOpen(open: boolean): void {
  const view = resolveConnectionPanel(open);
  panelOpen = view.expanded;
  if (!view.expanded && (ctx.state === 'connecting' || ctx.state === 'connected' || ctx.state === 'disconnecting')) {
    invalidateHistoryPasswordLoad();
  }
  if (!view.expanded && ui.panel.contains(document.activeElement)) ui.panelToggle.focus();
  ui.panel.classList.toggle('open', view.drawerOpen);
  ui.panel.inert = !view.expanded;
  ui.panel.setAttribute('aria-hidden', String(!view.expanded));
  ui.panelToggle.setAttribute('aria-expanded', String(view.expanded));
  const toggleLabel = view.expanded
    ? bilingual('折叠连接面板', 'Collapse connection panel')
    : bilingual('展开连接面板', 'Expand connection panel');
  ui.panelToggle.setAttribute('aria-label', toggleLabel);
  ui.panelToggle.title = toggleLabel;
  ui.panelScrim.hidden = !view.scrimVisible;
  requestAnimationFrame(() => fitTerminal(true));
}

function updateUptime(): void {
  if (!ctx.startedAt) {
    ui.metricUptime.textContent = '00:00';
    return;
  }
  const seconds = Math.max(0, Math.floor((Date.now() - ctx.startedAt) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  ui.metricUptime.textContent = hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function startTimers(session: SessionContext): void {
  stopTimers(session);
  session.startedAt = Date.now();
  // Ping every session so idle background shells stay alive; only the front one
  // paints the uptime readout, whose single widget answers to `ctx`.
  session.uptimeTimer = window.setInterval(() => {
    if (isFront(session)) updateUptime();
  }, 1_000);
  session.pingTimer = window.setInterval(() => {
    if (session.socket?.readyState !== WebSocket.OPEN) return;
    session.socket.send(JSON.stringify({ type: 'ping' }));
  }, PING_INTERVAL_MS);
  if (isFront(session)) updateUptime();
}

function stopTimers(session: SessionContext): void {
  if (session.uptimeTimer !== null) window.clearInterval(session.uptimeTimer);
  if (session.pingTimer !== null) window.clearInterval(session.pingTimer);
  session.uptimeTimer = null;
  session.pingTimer = null;
  session.startedAt = 0;
}

function markReady(session: SessionContext, message = bilingual('交互式 Shell 已就绪', 'Interactive shell ready')): void {
  if (session.state === 'connected') return;
  setSessionState(session, 'connected');
  startTimers(session);
  if (session.initialCommand && !session.initialCommandSent) {
    session.initialCommandSent = true;
    const command = session.initialCommand;
    const activeSocket = session.socket;
    const generation = session.generation;
    window.setTimeout(() => {
      if (session.socket !== activeSocket || generation !== session.generation) return;
      if (activeSocket?.readyState === WebSocket.OPEN) activeSocket.send(JSON.stringify({ type: 'input', data: `${command}\r` }));
    }, 120);
  }
  // Everything below owns a widget, so a session reconnecting in the background
  // stops here — it is already connected and must not repaint someone else's UI.
  if (!isFront(session)) return;
  invalidateHistoryPasswordLoad();
  setPanelOpen(false);
  profileSaveTask = saveConnectedProfile().catch(() => {
    toast(bilingual('连接成功，但无法更新历史记录。', 'Connected, but the history could not be updated.'), 'error');
  });
  updateConnectionStatus(messageTranslation(message));
  filePage?.setMessage('');
  event(message, 'ready');
  if (document.body.dataset.view === 'workspace') session.terminal.focus();
  // 补发真实尺寸：握手期间因为布局变化产生的 resize 都被抑制了，这里对齐一次。
  requestAnimationFrame(() => fitTerminal(true));
}

function sendHostKeyDecision(accept: boolean): void {
  if (!ctx.awaitingHostKeyDecision || !ctx.pendingHostKey || ctx.socket?.readyState !== WebSocket.OPEN) return;
  const hostKey = ctx.pendingHostKey;
  ctx.awaitingHostKeyDecision = false;
  ctx.pendingHostKey = null;
  ctx.socket.send(JSON.stringify({
    type: 'host_key_decision',
    accept,
    fingerprint: hostKey.fingerprint,
  }));
  if (accept && ui.rememberHostKey.checked && ctx.targetKey) {
    ctx.rememberedFingerprint = hostKey.fingerprint;
    void replaceRememberedHostKey(ctx.targetKey, hostKey.fingerprint);
    if (targetKey() === ctx.targetKey) ui.fingerprint.value = hostKey.fingerprint;
  }
  event(accept
    ? hostKey.trust === 'changed'
      ? bilingual('新的主机密钥已明确接受，可以继续认证。', 'The new host key was explicitly accepted; authentication may continue.')
      : bilingual('主机密钥已接受，可以继续认证。', 'Host key accepted; authentication may continue.')
    : bilingual('主机密钥已拒绝。', 'Host key rejected.'), 'host-key', !accept);
}

type WorkspaceTab = 'files' | 'processes' | 'log';
let activeWorkspaceTab: WorkspaceTab | null = null;

function setWorkspaceTab(tab: WorkspaceTab | null, focus = false, rovingTab = tab ?? activeWorkspaceTab ?? 'files'): void {
  const filesActive = tab === 'files';
  const processesActive = tab === 'processes';
  const logActive = tab === 'log';
  activeWorkspaceTab = tab;
  ui.terminalCard.classList.toggle('workspace-panel-open', tab !== null);
  ui.fileManagerPanel.hidden = !filesActive;
  ui.processManagerPanel.hidden = !processesActive;
  ui.eventLog.hidden = !logActive;
  ui.fileManagerTab.setAttribute('aria-selected', String(filesActive));
  ui.processManagerTab.setAttribute('aria-selected', String(processesActive));
  ui.eventToggle.setAttribute('aria-selected', String(logActive));
  ui.fileManagerTab.setAttribute('aria-expanded', String(filesActive));
  ui.processManagerTab.setAttribute('aria-expanded', String(processesActive));
  ui.eventToggle.setAttribute('aria-expanded', String(logActive));
  ui.fileManagerTab.tabIndex = rovingTab === 'files' ? 0 : -1;
  ui.processManagerTab.tabIndex = rovingTab === 'processes' ? 0 : -1;
  ui.eventToggle.tabIndex = rovingTab === 'log' ? 0 : -1;
  if (logActive) requestAnimationFrame(() => { ui.eventLog.scrollTop = ui.eventLog.scrollHeight; });
  if (focus) ({ files: ui.fileManagerTab, processes: ui.processManagerTab, log: ui.eventToggle })[rovingTab].focus();
  requestAnimationFrame(() => fitTerminal(true));
}

function toggleWorkspaceTab(tab: WorkspaceTab): void {
  setWorkspaceTab(activeWorkspaceTab === tab ? null : tab, false, tab);
}

function handleWorkspaceTabKey(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const tabs: WorkspaceTab[] = ['files', 'processes', 'log'];
  const current = tabs.findIndex((tab) => ({ files: ui.fileManagerTab, processes: ui.processManagerTab, log: ui.eventToggle })[tab] === event.currentTarget);
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? tabs.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  setWorkspaceTab(tabs[next], true);
}

function configureHostKeyDialog(hostKey: HostKeyPrompt): void {
  const changed = hostKey.trust === 'changed';
  ui.hostKeyDialog.classList.toggle('changed', changed);
  ui.hostKeyIcon.textContent = changed ? bilingual('警告', 'ALERT') : bilingual('密钥', 'KEY');
  ui.hostKeyEyebrow.textContent = changed
    ? bilingual('主机身份已变化', 'HOST IDENTITY CHANGED')
    : bilingual('主机身份', 'HOST IDENTITY');
  ui.hostKeyTitle.textContent = changed
    ? bilingual('SSH 主机密钥不匹配', 'SSH host key mismatch')
    : bilingual('信任此 SSH 主机？', 'Trust this SSH host?');
  ui.hostKeyDescription.textContent = changed
    ? bilingual(
      '服务器密钥与之前保存的指纹不同。这可能是正常换钥，也可能是中间人攻击。仅在通过可信渠道确认新指纹后继续。',
      'The server key differs from the saved fingerprint. This can be a legitimate rotation or a man-in-the-middle attack. Continue only after verifying the new fingerprint through a trusted channel.',
    )
    : bilingual(
      '服务器提供了尚未为此目标固定的密钥。继续前，请通过可信渠道核验。',
      'The server presented a key that has not been pinned for this target. Verify it through a trusted channel before continuing.',
    );
  ui.hostKeyExpectedRow.hidden = !changed;
  ui.hostKeyExpectedFingerprint.textContent = changed ? hostKey.expectedFingerprint : '--';
  ui.rememberHostKeyLabel.textContent = changed
    ? bilingual('替换并记住这个新指纹', 'Replace the saved fingerprint with this new one')
    : bilingual('下次记住并验证此指纹', 'Remember and verify this fingerprint next time');
  ui.acceptHostKey.textContent = changed
    ? bilingual('我已核验，替换并继续', 'Verified: replace & continue')
    : bilingual('信任并继续', 'Trust & continue');
}

let suppressHostKeyDialogClose = false;

function clearHostKeyPrompt(): void {
  ctx.awaitingHostKeyDecision = false;
  ctx.pendingHostKey = null;
  if (ui.hostKeyDialog.open) ui.hostKeyDialog.close('reject');
  ui.hostKeyDialog.returnValue = '';
}

/**
 * Collapses the prompt without answering it. Returning to the host overview
 * must not reject a host key on the user's behalf — the session stays paused
 * and the same prompt is re-shown when they come back.
 */
function hideHostKeyPrompt(): void {
  if (!ui.hostKeyDialog.open) return;
  suppressHostKeyDialogClose = true;
  ui.hostKeyDialog.close();
}

/**
 * Publishes a host-key confirmation request owned by the active session.
 * Extracted from `handleServerMessage` so the same prompt can be re-rendered
 * after the user visits the dashboard and returns.
 */
function showHostKeyPrompt(hostKey: HostKeyPrompt): void {
  ctx.pendingHostKey = hostKey;
  ctx.awaitingHostKeyDecision = true;
  renderHostKeyPrompt(hostKey);
  event(hostKey.trust === 'changed'
    ? bilingual(`认证已暂停：主机密钥从 ${hostKey.expectedFingerprint} 变为 ${hostKey.fingerprint}`, `Authentication paused: host key changed from ${hostKey.expectedFingerprint} to ${hostKey.fingerprint}`)
    : bilingual(`认证已暂停，请确认首次见到的主机密钥 ${hostKey.fingerprint}`, `Authentication paused for first-seen host key ${hostKey.fingerprint}`), 'host-key', hostKey.trust === 'changed');
}

/** Re-renders the dialog body from a persisted prompt, without re-logging it. */
function renderHostKeyPrompt(hostKey: HostKeyPrompt): void {
  configureHostKeyDialog(hostKey);
  ui.hostKeyTarget.textContent = ui.sessionTitle.textContent ?? ctx.targetKey;
  ui.hostKeyType.textContent = hostKey.keyType;
  ui.hostKeyFingerprint.textContent = hostKey.fingerprint;
  ui.rememberHostKey.checked = true;
  if (!ui.hostKeyDialog.open) {
    ui.hostKeyDialog.returnValue = '';
    ui.hostKeyDialog.showModal();
  }
}

/** Brings a still-pending prompt back after the workspace is re-entered. */
function restoreHostKeyPrompt(): void {
  if (!ctx.awaitingHostKeyDecision || !ctx.pendingHostKey) return;
  renderHostKeyPrompt(ctx.pendingHostKey);
}

function handleServerMessage(session: SessionContext, message: ServerMessage): void {
  const type = message.type ?? 'status';
  // Every widget below belongs to the front session, so a session reconnecting
  // in the background updates its own channels and stays silent here.
  const say: typeof event = isFront(session) ? event : () => undefined;
  const report: typeof updateConnectionStatus = isFront(session) ? updateConnectionStatus : () => undefined;
  if (type === 'system_info') {
    const system = readServerSystemInfo(message.system);
    if (!system) {
      say(bilingual('收到无效的系统探测结果。', 'Received an invalid system probe result.'), 'protocol', true);
      return;
    }
    const label = [system.name, system.version, system.architecture].filter(Boolean).join(' · ');
    say(bilingual(`已探测操作系统：${label}`, `Detected operating system: ${label}`), 'system');
    void persistDetectedSystem(session.targetKey, system);
    return;
  }
  if (type === 'sftp_attach') {
    if (typeof message.url !== 'string' || !message.url.startsWith('/api/sftp?')) {
      say(bilingual('收到无效的文件管理连接信息。', 'Received invalid file-management connection details.'), 'protocol', true);
      return;
    }
    try {
      session.fileManager.attach(message.url);
    } catch {
      say(bilingual('无法打开文件管理连接。', 'Could not open the file-management connection.'), 'sftp', true);
      return;
    }
    session.fileTree.setReady(true);
    say(bilingual('文件管理通道已可用。', 'File management channel is available.'), 'sftp');
    return;
  }
  if (type === 'process_attach') {
    if (typeof message.url !== 'string' || !message.url.startsWith('/api/processes?')) {
      say(bilingual('收到无效的进程监控连接信息。', 'Received invalid process-monitor connection details.'), 'protocol', true);
      return;
    }
    try {
      session.processManager.attach(message.url);
    } catch {
      say(bilingual('无法打开进程监控连接。', 'Could not open the process-monitor connection.'), 'process', true);
      return;
    }
    say(bilingual('进程监控通道已可用。', 'Process monitor channel is available.'), 'process');
    return;
  }
  if (type === 'host_key') {
    const fingerprint = message.fingerprint ?? '';
    const keyType = message.keyType ?? '';
    const expected = message.expectedFingerprint ?? session.expectedFingerprint;
    if (!SSH_FINGERPRINT_RE.test(fingerprint)
      || !/^[A-Za-z0-9@._+-]{1,128}$/.test(keyType)
      || typeof message.trusted !== 'boolean'
      || (expected !== '' && !SSH_FINGERPRINT_RE.test(expected))
      || (message.expectedFingerprint !== undefined && message.expectedFingerprint !== session.expectedFingerprint)) {
      say(bilingual('收到无效的主机密钥消息。', 'Received an invalid host key message.'), 'protocol', true);
      session.socket?.close(CLIENT_CLOSE_PROTOCOL_ERROR, 'Invalid host key message');
      return;
    }
    if (isFront(session)) {
      ui.metricHostKey.textContent = keyType.replace('ssh-', '').replace('ecdsa-sha2-', '');
      ui.metricHostKey.title = fingerprint;
    }
    const trust = classifyHostKey(expected, fingerprint);
    if (message.trusted !== (trust === 'matched')) {
      say(bilingual('收到不一致的主机密钥信任消息。', 'Received an inconsistent trusted host key message.'), 'protocol', true);
      session.socket?.close(CLIENT_CLOSE_PROTOCOL_ERROR, 'Invalid trusted host key message');
      return;
    }
    if (trust === 'matched') {
      say(bilingual('已固定的主机密钥匹配。', 'Pinned host key matched.'), 'host-key');
      return;
    }
    // A trust question can only be answered by the session the user can see.
    if (isFront(session)) showHostKeyPrompt({ fingerprint, keyType, expectedFingerprint: expected, trust });
    return;
  }
  if (type === 'ready') {
    markReady(session, bilingualServerMessage(message.message, message.event ?? 'ready', 'Interactive shell ready'));
    return;
  }
  if (type === 'error') {
    const text = bilingualServerMessage(message.message, message.event, 'The SSH session failed.', 'SSH 错误');
    const failedSocket = session.socket;
    say(text, message.event ?? 'error', true);
    if (isFront(session)) {
      showFormError(text);
      toast(text, 'error');
    }
    if (message.retryable === false) {
      // 客户端随后以 4000 关闭会遮住服务端关闭码，先停止重连才能避免重试旧凭据。
      session.reconnectManager?.reset();
      session.reconnectManager = null;
      session.reconnectParams = null;
    }
    failActiveConnection(session, failedSocket, 'SSH session failed', messageTranslation(text));
    return;
  }
  if (type === 'debug') {
    say(bilingualServerMessage(message.message, message.event, 'Debug event'), 'debug');
    return;
  }
  if (type === 'status') {
    const text = bilingualServerMessage(message.message, message.event, 'SSH handshake in progress');
    say(text, message.event ?? 'status');
    report(messageTranslation(text));
    if (message.event === 'shell_ready' || message.event === 'ready') markReady(session, text);
  }
}

async function handleSocketData(session: SessionContext, data: string | ArrayBuffer | Blob, activeSocket: WebSocket, generation: number): Promise<void> {
  if (session.socket !== activeSocket || generation !== session.generation) return;
  const say: typeof event = isFront(session) ? event : () => undefined;
  if (typeof data === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      say(bilingual('已忽略无效的控制帧。', 'Ignored an invalid control frame.'), 'protocol', true);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      say(bilingual('已忽略无效的控制帧。', 'Ignored an invalid control frame.'), 'protocol', true);
      return;
    }
    try {
      handleServerMessage(session, parsed as ServerMessage);
    } catch {
      say(bilingual('处理服务器控制消息时发生错误。', 'Failed to process the server control message.'), 'protocol', true);
      if (activeSocket.readyState < WebSocket.CLOSING) {
        activeSocket.close(CLIENT_CLOSE_PROTOCOL_ERROR, 'Control message handling failed');
      }
    }
    return;
  }
  const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data);
  if (session.socket !== activeSocket || generation !== session.generation) return;
  // Terminal output always lands in this session's own xterm host, hidden or not.
  if (session.decoder.encoding === 'utf-8') session.terminal.write(bytes);
  else session.terminal.write(session.decoder.decode(bytes, { stream: true }));
}

function sendTerminalData(data: string): void {
  if (ctx.socket?.readyState !== WebSocket.OPEN || ctx.state !== 'connected' || !data) return;
  ctx.socket.send(JSON.stringify({ type: 'input', data }));
}

function failActiveConnection(session: SessionContext, activeSocket: WebSocket | null, closeReason: string, displayReason: LocalizedMessage): void {
  if (activeSocket && session.socket === activeSocket) session.socket = null;
  session.generation++;
  session.backendSessionId = '';
  session.pendingHistory = null;
  session.authorizationAbort?.abort();
  session.authorizationAbort = null;
  session.expectedFingerprint = '';
  session.rememberedFingerprint = '';
  stopTimers(session);
  session.fileManager.reset();
  session.fileTree?.setReady(false);
  session.processManager.reset();
  if (isFront(session)) {
    resetNetworkMetric();
    clearHostKeyPrompt();
    invalidateHistoryPasswordLoad();
    updateConnectionStatus(displayReason);
  }
  setSessionState(session, 'error');
  if (activeSocket && activeSocket.readyState < WebSocket.CLOSING) activeSocket.close(CLIENT_CLOSE_SESSION_ERROR, closeReason);
}

async function issueTicket(signal: AbortSignal): Promise<{ ticket: string; sessionId: string }> {
  const response = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({}),
    signal,
  });
  let payload: { ticket?: string; sessionId?: string; error?: string } = {};
  try {
    payload = await response.json() as { ticket?: string; sessionId?: string; error?: string };
  } catch {
    // The HTTP status still gives a useful fallback below.
  }
  if (!response.ok || !payload.ticket || !payload.sessionId) {
    throw new Error(payload.error
      ? bilingualServerMessage(payload.error, undefined, undefined, '请求失败')
      : bilingual(`会话授权失败（HTTP ${response.status}）。`, `Session authorization failed (HTTP ${response.status}).`));
  }
  return { ticket: payload.ticket, sessionId: payload.sessionId };
}

/** Factory that builds a fresh SSH WebSocket for reconnection attempts. */
function createSshReconnectFactory(session: SessionContext): (attempt: number) => Promise<WebSocket> {
  // Reconnects use this session's own dial-time snapshot, never the form (which
  // may already point at another host), and only speak up if it is in front.
  const say: typeof event = (message, category, error, alternate) => { if (isFront(session)) event(message, category, error, alternate); };
  const report: typeof updateConnectionStatus = (message) => { if (isFront(session)) updateConnectionStatus(message); };
  return async (attempt: number): Promise<WebSocket> => {
    const params = session.reconnectParams!;
    const abortController = new AbortController();
    const { ticket, sessionId } = await issueTicket(abortController.signal);
    session.backendSessionId = sessionId;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL('/api/ssh', location.href);
    url.protocol = protocol;
    url.searchParams.set('ticket', ticket);
    url.searchParams.set('session', sessionId);

    const generation = ++session.generation;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => {
      if (generation !== session.generation) {
        ws.close(1000, 'Connection superseded');
        return;
      }
      // Reset this session's own terminal for the new run.
      resetTerminalForConnection(session.terminal);
      if (isFront(session)) fitTerminal(true);

      const config: ConnectionConfig = {
        type: 'connect',
        host: params.host,
        port: params.port,
        username: params.username,
        authMethod: params.authMethod as AuthMethod,
        cols: session.terminal.cols,
        rows: session.terminal.rows,
        term: params.term,
      };
      if (params.authMethod === 'password') config.password = params.password;
      else if (params.keychainId) config.keychainId = params.keychainId;
      else config.privateKey = params.privateKey;
      // 重连时口令必须一并回传，否则加密私钥会在第二次握手上解不开。
      if (params.authMethod === 'publickey' && params.keyPassphrase) config.keyPassphrase = params.keyPassphrase;
      if (params.pinnedKey) config.expectedFingerprint = params.pinnedKey;

      ws.send(JSON.stringify(config));
      report(localized('正在打开 TCP 连接...', 'Opening TCP connection...'));
      say(bilingual('WebSocket 已建立，正在打开 SSH 传输（自动重连）。', 'WebSocket established; opening SSH transport (auto-reconnect).'), 'transport');
    }, { once: true });

    ws.addEventListener('message', (socketEvent) => {
      void handleSocketData(session, socketEvent.data as string | ArrayBuffer | Blob, ws, generation);
    });

    ws.addEventListener('error', () => {
      if (session.socket !== ws) return;
      const message = localized('WebSocket 传输错误。', 'WebSocket transport error.');
      say(localize(message), 'transport', true);
    });

    session.socket = ws;
    session.expectedFingerprint = params.pinnedKey ?? '';
    session.decoder = createDecoder(params.encoding);
    return ws;
  };
}

/** Handles reconnect lifecycle events and updates the SSH UI accordingly. */
function handleSshReconnectLog(session: SessionContext, entry: ReconnectLogEntry): void {
  const say: typeof event = (message, category, error, alternate) => { if (isFront(session)) event(message, category, error, alternate); };
  const report: typeof updateConnectionStatus = (message) => { if (isFront(session)) updateConnectionStatus(message); };
  if (entry.event === 'disconnect' && entry.code === SERVER_CLOSE_AUTH_DEFECT) {
    // 控制帧丢失时以关闭码兜底；统一覆盖首次连接和重连工厂创建的会话 socket。
    session.reconnectManager?.reset();
    session.reconnectManager = null;
    session.reconnectParams = null;
    const reason = bilingual('SSH 认证或主机密钥确认失败，请检查后重试。', 'SSH authentication or host key approval failed; check the settings and try again.');
    if (isFront(session)) {
      showFormError(reason);
      toast(reason, 'error');
    }
    say(reason, 'disconnect', true);
    failActiveConnection(session, session.socket, 'SSH authentication failed', messageTranslation(reason));
  } else if (entry.event === 'give_up') {
    // Reconnect exhausted — perform full cleanup that was deferred.
    const reason = bilingual('SSH 重连失败，已达最大重试次数。', 'SSH reconnect failed; maximum retries reached.');
    say(reason, 'disconnect', true);
    report(messageTranslation(reason));
    if (isFront(session)) toast(reason, 'error');
    session.fileManager.reset();
    session.fileTree?.setReady(false);
    session.processManager.reset();
    setSessionState(session, 'error');
  } else if (entry.event === 'reconnect_attempt') {
    report(localized(
      `正在重连 SSH（${entry.attempt}/${entry.maxAttempts}）…`,
      `Reconnecting SSH (${entry.attempt}/${entry.maxAttempts})…`,
    ));
  } else if (entry.event === 'reconnect_success') {
    say(bilingual('SSH 重连成功。', 'SSH reconnected successfully.'), 'connect');
  }
}

/**
 * A dial that never took off must not silently return: the caller would keep
 * going and drop the user into an empty workspace with nothing connected. The
 * same copy is shown on the form and handed back to whoever asked, so the
 * dashboard can stay on the host overview instead of faking a connection.
 */
function dialFailed(text: string): never {
  showFormError(text);
  throw new Error(text);
}

/**
 * Which session should carry this dial. Idle contexts are reused (including the
 * empty one created at bootstrap) instead of leaking one per attempt; the two
 * configured ceilings stop the registry from growing without bound.
 */
function resolveDialSession(key: string): SessionContext | null {
  const reusable = sessions.all().find((session) => session.targetKey === key && (session.state === 'idle' || session.state === 'error'))
    ?? sessions.all().find((session) => session.targetKey === '' && session.state === 'idle');
  if (reusable) {
    reusable.targetKey = key;
    return reusable;
  }
  const limit = sessions.checkLimit(key);
  if (limit !== 'ok') {
    return dialFailed(limit === 'target'
      ? bilingual(`该主机的会话数已达上限（${MAX_SESSIONS_PER_TARGET}），请先断开其中一个。`, `This host already has ${MAX_SESSIONS_PER_TARGET} sessions; close one before dialling again.`)
      : bilingual(`会话总数已达上限（${MAX_SESSIONS_TOTAL}），请先断开一个会话。`, `Session limit reached (${MAX_SESSIONS_TOTAL}); close one session first.`));
  }
  return createSession();
}

async function connect(options: { newSession?: boolean } = {}): Promise<void> {
  if (historyPasswordLoading) return;
  applyFormDefaults();
  const key = targetKey();
  // A target already talking never gets a second dial: this keeps the reconnect
  // manager from racing itself, and it is also how "go back to my shell" works
  // after returning to the dashboard. The check spans every session in the
  // registry, so an existing background session is reused instead of replaced —
  // unless the dashboard explicitly asked for another session.
  const live = options.newSession ? undefined : sessions.forTarget(key).find((session) =>
    session.state === 'connected' || session.state === 'connecting' || session.state === 'disconnecting');
  if (live) {
    activateSession(live.id);
    dashboard?.openWorkspace();
    restoreHostKeyPrompt();
    return;
  }
  // Any *other* host keeps running: sessions are independent now, so switching
  // target no longer tears down what is already connected.
  const session = resolveDialSession(key);
  if (!session) return;
  activateSession(session.id);
  if (session.socket || session.authorizationAbort) return;
  historyPasswordLoadGeneration++;
  historyPasswordLoading = false;
  // Fresh baseline for a new session: the previous run may have left network
  // state (interface list, baselines) if the user navigated away uncleanly.
  resetNetworkMetric();
  const validationError = validateConnectForm();
  if (validationError) dialFailed(validationError);
  if (document.body.dataset.view !== 'files') dashboard?.openWorkspace();
  if (location.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
    showFormError(bilingual('发送 SSH 凭据前必须使用 HTTPS。', 'HTTPS is required before SSH credentials can be sent.'));
    return;
  }

  ui.formError.hidden = true;
  currentFormError = null;
  const generation = ++session.generation;
  const abortController = new AbortController();
  session.authorizationAbort = abortController;
  ui.terminalEmpty.hidden = true;
  // The session's own xterm host must be in front before any write lands.
  mountTerminal(session).hidden = false;
  resetTerminalForConnection(session.terminal);
  fitTerminal(false);

  const host = normalizeHost(ui.host.value);
  const port = Number(ui.port.value);
  const username = ui.username.value.trim();
  session.targetKey = targetKey(host, port, username);
  session.targetLabel = targetLabel(host, port, username);
  setSessionState(session, 'connecting');
  const pinnedKey = ui.fingerprint.value.trim() || hostKeys[session.targetKey] || '';
  session.expectedFingerprint = pinnedKey;
  session.rememberedFingerprint = '';
  if (pinnedKey) ui.fingerprint.value = pinnedKey;
  // 文件管理不应在隐藏终端里执行用户的初始命令；保存的主机配置仍保持原样。
  session.initialCommand = document.body.dataset.view === 'files' ? '' : ui.initialCommand.value;
  session.initialCommandSent = false;
  session.pendingHostKey = null;
  session.awaitingHostKeyDecision = false;
  session.decoder = createDecoder(ui.encoding.value);
  renderSessionHeader(session);
  updateConnectionStatus(localized('正在授权 Worker 会话...', 'Authorizing Worker session...'));
  ui.metricHostKey.textContent = '--';
  event(bilingual(`正在连接 ${session.targetLabel}`, `Starting ${session.targetLabel}`), 'connect');

  try {
    const password = ui.password.value;
    const privateKey = ui.privateKey.value.trim();
    const keychainId = usesKeychain() ? ui.keychainId.value : undefined;
    const method = authMethod();
    const keyPassphrase = method === 'password' ? '' : ui.keyPassphrase.value;
    const term = ui.termType.value;
    const historyProfile = readProfileFromForm(password);
    // Resolve encryption during the SSH handshake so ready can usually save synchronously.
    void historyProfile.catch(() => undefined);
    session.pendingHistory = { generation, target: session.targetKey, profile: historyProfile };
    const ticketRequest = issueTicket(abortController.signal);
    const { ticket, sessionId } = await ticketRequest;
    session.backendSessionId = sessionId;
    if (session.authorizationAbort === abortController) session.authorizationAbort = null;
    if (generation !== session.generation) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL('/api/ssh', location.href);
    url.protocol = protocol;
    url.searchParams.set('ticket', ticket);
    url.searchParams.set('session', sessionId);

    const activeSocket = new WebSocket(url);
    session.socket = activeSocket;
    activeSocket.binaryType = 'arraybuffer';

    // Persist connection parameters so the reconnect factory can reuse them.
    session.reconnectParams = { host, port, username, authMethod: method, term, encoding: ui.encoding.value };
    if (method === 'password') session.reconnectParams.password = password;
    else if (keychainId) session.reconnectParams.keychainId = keychainId;
    else session.reconnectParams.privateKey = privateKey;
    if (keychainId || privateKey) session.reconnectParams.keyPassphrase = keyPassphrase;
    if (pinnedKey) session.reconnectParams.pinnedKey = pinnedKey;

    // Set up (or replace) the SSH reconnect manager.
    session.reconnectManager?.reset();
    session.reconnectManager = new WebSocketReconnectManager({
      id: 'SSH',
      onConnect: createSshReconnectFactory(session),
      onLog: (entry) => handleSshReconnectLog(session, entry),
      nonRetryableCloseCodes: [SERVER_CLOSE_AUTH_DEFECT],
    });
    session.reconnectManager.attach(activeSocket);

    activeSocket.addEventListener('open', () => {
      if (session.socket !== activeSocket || generation !== session.generation) {
        activeSocket.close(1000, 'Connection attempt superseded');
        return;
      }
      if (isFront(session)) fitTerminal(false);
      const config: ConnectionConfig = {
        type: 'connect',
        host,
        port,
        username,
        authMethod: method,
        cols: session.terminal.cols,
        rows: session.terminal.rows,
        term,
      };
      if (method === 'password') config.password = password;
      else if (keychainId) config.keychainId = keychainId;
      else config.privateKey = privateKey;
      if (method === 'publickey' && keyPassphrase) config.keyPassphrase = keyPassphrase;
      if (pinnedKey) config.expectedFingerprint = pinnedKey;
      activeSocket.send(JSON.stringify(config));
      if (isFront(session)) {
        updateConnectionStatus(localized('正在打开 TCP 连接...', 'Opening TCP connection...'));
        event(bilingual('WebSocket 已建立，正在打开 SSH 传输。', 'WebSocket established; opening SSH transport.'), 'transport');
      }
    }, { once: true });
    attachSessionSocket(session, activeSocket, generation);
  } catch (error) {
    if (session.authorizationAbort === abortController) session.authorizationAbort = null;
    if (generation !== session.generation) return;
    session.pendingHistory = null;
    // Error surfacing belongs to whoever is in front; another session's failure
    // must not steal the form.
    if (!isFront(session)) return;
    invalidateHistoryPasswordLoad();
    clearHostKeyPrompt();
    const message = error instanceof DOMException && error.name === 'AbortError'
      ? bilingual('连接授权已取消。', 'Connection authorization was cancelled.')
      : error instanceof Error
        ? bilingualServerMessage(error.message, undefined, undefined, '连接失败')
        : bilingualServerMessage(String(error), undefined, undefined, '连接失败');
    showFormError(message);
    event(message, 'authorization', true);
    toast(message, 'error');
    setSessionState(session, 'error');
  }
}

/**
 * Everything a session socket needs once it is open: routing inbound messages,
 * and the whole teardown tree when it ends. Shared by a fresh dial and by a
 * resume, because a shell picked up after a reload must not drift away from a
 * shell that was just dialled — the failure paths especially are too easy to get
 * subtly wrong in only one of them.
 */
function attachSessionSocket(session: SessionContext, socket: WebSocket, generation: number): void {
  socket.addEventListener('message', (socketEvent) => {
    void handleSocketData(session, socketEvent.data as string | ArrayBuffer | Blob, socket, generation);
  });
  socket.addEventListener('error', () => {
    if (session.socket !== socket) return;
    const message = localized('WebSocket 传输错误。', 'WebSocket transport error.');
    if (isFront(session)) {
      event(localize(message), 'transport', true);
      showFormError(localize(message));
      toast(localize(message), 'error');
    }
    failActiveConnection(session, socket, 'WebSocket transport error', message);
  });
  socket.addEventListener('close', (closeEvent) => {
    if (session.socket !== socket) return;
    session.socket = null;
    session.backendSessionId = '';
    session.pendingHistory = null;
    session.expectedFingerprint = '';
    session.rememberedFingerprint = '';
    const front = isFront(session);
    const wasActive = session.state === 'connected';
    const isUnexpected = closeEvent.code !== 1000 && closeEvent.code !== 1005;

    if (isUnexpected && session.reconnectManager) {
      // The reconnect manager will attempt reconnection autonomously.
      // Skip tearing down child connections — they each have their own
      // reconnect logic that fires independently.
      stopTimers(session);
      setSessionState(session, 'connecting');
      if (front) {
        resetNetworkMetric();
        clearHostKeyPrompt();
        invalidateHistoryPasswordLoad();
        const reason = bilingual('SSH 连接断开，正在重连…', 'SSH connection lost; reconnecting…');
        event(reason, 'disconnect', true);
        updateConnectionStatus(messageTranslation(reason));
        toast(reason, 'error');
      }
      return;
    }

    // Normal close or reconnect not available — full cleanup.
    stopTimers(session);
    session.fileManager.reset();
    session.fileTree?.setReady(false);
    session.processManager.reset();
    const reason = closeEvent.reason
      ? bilingualServerMessage(closeEvent.reason)
      : closeEvent.code === 1000
        ? bilingual('会话已关闭。', 'Session closed.')
        : bilingual(`会话已关闭（${closeEvent.code}）。`, `Session closed (${closeEvent.code}).`);
    setSessionState(session, isUnexpected ? 'error' : 'idle');
    if (front) {
      resetNetworkMetric();
      clearHostKeyPrompt();
      invalidateHistoryPasswordLoad();
      event(reason, 'disconnect', isUnexpected);
      updateConnectionStatus(messageTranslation(reason));
      if (wasActive) toast(reason, isUnexpected ? 'error' : 'info');
    }
  });
}

/**
 * Exchange a session we already own for a fresh ticket. The answer is null once
 * the server has moved on — an expired retention window, or an object restarted
 * since — and there is nothing to be done about that but dial again.
 */
async function claimRestoredSession(sessionId: string): Promise<string | null> {
  try {
    const response = await fetch('/api/session/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { ticket?: unknown };
    return typeof payload.ticket === 'string' ? payload.ticket : null;
  } catch {
    return null;
  }
}

/**
 * Take a shell this page left behind and grow a session around it again. The
 * server-side half never disconnected — holding it open for exactly this moment
 * is the whole point — so there is no credential to gather and no handshake to
 * repeat: a fresh ticket buys us the same uplink, and from here on it behaves
 * like any other session.
 */
async function resumeSession(record: RestorableSession): Promise<SessionContext | null> {
  const ticket = await claimRestoredSession(record.backendSessionId);
  if (!ticket) return null;

  // Adopt the placeholder rather than adding an entry: this is the connection
  // the page already had, not a new one.
  const session = claimPlaceholderSession();
  session.backendSessionId = record.backendSessionId;
  session.targetKey = record.targetKey;
  session.targetLabel = record.targetLabel;
  setSessionState(session, 'connecting');
  const generation = session.generation;
  const socket = new WebSocket(`/api/ssh?ticket=${encodeURIComponent(ticket)}&session=${encodeURIComponent(record.backendSessionId)}`);
  session.socket = socket;
  attachSessionSocket(session, socket, generation);
  socket.addEventListener('open', () => {
    if (session.socket !== socket || generation !== session.generation) return;
    socket.send(JSON.stringify({ type: 'resume', cols: session.terminal.cols, rows: session.terminal.rows }));
    if (isFront(session)) updateConnectionStatus(localized('正在恢复上次的会话…', 'Restoring your session…'));
  }, { once: true });
  // A restored session has no reconnect manager — there are no credentials to
  // dial with — so a socket that closes leaves nothing behind worth keeping.
  socket.addEventListener('close', () => {
    forgetRestorableSession(record.backendSessionId);
    retireSession(session);
  }, { once: true });
  return session;
}

/**
 * Reopen what was connected before this page loaded, then stop where we are. The
 * restored sessions turn up in the tab strip and the session centre and the user
 * picks one; a reload must not quietly drop them back into whichever shell was in
 * front, nor dial anything on its own, because nothing here has that authority.
 */
async function restorePersistedSessions(): Promise<void> {
  const records = loadRestorableSessions();
  if (records.length === 0) return;
  const restored: SessionContext[] = [];
  for (const record of records) {
    const session = await resumeSession(record);
    if (session) restored.push(session);
    else forgetRestorableSession(record.backendSessionId);
  }
  const resumed = restored.length;
  if (resumed > 0) {
    // They left in front of a running shell — put them back in front of one
    // instead of making them go looking for what survived.
    dashboard?.openWorkspace();
    activateSession(restored[0].id);
  }
  const notice = resumed > 0
    ? bilingual(`已恢复 ${resumed} 个会话。`, `Restored ${resumed} session${resumed === 1 ? '' : 's'}.`)
    : bilingual('之前的会话已结束，请重新连接。', 'The previous session has ended; connect again to open a new one.');
  event(notice, resumed > 0 ? 'info' : 'disconnect');
  toast(notice, resumed > 0 ? 'info' : 'error');
}

/** Tear down one session only; every other connection keeps running untouched. */
function closeSession(session: SessionContext, reason = bilingual('已由用户断开连接', 'Disconnected by user')): void {
  if (session.state === 'disconnecting') return;
  const generation = ++session.generation;
  setSessionState(session, 'disconnecting');
  session.backendSessionId = '';
  session.pendingHistory = null;
  session.authorizationAbort?.abort();
  session.authorizationAbort = null;
  const activeSocket = session.socket;
  session.socket = null;
  session.reconnectManager?.reset();
  session.reconnectManager = null;
  session.reconnectParams = null;
  stopTimers(session);
  session.fileManager.reset();
  session.fileTree?.setReady(false);
  session.processManager.reset();
  session.expectedFingerprint = '';
  session.rememberedFingerprint = '';
  // The meters, the prompt, the form guard and the event log are single widgets
  // owned by the front session. Retiring a background one must not blank them.
  if (isFront(session)) {
    resetNetworkMetric();
    clearHostKeyPrompt();
    invalidateHistoryPasswordLoad();
    updateConnectionStatus(messageTranslation(reason));
    event(reason, 'disconnect');
  }
  let settled = false;
  const finish = (): void => {
    if (settled) return;
    settled = true;
    if (generation === session.generation && session.state === 'disconnecting') setSessionState(session, 'idle');
    retireSession(session);
  };
  if (activeSocket && activeSocket.readyState < WebSocket.CLOSED) {
    activeSocket.addEventListener('close', finish, { once: true });
    if (activeSocket.readyState < WebSocket.CLOSING) activeSocket.close(1000, 'Disconnected by user');
    window.setTimeout(finish, 1_000);
  } else {
    window.setTimeout(finish, 180);
  }
}

/**
 * Drop a retired session out of the registry, releasing its terminal and its
 * managers. One empty session always remains so the workspace keeps a terminal
 * to write into instead of going blank after the last disconnect.
 */
function retireSession(session: SessionContext): void {
  if (session.state !== 'idle' && session.state !== 'error') return;
  if (sessions.get(session.id) !== session) return;
  sessions.remove(session.id);
  try {
    session.terminal.dispose();
  } catch {
    // The instance may already be gone if xterm's host was torn down first.
  }
  session.terminalEl?.remove();
  if (ctx !== session) return;
  // The UI followed this session; move it to whoever is left (or a new empty one).
  setFrontSession(sessions.active ?? createSession());
}

/**
 * Point everything at one session. Deliberately idempotent rather than
 * short-circuiting when nothing changed: callers reach this from very different
 * paths (tab tap, new dial, another session retiring) and every one of them is
 * entitled to leave with the shared widgets owned by the front session.
 */
/**
 * The header answers "where am I" the same way the host list does — flag, host
 * name, then `user@host:port` — and keeps the shell state on the line below.
 * Only the address used to be there, which left two perfectly good facts (which
 * country, which saved host) unused while the list right beside it showed them.
 * Resolved lazily from `profiles` because the location arrives with the host
 * list, not with the dial.
 */
function renderSessionHeader(session: SessionContext = ctx): void {
  const profile = session.targetKey
    ? profiles.find((candidate) => sessionTargetKey(candidate.host, candidate.port, candidate.username) === session.targetKey)
    : undefined;
  const label = session.targetLabel || bilingual('无活动会话', 'No active session');
  const name = profile?.name.trim();
  ui.sessionTitle.textContent = name ? `${name} · ${label}` : label;

  const flag = ui.sessionFlag;
  flag.replaceChildren();
  const location = profile?.location;
  if (!location?.countryCode) {
    flag.hidden = true;
    flag.removeAttribute('role'); flag.removeAttribute('aria-label'); flag.removeAttribute('title');
    return;
  }
  const place = [location.city || location.region || location.country, location.country].filter(Boolean).join(' · ');
  flag.append(countryFlag(location.countryCode));
  flag.hidden = false;
  flag.setAttribute('role', 'img');
  flag.setAttribute('aria-label', place);
  flag.title = place;
}

function setFrontSession(session: SessionContext): void {
  ctx = session;
  // The topbar host name belongs to the session in front. The meters and the
  // orb already follow a tab tap through mountSessionPanels()/setState(); the
  // title was only written by connect() and resumeSession(), so switching tabs
  // left the previous host's name on screen.
  renderSessionHeader(session);
  syncFormToSession(session);
  sessions.activate(session.id);
  showOnlyTerminal(session);
  mountSessionPanels(session);
  setState(session.state);
  renderSessionTabs();
  // The instance spent its time in the background without dimensions, so the
  // very first thing after showing it is to measure it again.
  fitTerminal(true);
}

/**
 * Aim the connect form at the session the user just brought forward. Left
 * alone, the form keeps describing whichever target was dialled last, so the
 * connect button reads "connect" for a host that is already online and any dial
 * from there would be aimed at the session in the background. Credentials are
 * deliberately untouched — a session switch must never move a password.
 */
function syncFormToSession(session: SessionContext): void {
  const params = session.reconnectParams;
  if (!params?.host) return;
  ui.profileId.value = profiles.find((profile) => passwordContext(profile) === session.targetKey)?.id ?? '';
  ui.host.value = params.host;
  ui.port.value = String(params.port);
  ui.username.value = params.username;
}

/** Single-session entry point used by the toolbar and the compatibility API. */
function disconnect(reason = bilingual('已由用户断开连接', 'Disconnected by user')): void {
  closeSession(ctx, reason);
}

/**
 * Returning to the host overview must NOT retire the session. Everything the
 * connection needs — socket, auxiliary SFTP/process channels, timers and the
 * per-session network buffers — keeps running so the user can come back to the
 * same shell instead of a fresh login.
 *
 * The only thing still scrubbed is the connect form: `clearCredentials()`
 * exists to stop one host's password leaking into the next host's handshake,
 * and that guarantee must survive independent of the connection lifecycle. It
 * is safe for reconnect because `ctx.reconnectParams` holds a value snapshot
 * taken at dial time rather than reading the form.
 */
function detachSession(): void {
  // Returning to the overview cancels any in-flight credential decrypt. This
  // used to ride on `disconnect()` bumping the generation, but it is a property
  // of *leaving the page*, not of tearing down the socket — file-page must not
  // start a connection the user already navigated away from.
  historyPasswordLoadGeneration++;
  historyPasswordLoading = false;
  clearCredentials();
  hideHostKeyPrompt();
  event(bilingual('已返回主机总览，SSH 会话保持连接。', 'Returned to host dashboard; the SSH session stays connected.'), 'session');
}

function createDecoder(encoding: string): TextDecoder {
  try {
    return new TextDecoder(encoding, { fatal: false });
  } catch {
    ui.encoding.value = 'utf-8';
    toast(bilingual(`此浏览器不支持 ${encoding} 编码，将使用 UTF-8。`, `Encoding ${encoding} is not supported by this browser; using UTF-8.`), 'error');
    return new TextDecoder('utf-8');
  }
}

function copySafeLink(): void {
  applyFormDefaults();
  const error = validateProfileFields();
  if (error) {
    showFormError(error);
    return;
  }
  const url = new URL(location.origin + location.pathname);
  url.searchParams.set('hostname', normalizeHost(ui.host.value));
  url.searchParams.set('port', ui.port.value || '22');
  url.searchParams.set('username', ui.username.value.trim());
  url.searchParams.set('term', ui.termType.value);
  if (ui.encoding.value !== 'utf-8') url.searchParams.set('encoding', ui.encoding.value);
  void navigator.clipboard.writeText(url.toString()).then(
    () => toast(bilingual('连接链接已复制（不含凭据）。', 'Connection link copied (credentials excluded).')),
    () => toast(bilingual('无法访问剪贴板。', 'Could not access the clipboard.'), 'error'),
  );
}

function setPortValue(value: string | number, source: string): void {
  if (String(value).trim() === '') {
    ui.port.value = '22';
    return;
  }
  const port = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(bilingual(`${source}中的端口无效`, `Invalid port in ${source}`));
  }
  ui.port.value = String(port);
}

function applyURLParameters(): boolean {
  const query = new URLSearchParams(location.search);
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ''));
  const value = (key: string): string | null => query.get(key) ?? fragment.get(key);
  const host = value('hostname') ?? value('host');
  if (host) ui.host.value = host;
  const port = value('port');
  if (port !== null) {
    try {
      setPortValue(port, bilingual('连接链接', 'connection link'));
    } catch (error) {
      showFormError(error instanceof Error ? error.message : String(error));
      return false;
    }
  }
  if (value('username')) ui.username.value = value('username')!;
  if (value('term')) ui.termType.value = value('term')!;
  if (value('encoding')) ui.encoding.value = value('encoding')!;
  if (value('fingerprint')) ui.fingerprint.value = value('fingerprint')!;
  if (value('title')) document.title = value('title')!;

  // 链接只预填非敏感字段，不接受凭据、命令或自动连接，防止诱导执行远程命令。
  if (value('password') || value('command')) history.replaceState(null, '', location.pathname);
  return false;
}

function applyWSSHOptions(options: WSSHOptions): void {
  historyPasswordLoadGeneration++;
  historyPasswordLoading = false;
  clearCredentials();
  ui.host.value = options.host ?? options.hostname ?? ui.host.value;
  setPortValue(options.port ?? 22, 'wssh.connect()');
  ui.username.value = options.username?.trim() || 'root';
  if (options.password !== undefined) {
    setAuthMethod('password');
    ui.password.value = options.password;
    passwordDirty = true;
  }
  const key = options.privateKey ?? options.privatekey;
  if (key !== undefined) {
    setAuthMethod('publickey');
    ui.privateKey.value = key;
  }
  if (options.command !== undefined) ui.initialCommand.value = options.command;
  if (options.term !== undefined) ui.termType.value = options.term;
  if (options.encoding !== undefined) ui.encoding.value = options.encoding;
  if (options.fingerprint !== undefined) ui.fingerprint.value = options.fingerprint;
}

function initializeCompatibilityAPI(): void {
  const compatibilityConnect = async (
    optionsOrHost: WSSHOptions | string = {},
    port?: string | number,
    username?: string,
    password?: string,
    privateKey?: string,
  ): Promise<void> => {
    const options: WSSHOptions = typeof optionsOrHost === 'string'
      ? { host: optionsOrHost, port, username, password, privateKey }
      : optionsOrHost;
    // "Already connected" used to mean one global connection. With sessions it
    // means this very target; any other host can still be dialled alongside.
    const key = sessionTargetKey(
      normalizeHost(options.host ?? options.hostname ?? ui.host.value),
      Number(options.port ?? ui.port.value),
      (options.username ?? ui.username.value).trim() || 'root',
    );
    if (sessions.forTarget(key).some((session) => session.state === 'connected'
      || session.state === 'connecting' || session.state === 'disconnecting')) {
      throw new Error(bilingual('该目标已有活动的 SSH 连接', 'An SSH connection to this target is already active'));
    }
    applyWSSHOptions(options);
    await connect();
  };
  window.wssh = {
    connect: compatibilityConnect as WSSHCompatibilityAPI['connect'],
    send: sendTerminalData,
    resize: () => fitTerminal(true),
    set_encoding: (encoding: string) => {
      ui.encoding.value = encoding;
      ctx.decoder = createDecoder(encoding);
    },
    reset_encoding: () => {
      ui.encoding.value = 'utf-8';
      ctx.decoder = new TextDecoder('utf-8');
    },
    disconnect,
  };
}

for (const radio of ui.form.querySelectorAll<HTMLInputElement>('input[name="authMethod"]')) {
  radio.addEventListener('change', () => {
    cancelHistoryPasswordLoad();
    setAuthMethod(radio.value as AuthMethod | 'keychain');
  });
}
ui.form.addEventListener('submit', (formEvent) => {
  formEvent.preventDefault();
  // Disconnect only ever applies to the session that owns the current form
  // target; with another host selected the button must dial that host instead.
  if (sessionOwnsFormTarget()) {
    closeSession(ctx, ctx.state === 'connecting'
      ? bilingual('连接已取消', 'Connection cancelled')
      : bilingual('已由用户断开连接', 'Disconnected by user'));
  } else if (ctx.state !== 'disconnecting') {
    void connect();
  }
});
ui.shareLink.addEventListener('click', copySafeLink);
ui.password.addEventListener('input', () => {
  cancelHistoryPasswordLoad();
  passwordDirty = true;
});
for (const field of [ui.host, ui.port, ui.username]) {
  field.addEventListener('input', () => {
    cancelHistoryPasswordLoad();
    // Editing the target by hand changes which session the button acts on.
    renderConnectControl();
  });
}
ui.revealPassword.addEventListener('click', () => {
  const reveal = ui.password.type === 'password';
  ui.password.type = reveal ? 'text' : 'password';
  updateRevealPasswordButton();
});
ui.keyFile.addEventListener('change', async () => {
  const readGeneration = ++keyFileReadGeneration;
  const file = ui.keyFile.files?.[0];
  if (!file) {
    clearPrivateKeyFields();
    return;
  }
  ui.keyFileName.textContent = file.name;
  if (file.size > MAX_KEY_BYTES) {
    showFormError(bilingual('所选私钥大于 64 KiB。', 'The selected private key is larger than 64 KiB.'));
    clearPrivateKeyFields();
    return;
  }
  try {
    const privateKey = await file.text();
    if (readGeneration !== keyFileReadGeneration || ui.keyFile.files?.[0] !== file) return;
    ui.privateKey.value = privateKey;
  } catch {
    if (readGeneration !== keyFileReadGeneration) return;
    clearPrivateKeyFields();
    showFormError(bilingual('无法读取所选私钥。', 'The selected private key could not be read.'));
  }
});
ui.profileList.addEventListener('click', (clickEvent) => {
  const target = clickEvent.target as HTMLElement;
  const deleteButton = target.closest<HTMLElement>('[data-delete-profile]');
  if (deleteButton?.dataset.deleteProfile) {
    clickEvent.preventDefault();
    clickEvent.stopPropagation();
    const id = deleteButton.dataset.deleteProfile;
    const target = profiles.find((profile) => profile.id === id);
    if (target && ctx.pendingHistory?.target === passwordContext(target)) ctx.pendingHistory = null;
    void deleteProfile(id);
    return;
  }
  const card = target.closest<HTMLElement>('[data-profile-id]');
  const profile = profiles.find((item) => item.id === card?.dataset.profileId);
  if (profile) void applyProfile(profile).catch((error) => toast(error instanceof Error ? error.message : '读取凭据失败。', 'error'));
});
ui.panelToggle.addEventListener('click', () => {
  const opening = !panelOpen;
  setPanelOpen(opening);
  if (opening) requestAnimationFrame(() => {
    if (ctx.state === 'connecting' || ctx.state === 'connected' || ctx.state === 'disconnecting') ui.connect.focus();
    else ui.host.focus();
  });
});
ui.panelScrim.addEventListener('click', () => {
  setPanelOpen(false);
  ui.panelToggle.focus();
});
ui.emptyConnect.addEventListener('click', () => {
  setPanelOpen(true);
  requestAnimationFrame(() => ui.host.focus());
});
ui.clearTerminal.addEventListener('click', () => ctx.terminal.clear());
ui.fullscreenTerminal.addEventListener('click', async () => {
  if (document.fullscreenElement === ui.terminalCard) await document.exitFullscreen();
  else await ui.terminalCard.requestFullscreen();
});
document.addEventListener('fullscreenchange', () => fitTerminal(true));
ui.fullscreenFiles.append(createElement(Maximize, { 'aria-hidden': 'true' }));
ui.exitFullscreenFiles.append(createElement(Minimize, { 'aria-hidden': 'true' }));
ui.fullscreenFiles.addEventListener('click', () => {
  // 全屏共享面板而非整个页面，保留目录及传输状态，同时移除周围的连接与导航区域。
  void ui.fileManagerPanel.requestFullscreen().catch(() => {
    toast(bilingual('无法进入全屏，请检查浏览器的全屏权限。', 'Unable to enter fullscreen. Check your browser fullscreen permissions.'), 'error');
  });
});
ui.exitFullscreenFiles.addEventListener('click', () => void document.exitFullscreen());
let filesFullscreen = false;
document.addEventListener('fullscreenchange', () => {
  const active = document.fullscreenElement === ui.fileManagerPanel;
  if (active) ui.exitFullscreenFiles.focus();
  else if (filesFullscreen) ui.fullscreenFiles.focus();
  filesFullscreen = active;
});
ui.fileManagerTab.addEventListener('click', () => toggleWorkspaceTab('files'));
ui.processManagerTab.addEventListener('click', () => toggleWorkspaceTab('processes'));
ui.eventToggle.addEventListener('click', () => toggleWorkspaceTab('log'));
ui.fileManagerTab.addEventListener('keydown', handleWorkspaceTabKey);
ui.processManagerTab.addEventListener('keydown', handleWorkspaceTabKey);
ui.eventToggle.addEventListener('keydown', handleWorkspaceTabKey);
ui.languageToggle.addEventListener('click', () => {
  applyLanguage(currentLanguage === 'zh-CN' ? 'en' : 'zh-CN', true);
  renderProfiles();
  setState(ctx.state);
  setPanelOpen(panelOpen);
  if (ctx.state === 'idle' && !ctx.targetLabel) renderSessionHeader(ctx);
});
ui.themeToggle.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch { /* Theme still applies for this page. */ }
  applyTerminalTheme();
});
ui.hostKeyDialog.addEventListener('cancel', (cancelEvent) => {
  cancelEvent.preventDefault();
  ui.hostKeyDialog.close('reject');
});
ui.hostKeyDialog.addEventListener('close', () => {
  // Closing from `hideHostKeyPrompt()` is a navigation, not a verdict.
  if (suppressHostKeyDialogClose) {
    suppressHostKeyDialogClose = false;
    return;
  }
  sendHostKeyDecision(ui.hostKeyDialog.returnValue === 'accept');
});
// Bind the network interface selector once. Options are rebuilt by
// syncNetworkSelectOptions() only when the interface list changes, so the
// element keeps focus while the user interacts with it.
ui.resourceNetworkSelect.addEventListener('change', () => {
  const next = ui.resourceNetworkSelect.value;
  if (!next || next === ctx.netSelectedIface) return;
  ctx.netSelectedIface = next;
  resetNetworkBaseline();
  updateNetworkIfaceLabel();
});
// Keystrokes reach the terminal that owns the UI; each session bound its own
// `onData` handler in `attachSessionRuntime()`.
new ResizeObserver(() => fitTerminal(true)).observe(ui.terminalStage);
window.addEventListener('beforeunload', () => {
  for (const session of sessions.all()) {
    session.fileManager.reset();
    session.fileTree?.setReady(false);
    session.fileTree?.destroy();
    session.processManager.reset();
    // Not 1000 — that code means "disconnect me". 4003 tells the server the tab
    // is unloading while the session itself is still wanted, so the Durable
    // Object holds the shell for a few minutes in case this page comes back.
    // Keep in sync with CLOSE_PAGE_UNLOAD in src/backend/session-retention.ts.
    session.socket?.close(4003, 'Page closed');
  }
  resetNetworkMetric();
});

document.addEventListener('keydown', (keyEvent) => {
  if (keyEvent.key === 'Escape' && panelOpen && !ui.hostKeyDialog.open) {
    setPanelOpen(false);
    ui.panelToggle.focus();
  }
});

let storedTheme: string | null = null;
try { storedTheme = localStorage.getItem(THEME_STORAGE_KEY); } catch { /* Storage can be disabled. */ }
if (storedTheme === 'light' || storedTheme === 'dark') document.documentElement.dataset.theme = storedTheme;
applyTerminalTheme();
async function initialize(): Promise<void> {
  applyLanguage(currentLanguage);
  renderProfiles();
  setPanelOpen(panelOpen);
  setAuthMethod('password');
  setState('idle');
  setWorkspaceTab(null);
  renderSessionHeader(ctx);
  ui.sessionSubtitle.textContent = bilingual('选择目标并连接', 'Choose a target and connect');
  ui.eventMessage.textContent = bilingual('Worker 运行时待命', 'Worker runtime standing by');
  initializeCompatibilityAPI();
  applyURLParameters();
  // 两个视图共用指纹确认与通知，不能随隐藏的终端容器一起消失。
  document.body.append(ui.hostKeyDialog, ui.toastRegion);
  filePage = new FilePage(ui.fileManagerPanel, {
    connect: async (host) => {
      const loading = applyProfile(host);
      const selectionGeneration = historyPasswordLoadGeneration;
      await loading;
      // 返回总览会作废凭据读取；即使用户立刻回到文件页，也不能启动已经取消的连接。
      if (selectionGeneration === historyPasswordLoadGeneration && document.body.dataset.view === 'files') await connect();
    },
    disconnect: () => disconnect(),
    openTerminal: () => {
      dashboard?.openWorkspace();
      if (ctx.state === 'idle' || ctx.state === 'error') setPanelOpen(true);
    },
    sessions: () => sessions.list(),
    activeSessionId: () => sessions.activeIdOrNull,
    activateSession: (id) => activateSession(id),
  });
  keychain = new Keychain(() => dashboard?.openWorkspace());
  keychain.addEventListener('change', () => fillKeychainSelect(ui.keychainId, keychain.keys));
  ui.form.querySelector('input[name="authMethod"][value="keychain"]')!.addEventListener('change', () => void keychain.load());
  element('manage-keychain').addEventListener('click', () => dashboard?.showKeychain());
  dashboard = new Dashboard({
    keychain,
    files: filePage,
    snippets: new Snippets(document.querySelector<HTMLElement>('#app .topbar-actions')!, (snippet) => {
      // 片段只进入草稿，尤其多行命令不能通过粘贴意外立即执行。
      const input = document.getElementById('command-editor-input') as HTMLTextAreaElement;
      if (input.value.trim() && input.value !== snippet.command
        && !confirm(bilingual('替换命令编辑器中的现有内容？', 'Replace the current command draft?'))) return;
      input.value = snippet.command;
      input.dispatchEvent(new Event('input'));
      if (document.getElementById('command-editor')!.hidden) document.getElementById('command-editor-toggle')!.click();
      input.focus();
      toast(bilingual('已填入命令编辑器，确认后再发送。', 'Added to the command editor. Review before sending.'), 'info');
    }, () => dashboard?.openWorkspace(), () => dashboard?.showSnippets()),
    refresh: async () => {
      profiles = await loadProfiles();
      renderProfiles();
      return profiles;
    },
    connect: async (host) => {
      await applyProfile(host);
      await connect();
    },
    newSession: async (host) => {
      await applyProfile(host);
      await connect({ newSession: true });
    },
    quickConnect: () => {
      clearForm();
      setPanelOpen(true);
      requestAnimationFrame(() => { fitTerminal(false); ui.host.focus(); });
    },
    leaveWorkspace: () => {
      detachSession();
    },
    // Dashboard 是纯视图：会话归这里的注册表所有，它只读快照，并把「切换前台」
    // /「断开某一条」回呼给所有者，避免两处各维护一份状态。
    sessions: () => sessions.list(),
    activeSessionId: () => sessions.activeIdOrNull,
    stateLabel: (state) => localize(SESSION_STATE_LABEL[state]),
    activateSession: (id) => activateSession(id),
    closeSession: (id) => {
      const session = sessions.get(id);
      if (session) closeSession(session, bilingual('会话已从会话中心断开', 'Session disconnected from the session centre'));
    },
  });
  await dashboard.start();
  // Anything that was connected before this page loaded is still waiting on the
  // server; go and claim it back before the user notices anything was missing.
  await restorePersistedSessions();
}

void initialize().catch((error) => {
  toast(error instanceof Error ? error.message : '初始化失败，请刷新页面重试。', 'error');
});
