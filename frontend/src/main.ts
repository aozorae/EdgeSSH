import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { createElement, Maximize, Minimize } from 'lucide';
import { historyKey, historyLabel } from './history';
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
import './style.css';

type AuthMethod = 'password' | 'publickey';
type ConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnecting' | 'error';
type Language = 'zh-CN' | 'en';
type Translation = readonly [zh: string, en: string];

interface LocalizedMessage {
  zh: string;
  en: string;
}

type SavedProfile = CloudHost & Credentials;

interface PendingHistory {
  generation: number;
  target: string;
  profile: Promise<SavedProfile>;
}

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
  auth_success: ['SSH 认证成功，正在打开终端', 'SSH authentication succeeded; opening terminal'],
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
  'Invalid terminal size': '终端尺寸无效',
  'Invalid host key fingerprint': '主机密钥指纹无效',
  'SSH authentication failed': 'SSH 认证失败',
  'Host key was not accepted': '主机密钥未被接受',
  'SSH host key signature verification failed': 'SSH 主机密钥签名验证失败',
  'The server does not support SSH 2.0': '服务器不支持 SSH 2.0',
  'SSH compression is not supported': '不支持 SSH 压缩',
  'Server-initiated SSH rekey is not supported': '不支持由服务器发起的 SSH 重新密钥交换',
  'SSH rekey is not supported by this terminal session': '当前终端会话不支持 SSH 重新密钥交换',
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
  terminalElement: element<HTMLElement>('terminal'),
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
  ui.sessionSubtitle.textContent = localize(currentSessionSubtitle);
  ui.eventMessage.textContent = localize(currentEventMessage);
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
  if (fileManager) fileManager.setLanguage();
  if (fileTree) fileTree.setLanguage();
  if (processManager) processManager.setLanguage();
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
let socket: WebSocket | null = null;
let connectionState: ConnectionState = 'idle';
let sessionStartedAt = 0;
let uptimeTimer: number | null = null;
let pingTimer: number | null = null;
let pendingHostKey: HostKeyPrompt | null = null;
let currentTargetKey = '';
let currentTargetLabel = '';
let currentInitialCommand = '';
let initialCommandSent = false;
let decoder = new TextDecoder('utf-8');
let resizeFrame = 0;
let awaitingHostKeyDecision = false;
let connectGeneration = 0;
let authorizationAbort: AbortController | null = null;
let currentExpectedFingerprint = '';
let currentRememberedFingerprint = '';
let currentSessionSubtitle: LocalizedMessage = { zh: '选择目标并连接', en: 'Choose a target and connect' };
let currentSessionId = '';
let currentEventMessage: LocalizedMessage = { zh: 'Worker 运行时待命', en: 'Worker runtime standing by' };
let currentFormError: LocalizedMessage | null = null;
let passwordDirty = false;
let pendingHistory: PendingHistory | null = null;
let historyPasswordLoading = false;
let historyPasswordLoadGeneration = 0;
let historyMutationSequence = 0;
let keyFileReadGeneration = 0;
let profileSaveTask: Promise<void> = Promise.resolve();
const latestHistoryMutation = new Map<string, number>();
let panelOpen = false;
let fileManager: FileManager;
let fileTree: FileTree;
let processManager: ProcessManager;
let terminalTools: TerminalToolsController | undefined;
let sshReconnectManager: WebSocketReconnectManager | null = null;
let reconnectParams: {
  host: string; port: number; username: string; authMethod: string;
  password?: string; privateKey?: string; keychainId?: string; keyPassphrase?: string; pinnedKey?: string;
  term: string; encoding: string;
} | null = null;

// Network rate state. The backend sends cumulative byte counters per interface
// per tick; we keep a per-interface baseline (counters + local clock timestamp)
// so switching the selected interface — or the server reporting a different
// set — never produces a bogus one-shot rate spike. `netIfaceList` is the
// deduplicated, order-preserving list of interfaces present in the latest tick;
// `netSelectedIface` stays null until the first tick resolves a default.
// 60-point ring buffer of the per-tick throughput magnitude (max of rx/tx).
// The newest sample lives at `netSparkIdx - 1`; the oldest at `netSparkIdx`
// once the buffer wraps, or at index 0 while it is still filling.
const NET_SPARK_POINTS = 60;
const netSpark = new Float32Array(NET_SPARK_POINTS);
let netSparkIdx = 0;
let netSparkFilled = 0;
const netBaselines = new Map<string, { rx: number; tx: number; ts: number }>();
let netIfaceList: string[] = [];
let netSelectedIface: string | null = null;

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
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  if (netSparkFilled === 0) return;
  // Build a chronological copy so the rest of the math is index-stable.
  const data = new Array<number>(NET_SPARK_POINTS).fill(0);
  const start = netSparkFilled < NET_SPARK_POINTS ? 0 : netSparkIdx;
  for (let i = 0; i < NET_SPARK_POINTS; i += 1) {
    data[i] = netSpark[(start + i) % NET_SPARK_POINTS];
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
  ctx.fillStyle = currentColorScheme() === 'light' ? '#0f7a58' : '#69e6b4';
  for (let i = 0; i < NET_SPARK_POINTS; i += 1) {
    const value = data[i];
    const normalized = (value - minimum) / span;
    const barHeight = Math.max(1, Math.round(normalized * (height - 1)));
    const x = Math.round(i * slot + ((slot - barWidth) / 2));
    const y = height - barHeight;
    ctx.fillRect(x, y, barWidth, barHeight);
  }
}

// Rebuilds the `<select>` options only when the interface list changed, so a
// rapid tick cannot recreate the element under an open dropdown (which would
// drop focus). The iface label always follows the currently selected interface.
function syncNetworkSelectOptions(): void {
  const select = ui.resourceNetworkSelect;
  const existing = Array.from(select.options).map((option) => option.value);
  const unchanged = existing.length === netIfaceList.length
    && existing.every((value, index) => value === netIfaceList[index]);
  if (unchanged) return;
  select.replaceChildren();
  for (const iface of netIfaceList) {
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
  const multi = netIfaceList.length > 1;
  ui.resourceNetworkIface.textContent = netSelectedIface ?? '-';
  ui.resourceNetworkIface.hidden = multi;
  select.hidden = !multi;
  if (multi) {
    syncNetworkSelectOptions();
    select.value = netSelectedIface ?? '';
  }
}

// Sole entry point for resetting the rate baseline. Called on interface
// switch (manual or automatic fallback) and on full teardown; do NOT clear
// baseline state by hand anywhere else.
function resetNetworkBaseline(): void {
  netBaselines.clear();
  netSpark.fill(0);
  netSparkIdx = 0;
  netSparkFilled = 0;
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
  netIfaceList = list;

  // Resolve the selected interface: keep the user's choice while it is still
  // present, otherwise fall back to eth0 (or the first interface in order).
  const previousSelection = netSelectedIface;
  if (netSelectedIface === null || !netIfaceList.includes(netSelectedIface)) {
    netSelectedIface = netIfaceList.includes('eth0') ? 'eth0' : netIfaceList[0];
  }
  if (netSelectedIface !== previousSelection) {
    // Interface changed (user switch or automatic fallback): a fresh baseline
    // prevents a bogus one-shot rate spike across different counters.
    resetNetworkBaseline();
  }

  // Prune baselines for interfaces that disappeared (e.g. cable unplugged).
  for (const iface of netBaselines.keys()) {
    if (!netIfaceList.includes(iface)) netBaselines.delete(iface);
  }

  const selected = netSelectedIface;
  const sample = samples.find((entry) => entry.iface === selected);
  if (!sample) {
    // The selected interface is absent from this tick (mid-switch); keep the
    // current UI until the next tick provides it again.
    return;
  }

  const baseline = netBaselines.get(selected);
  if (!baseline) {
    // First sample for the selected interface: stash the counters and
    // timestamp; rate and sparkline both show zero until we have a second
    // sample to diff against.
    netBaselines.set(selected, { rx: sample.rxBytes, tx: sample.txBytes, ts: timestamp });
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
  netBaselines.set(selected, { rx: sample.rxBytes, tx: sample.txBytes, ts: timestamp });
  // Use the larger of the two rates as the sparkline magnitude so a
  // quiescent direction doesn't make the chart look half-dead.
  const magnitude = Math.max(rxRate, txRate);
  netSpark[netSparkIdx] = magnitude;
  netSparkIdx = (netSparkIdx + 1) % NET_SPARK_POINTS;
  if (netSparkFilled < NET_SPARK_POINTS) netSparkFilled += 1;
  drawNetworkSparkline();
  // `↑` = upload (tx), `↓` = download (rx) — match the toolbar arrow convention.
  ui.resourceNetworkRateUp.textContent = `↑ ${formatNetworkRate(txRate)}`;
  ui.resourceNetworkRateDown.textContent = `↓ ${formatNetworkRate(rxRate)}`;
  updateNetworkIfaceLabel();
}

function resetNetworkMetric(): void {
  // Idempotent: only touch the DOM / state if the block is currently visible
  // or still carries live state, so repeated resets (one per
  // processManager.reset() call site) are cheap.
  if (ui.resourceNetwork.hidden && netSelectedIface === null && netBaselines.size === 0) return;
  ui.resourceNetwork.hidden = true;
  netIfaceList = [];
  netSelectedIface = null;
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

const terminal = new Terminal({
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
const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);
terminal.loadAddon(new WebLinksAddon());
terminal.open(ui.terminalElement);
terminalTools = createTerminalTools({
  send: sendTerminalData,
  focusTerminal: () => terminal.focus(),
  refitTerminal: () => fitTerminal(true),
  localize: bilingual,
});
fileManager = new FileManager({
  elements: collectFileManagerElements(),
  getLanguage: () => currentLanguage,
  onError: (message) => event(message, 'sftp', true),
  onStatus: (message) => event(message, 'sftp'),
});
fileTree = new FileTree({
  container: ui.fileTree,
  fetchEntries: (path) => fileManager.fetchDirectoryEntries(path),
  getLanguage: () => currentLanguage,
  onNavigate: (path) => fileManager.navigate(path),
  onError: (message) => event(message, 'sftp', true),
  initialRoot: '/',
});
fileManager.onCwdChange((cwd) => fileTree.setCwd(cwd));
processManager = new ProcessManager({
  elements: collectProcessManagerElements(),
  getLanguage: () => currentLanguage,
  onError: (message) => event(message, 'process', true),
  onReconnect: (zh, en) => event(bilingual(zh, en), 'process'),
  onToast: (zh, en, kind) => toast(bilingual(zh, en), kind),
  onNetworkSample: (sample, timestamp) => updateNetworkMetric(sample, timestamp),
});

type ColorScheme = 'dark' | 'light';

function currentColorScheme(): ColorScheme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

// Declared as function bodies (not module-level consts) because `terminal` is
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
  terminal.options.theme = terminalTheme();
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
  setState(connectionState);
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
  const trimmed = host.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed.slice(1, -1);
  return trimmed;
}

function targetKey(host = normalizeHost(ui.host.value), port = Number(ui.port.value), username = ui.username.value.trim()): string {
  return historyKey(host, port, username);
}

function targetLabel(host: string, port: number, username: string): string {
  return historyLabel(host, port, username);
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
  setState(connectionState);
  renderProfiles();
  let credentials: Credentials;
  try {
    credentials = await hostCredentials(profile.id);
  } catch (error) {
    if (loadGeneration === historyPasswordLoadGeneration) {
      historyPasswordLoading = false;
      setState(connectionState);
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
  setState(connectionState);
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
  setState(connectionState);
  renderProfiles();
  ui.host.focus();
}

async function saveConnectedProfile(): Promise<void> {
  if (!pendingHistory || pendingHistory.generation !== connectGeneration) return;
  const operation = pendingHistory;
  pendingHistory = null;
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
  const rememberedFingerprint = key === currentTargetKey && currentRememberedFingerprint
    ? currentRememberedFingerprint
    : hostKeys[key] || profile.fingerprint || '';
  const saved: SavedProfile = {
    ...profile,
    fingerprint: rememberedFingerprint,
    updatedAt: connectedAt,
  };
  if (historyPasswordLoading && targetKey() === operation.target) {
    historyPasswordLoadGeneration++;
    historyPasswordLoading = false;
    setState(connectionState);
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
  if (connectionState !== 'connecting' && connectionState !== 'connected' && connectionState !== 'disconnecting') return false;
  return currentTargetKey !== '' && currentTargetKey === targetKey();
}

/** Wait until a requested disconnect has settled back to idle. */
function waitForIdle(timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve) => {
    if (connectionState === 'idle' || connectionState === 'error') {
      resolve();
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      if (connectionState === 'idle' || connectionState === 'error' || Date.now() - startedAt >= timeoutMs) {
        window.clearInterval(timer);
        resolve();
      }
    }, 40);
  });
}

/** Paint the connect button for the host currently held by the form. */
function renderConnectControl(): void {
  const state: ConnectionState = sessionOwnsFormTarget() ? connectionState : 'idle';
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
  ui.connect.title = currentSessionId || controlLabel;
}

function updateConnectionStatus(message: LocalizedMessage): void {
  currentSessionSubtitle = message;
  const text = localize(message);
  ui.sessionSubtitle.textContent = text;
  filePage?.setMessage(text);
  if (connectionState === 'connecting' && sessionOwnsFormTarget()) {
    const btnSpan = ui.connect.querySelector<HTMLElement>('span:last-child');
    if (btnSpan) btnSpan.textContent = text;
  }
}

function setState(state: ConnectionState, label?: string): void {
  connectionState = state;
  ui.fullscreenFiles.disabled = state !== 'connected';
  const hostId = profiles.find((profile) => passwordContext(profile) === currentTargetKey)?.id ?? null;
  filePage?.setConnection(state, hostId ?? undefined, currentTargetLabel);
  // 文件管理按主机 id 记住最后访问的目录；临时连接（无 id）不记录。
  fileManager?.setHostId(hostId);
  const stateLabel = label ?? ({
    idle: bilingual('离线', 'Offline'),
    connecting: bilingual('连接中', 'Connecting'),
    connected: bilingual('在线', 'Online'),
    disconnecting: bilingual('正在断开', 'Disconnecting'),
    error: bilingual('错误', 'Error'),
  } satisfies Record<ConnectionState, string>)[state];
  ui.liveOrb.className = `live-orb ${state}`;
  ui.liveOrbLabel.textContent = stateLabel;
  ui.liveOrb.title = stateLabel;
  renderConnectControl();
  terminalTools?.setConnected(state === 'connected');
}

function event(message: string, category = 'session', error = false, alternate?: string): void {
  const eventTranslation = messageTranslation(message, alternate);
  currentEventMessage = eventTranslation;
  ui.eventMessage.textContent = localize(currentEventMessage);
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
  line.append(time, type, copy);
  ui.eventLog.append(line);
  while (ui.eventLog.childElementCount > 100) ui.eventLog.firstElementChild?.remove();
  ui.eventLog.scrollTop = ui.eventLog.scrollHeight;
}

function fitTerminal(send = true): void {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    try {
      fitAddon.fit();
      // 握手完成前不能发 resize：此时服务端还没有会话，任何非 connect 消息都会被判成重复
      // 连接，进而把正在进行的握手一起掐断。进入终端必然会触发 ResizeObserver（布局变化），
      // 所以这个时序很容易命中；真实尺寸在 markReady 里补发一次。
      if (send && connectionState === 'connected' && socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
      }
    } catch {
      // The terminal can be temporarily dimensionless during a panel drawer transition.
    }
  });
}

function setPanelOpen(open: boolean): void {
  const view = resolveConnectionPanel(open);
  panelOpen = view.expanded;
  if (!view.expanded && (connectionState === 'connecting' || connectionState === 'connected' || connectionState === 'disconnecting')) {
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
  if (!sessionStartedAt) {
    ui.metricUptime.textContent = '00:00';
    return;
  }
  const seconds = Math.max(0, Math.floor((Date.now() - sessionStartedAt) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  ui.metricUptime.textContent = hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function startTimers(): void {
  stopTimers();
  sessionStartedAt = Date.now();
  updateUptime();
  uptimeTimer = window.setInterval(updateUptime, 1_000);
  pingTimer = window.setInterval(() => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'ping' }));
  }, PING_INTERVAL_MS);
}

function stopTimers(): void {
  if (uptimeTimer !== null) window.clearInterval(uptimeTimer);
  if (pingTimer !== null) window.clearInterval(pingTimer);
  uptimeTimer = null;
  pingTimer = null;
  sessionStartedAt = 0;
}

function markReady(message = bilingual('交互式 Shell 已就绪', 'Interactive shell ready')): void {
  if (connectionState === 'connected') return;
  invalidateHistoryPasswordLoad();
  setState('connected');
  setPanelOpen(false);
  profileSaveTask = saveConnectedProfile().catch(() => {
    toast(bilingual('连接成功，但无法更新历史记录。', 'Connected, but the history could not be updated.'), 'error');
  });
  startTimers();
  updateConnectionStatus(messageTranslation(message));
  filePage?.setMessage('');
  event(message, 'ready');
  if (currentInitialCommand && !initialCommandSent) {
    initialCommandSent = true;
    const command = currentInitialCommand;
    const activeSocket = socket;
    const generation = connectGeneration;
    window.setTimeout(() => {
      if (socket !== activeSocket || generation !== connectGeneration) return;
      sendTerminalData(`${command}\r`);
    }, 120);
  }
  if (document.body.dataset.view === 'workspace') terminal.focus();
  // 补发真实尺寸：握手期间因为布局变化产生的 resize 都被抑制了，这里对齐一次。
  requestAnimationFrame(() => fitTerminal(true));
}

function sendHostKeyDecision(accept: boolean): void {
  if (!awaitingHostKeyDecision || !pendingHostKey || socket?.readyState !== WebSocket.OPEN) return;
  const hostKey = pendingHostKey;
  awaitingHostKeyDecision = false;
  pendingHostKey = null;
  socket.send(JSON.stringify({
    type: 'host_key_decision',
    accept,
    fingerprint: hostKey.fingerprint,
  }));
  if (accept && ui.rememberHostKey.checked && currentTargetKey) {
    currentRememberedFingerprint = hostKey.fingerprint;
    void replaceRememberedHostKey(currentTargetKey, hostKey.fingerprint);
    if (targetKey() === currentTargetKey) ui.fingerprint.value = hostKey.fingerprint;
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

function clearHostKeyPrompt(): void {
  awaitingHostKeyDecision = false;
  pendingHostKey = null;
  if (ui.hostKeyDialog.open) ui.hostKeyDialog.close('reject');
  ui.hostKeyDialog.returnValue = '';
}

function handleServerMessage(message: ServerMessage): void {
  const type = message.type ?? 'status';
  if (type === 'system_info') {
    const system = readServerSystemInfo(message.system);
    if (!system) {
      event(bilingual('收到无效的系统探测结果。', 'Received an invalid system probe result.'), 'protocol', true);
      return;
    }
    const label = [system.name, system.version, system.architecture].filter(Boolean).join(' · ');
    event(bilingual(`已探测操作系统：${label}`, `Detected operating system: ${label}`), 'system');
    void persistDetectedSystem(currentTargetKey, system);
    return;
  }
  if (type === 'sftp_attach') {
    if (typeof message.url !== 'string' || !message.url.startsWith('/api/sftp?')) {
      event(bilingual('收到无效的文件管理连接信息。', 'Received invalid file-management connection details.'), 'protocol', true);
      return;
    }
    try {
      fileManager.attach(message.url);
    } catch {
      event(bilingual('无法打开文件管理连接。', 'Could not open the file-management connection.'), 'sftp', true);
      return;
    }
    fileTree.setReady(true);
    event(bilingual('文件管理通道已可用。', 'File management channel is available.'), 'sftp');
    return;
  }
  if (type === 'process_attach') {
    if (typeof message.url !== 'string' || !message.url.startsWith('/api/processes?')) {
      event(bilingual('收到无效的进程监控连接信息。', 'Received invalid process-monitor connection details.'), 'protocol', true);
      return;
    }
    try {
      processManager.attach(message.url);
    } catch {
      event(bilingual('无法打开进程监控连接。', 'Could not open the process-monitor connection.'), 'process', true);
      return;
    }
    event(bilingual('进程监控通道已可用。', 'Process monitor channel is available.'), 'process');
    return;
  }
  if (type === 'host_key') {
    const fingerprint = message.fingerprint ?? '';
    const keyType = message.keyType ?? '';
    const expected = message.expectedFingerprint ?? currentExpectedFingerprint;
    if (!SSH_FINGERPRINT_RE.test(fingerprint)
      || !/^[A-Za-z0-9@._+-]{1,128}$/.test(keyType)
      || typeof message.trusted !== 'boolean'
      || (expected !== '' && !SSH_FINGERPRINT_RE.test(expected))
      || (message.expectedFingerprint !== undefined && message.expectedFingerprint !== currentExpectedFingerprint)) {
      event(bilingual('收到无效的主机密钥消息。', 'Received an invalid host key message.'), 'protocol', true);
      socket?.close(CLIENT_CLOSE_PROTOCOL_ERROR, 'Invalid host key message');
      return;
    }
    ui.metricHostKey.textContent = keyType.replace('ssh-', '').replace('ecdsa-sha2-', '');
    ui.metricHostKey.title = fingerprint;
    const trust = classifyHostKey(expected, fingerprint);
    if (message.trusted !== (trust === 'matched')) {
      event(bilingual('收到不一致的主机密钥信任消息。', 'Received an inconsistent trusted host key message.'), 'protocol', true);
      socket?.close(CLIENT_CLOSE_PROTOCOL_ERROR, 'Invalid trusted host key message');
      return;
    }
    if (trust === 'matched') {
      event(bilingual('已固定的主机密钥匹配。', 'Pinned host key matched.'), 'host-key');
      return;
    }
    pendingHostKey = { fingerprint, keyType, expectedFingerprint: expected, trust };
    awaitingHostKeyDecision = true;
    configureHostKeyDialog(pendingHostKey);
    ui.hostKeyTarget.textContent = ui.sessionTitle.textContent ?? currentTargetKey;
    ui.hostKeyType.textContent = keyType;
    ui.hostKeyFingerprint.textContent = fingerprint;
    ui.rememberHostKey.checked = true;
    event(trust === 'changed'
      ? bilingual(`认证已暂停：主机密钥从 ${expected} 变为 ${fingerprint}`, `Authentication paused: host key changed from ${expected} to ${fingerprint}`)
      : bilingual(`认证已暂停，请确认首次见到的主机密钥 ${fingerprint}`, `Authentication paused for first-seen host key ${fingerprint}`), 'host-key', trust === 'changed');
    if (!ui.hostKeyDialog.open) {
      ui.hostKeyDialog.returnValue = '';
      ui.hostKeyDialog.showModal();
    }
    return;
  }
  if (type === 'ready') {
    markReady(bilingualServerMessage(message.message, message.event ?? 'ready', 'Interactive shell ready'));
    return;
  }
  if (type === 'error') {
    const text = bilingualServerMessage(message.message, message.event, 'The SSH session failed.', 'SSH 错误');
    const failedSocket = socket;
    event(text, message.event ?? 'error', true);
    showFormError(text);
    toast(text, 'error');
    if (message.retryable === false) {
      // 客户端随后以 4000 关闭会遮住服务端关闭码，先停止重连才能避免重试旧凭据。
      sshReconnectManager?.reset();
      sshReconnectManager = null;
      reconnectParams = null;
    }
    failActiveConnection(failedSocket, 'SSH session failed', messageTranslation(text));
    return;
  }
  if (type === 'debug') {
    event(bilingualServerMessage(message.message, message.event, 'Debug event'), 'debug');
    return;
  }
  if (type === 'status') {
    const text = bilingualServerMessage(message.message, message.event, 'SSH handshake in progress');
    event(text, message.event ?? 'status');
    updateConnectionStatus(messageTranslation(text));
    if (message.event === 'shell_ready' || message.event === 'ready') markReady(text);
  }
}

async function handleSocketData(data: string | ArrayBuffer | Blob, activeSocket: WebSocket, generation: number): Promise<void> {
  if (socket !== activeSocket || generation !== connectGeneration) return;
  if (typeof data === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      event(bilingual('已忽略无效的控制帧。', 'Ignored an invalid control frame.'), 'protocol', true);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      event(bilingual('已忽略无效的控制帧。', 'Ignored an invalid control frame.'), 'protocol', true);
      return;
    }
    try {
      handleServerMessage(parsed as ServerMessage);
    } catch {
      event(bilingual('处理服务器控制消息时发生错误。', 'Failed to process the server control message.'), 'protocol', true);
      if (activeSocket.readyState < WebSocket.CLOSING) {
        activeSocket.close(CLIENT_CLOSE_PROTOCOL_ERROR, 'Control message handling failed');
      }
    }
    return;
  }
  const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data);
  if (socket !== activeSocket || generation !== connectGeneration) return;
  if (decoder.encoding === 'utf-8') terminal.write(bytes);
  else terminal.write(decoder.decode(bytes, { stream: true }));
}

function sendTerminalData(data: string): void {
  if (socket?.readyState !== WebSocket.OPEN || connectionState !== 'connected' || !data) return;
  socket.send(JSON.stringify({ type: 'input', data }));
}

function failActiveConnection(activeSocket: WebSocket | null, closeReason: string, displayReason: LocalizedMessage): void {
  if (activeSocket && socket === activeSocket) socket = null;
  connectGeneration++;
  currentSessionId = '';
  pendingHistory = null;
  authorizationAbort?.abort();
  authorizationAbort = null;
  currentExpectedFingerprint = '';
  currentRememberedFingerprint = '';
  stopTimers();
  fileManager.reset();
  fileTree?.setReady(false);
  processManager.reset();
  resetNetworkMetric();
  clearHostKeyPrompt();
  invalidateHistoryPasswordLoad();
  updateConnectionStatus(displayReason);
  setState('error');
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
function createSshReconnectFactory(): (attempt: number) => Promise<WebSocket> {
  return async (attempt: number): Promise<WebSocket> => {
    const params = reconnectParams!;
    const abortController = new AbortController();
    const { ticket, sessionId } = await issueTicket(abortController.signal);
    currentSessionId = sessionId;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL('/api/ssh', location.href);
    url.protocol = protocol;
    url.searchParams.set('ticket', ticket);
    url.searchParams.set('session', sessionId);

    const generation = ++connectGeneration;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => {
      if (generation !== connectGeneration) {
        ws.close(1000, 'Connection superseded');
        return;
      }
      // Reset terminal for the new session.
      resetTerminalForConnection(terminal);
      fitTerminal(true);

      const config: ConnectionConfig = {
        type: 'connect',
        host: params.host,
        port: params.port,
        username: params.username,
        authMethod: params.authMethod as AuthMethod,
        cols: terminal.cols,
        rows: terminal.rows,
        term: params.term,
      };
      if (params.authMethod === 'password') config.password = params.password;
      else if (params.keychainId) config.keychainId = params.keychainId;
      else config.privateKey = params.privateKey;
      // 重连时口令必须一并回传，否则加密私钥会在第二次握手上解不开。
      if (params.authMethod === 'publickey' && params.keyPassphrase) config.keyPassphrase = params.keyPassphrase;
      if (params.pinnedKey) config.expectedFingerprint = params.pinnedKey;

      ws.send(JSON.stringify(config));
      updateConnectionStatus(localized('正在打开 TCP 连接...', 'Opening TCP connection...'));
      event(bilingual('WebSocket 已建立，正在打开 SSH 传输（自动重连）。', 'WebSocket established; opening SSH transport (auto-reconnect).'), 'transport');
    }, { once: true });

    ws.addEventListener('message', (socketEvent) => {
      void handleSocketData(socketEvent.data as string | ArrayBuffer | Blob, ws, generation);
    });

    ws.addEventListener('error', () => {
      if (socket !== ws) return;
      const message = localized('WebSocket 传输错误。', 'WebSocket transport error.');
      event(localize(message), 'transport', true);
    });

    socket = ws;
    currentExpectedFingerprint = params.pinnedKey ?? '';
    decoder = createDecoder(params.encoding);
    return ws;
  };
}

/** Handles reconnect lifecycle events and updates the SSH UI accordingly. */
function handleSshReconnectLog(entry: ReconnectLogEntry): void {
  if (entry.event === 'disconnect' && entry.code === SERVER_CLOSE_AUTH_DEFECT) {
    // 控制帧丢失时以关闭码兜底；统一覆盖首次连接和重连工厂创建的 socket。
    sshReconnectManager?.reset();
    sshReconnectManager = null;
    reconnectParams = null;
    const reason = bilingual('SSH 认证或主机密钥确认失败，请检查后重试。', 'SSH authentication or host key approval failed; check the settings and try again.');
    showFormError(reason);
    event(reason, 'disconnect', true);
    toast(reason, 'error');
    failActiveConnection(socket, 'SSH authentication failed', messageTranslation(reason));
  } else if (entry.event === 'give_up') {
    // Reconnect exhausted — perform full cleanup that was deferred.
    const reason = bilingual('SSH 重连失败，已达最大重试次数。', 'SSH reconnect failed; maximum retries reached.');
    event(reason, 'disconnect', true);
    updateConnectionStatus(messageTranslation(reason));
    setState('error');
    toast(reason, 'error');
    fileManager.reset();
    fileTree?.setReady(false);
    processManager.reset();
  } else if (entry.event === 'reconnect_attempt') {
    updateConnectionStatus(localized(
      `正在重连 SSH（${entry.attempt}/${entry.maxAttempts}）…`,
      `Reconnecting SSH (${entry.attempt}/${entry.maxAttempts})…`,
    ));
  } else if (entry.event === 'reconnect_success') {
    event(bilingual('SSH 重连成功。', 'SSH reconnected successfully.'), 'connect');
  }
}

async function connect(): Promise<void> {
  if (historyPasswordLoading) return;
  applyFormDefaults();
  if (connectionState === 'connecting' || connectionState === 'connected' || connectionState === 'disconnecting') {
    // Repeat clicks for the host already online stay a no-op (this also keeps
    // the reconnect manager from dialling twice).
    if (targetKey() === currentTargetKey) return;
    // A different target means "switch session": this page carries one session
    // at a time. Validate before tearing down, so a typo never drops the live
    // session, then retire it instead of silently doing nothing.
    if (validateConnectForm()) return;
    if (!(await disconnect(bilingual('已切换到新的主机目标', 'Switched to a new host target')))) return;
    await waitForIdle();
    if (connectionState === 'connecting' || connectionState === 'connected' || connectionState === 'disconnecting') return;
  }
  if (socket || authorizationAbort) return;
  historyPasswordLoadGeneration++;
  historyPasswordLoading = false;
  // Fresh baseline for a new session: the previous run may have left network
  // state (interface list, baselines) if the user navigated away uncleanly.
  resetNetworkMetric();
  const validationError = validateConnectForm();
  if (validationError) {
    showFormError(validationError);
    return;
  }
  if (document.body.dataset.view !== 'files') dashboard?.openWorkspace();
  if (location.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
    showFormError(bilingual('发送 SSH 凭据前必须使用 HTTPS。', 'HTTPS is required before SSH credentials can be sent.'));
    return;
  }

  ui.formError.hidden = true;
  currentFormError = null;
  const generation = ++connectGeneration;
  const abortController = new AbortController();
  authorizationAbort = abortController;
  ui.terminalEmpty.hidden = true;
  resetTerminalForConnection(terminal);
  fitTerminal(false);

  const host = normalizeHost(ui.host.value);
  const port = Number(ui.port.value);
  const username = ui.username.value.trim();
  currentTargetKey = targetKey(host, port, username);
  currentTargetLabel = targetLabel(host, port, username);
  setState('connecting');
  const pinnedKey = ui.fingerprint.value.trim() || hostKeys[currentTargetKey] || '';
  currentExpectedFingerprint = pinnedKey;
  currentRememberedFingerprint = '';
  if (pinnedKey) ui.fingerprint.value = pinnedKey;
  // 文件管理不应在隐藏终端里执行用户的初始命令；保存的主机配置仍保持原样。
  currentInitialCommand = document.body.dataset.view === 'files' ? '' : ui.initialCommand.value;
  initialCommandSent = false;
  pendingHostKey = null;
  awaitingHostKeyDecision = false;
  decoder = createDecoder(ui.encoding.value);
  ui.sessionTitle.textContent = currentTargetLabel;
  updateConnectionStatus(localized('正在授权 Worker 会话...', 'Authorizing Worker session...'));
  ui.metricHostKey.textContent = '--';
  event(bilingual(`正在连接 ${currentTargetLabel}`, `Starting ${currentTargetLabel}`), 'connect');

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
    pendingHistory = { generation, target: currentTargetKey, profile: historyProfile };
    const ticketRequest = issueTicket(abortController.signal);
    const { ticket, sessionId } = await ticketRequest;
    currentSessionId = sessionId;
    if (authorizationAbort === abortController) authorizationAbort = null;
    if (generation !== connectGeneration) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL('/api/ssh', location.href);
    url.protocol = protocol;
    url.searchParams.set('ticket', ticket);
    url.searchParams.set('session', sessionId);

    const activeSocket = new WebSocket(url);
    socket = activeSocket;
    activeSocket.binaryType = 'arraybuffer';

    // Persist connection parameters so the reconnect factory can reuse them.
    reconnectParams = { host, port, username, authMethod: method, term, encoding: ui.encoding.value };
    if (method === 'password') reconnectParams.password = password;
    else if (keychainId) reconnectParams.keychainId = keychainId;
    else reconnectParams.privateKey = privateKey;
    if (keychainId || privateKey) reconnectParams.keyPassphrase = keyPassphrase;
    if (pinnedKey) reconnectParams.pinnedKey = pinnedKey;

    // Set up (or replace) the SSH reconnect manager.
    sshReconnectManager?.reset();
    sshReconnectManager = new WebSocketReconnectManager({
      id: 'SSH',
      onConnect: createSshReconnectFactory(),
      onLog: handleSshReconnectLog,
      nonRetryableCloseCodes: [SERVER_CLOSE_AUTH_DEFECT],
    });
    sshReconnectManager.attach(activeSocket);

    activeSocket.addEventListener('open', () => {
      if (socket !== activeSocket || generation !== connectGeneration) {
        activeSocket.close(1000, 'Connection attempt superseded');
        return;
      }
      fitTerminal(false);
      const config: ConnectionConfig = {
        type: 'connect',
        host,
        port,
        username,
        authMethod: method,
        cols: terminal.cols,
        rows: terminal.rows,
        term,
      };
      if (method === 'password') config.password = password;
      else if (keychainId) config.keychainId = keychainId;
      else config.privateKey = privateKey;
      if (method === 'publickey' && keyPassphrase) config.keyPassphrase = keyPassphrase;
      if (pinnedKey) config.expectedFingerprint = pinnedKey;
      activeSocket.send(JSON.stringify(config));
      updateConnectionStatus(localized('正在打开 TCP 连接...', 'Opening TCP connection...'));
      event(bilingual('WebSocket 已建立，正在打开 SSH 传输。', 'WebSocket established; opening SSH transport.'), 'transport');
    }, { once: true });
    activeSocket.addEventListener('message', (socketEvent) => {
      void handleSocketData(socketEvent.data as string | ArrayBuffer | Blob, activeSocket, generation);
    });
    activeSocket.addEventListener('error', () => {
      if (socket !== activeSocket) return;
      const message = localized('WebSocket 传输错误。', 'WebSocket transport error.');
      event(localize(message), 'transport', true);
      showFormError(localize(message));
      toast(localize(message), 'error');
      failActiveConnection(activeSocket, 'WebSocket transport error', message);
    });
    activeSocket.addEventListener('close', (closeEvent) => {
      if (socket !== activeSocket) return;
      socket = null;
      currentSessionId = '';
      pendingHistory = null;
      currentExpectedFingerprint = '';
      currentRememberedFingerprint = '';
      const wasActive = connectionState === 'connected';
      const isUnexpected = closeEvent.code !== 1000 && closeEvent.code !== 1005;

      if (isUnexpected && sshReconnectManager) {
        // The reconnect manager will attempt reconnection autonomously.
        // Skip tearing down child connections — they each have their own
        // reconnect logic that fires independently.
        stopTimers();
        resetNetworkMetric();
        clearHostKeyPrompt();
        invalidateHistoryPasswordLoad();
        const reason = bilingual('SSH 连接断开，正在重连…', 'SSH connection lost; reconnecting…');
        event(reason, 'disconnect', true);
        updateConnectionStatus(messageTranslation(reason));
        setState('connecting');
        if (wasActive) toast(reason, 'error');
        return;
      }

      // Normal close or reconnect not available — full cleanup.
      stopTimers();
      fileManager.reset();
      fileTree?.setReady(false);
      processManager.reset();
      resetNetworkMetric();
      clearHostKeyPrompt();
      invalidateHistoryPasswordLoad();
      const reason = closeEvent.reason
        ? bilingualServerMessage(closeEvent.reason)
        : closeEvent.code === 1000
          ? bilingual('会话已关闭。', 'Session closed.')
          : bilingual(`会话已关闭（${closeEvent.code}）。`, `Session closed (${closeEvent.code}).`);
      event(reason, 'disconnect', isUnexpected);
      updateConnectionStatus(messageTranslation(reason));
      setState(isUnexpected ? 'error' : 'idle');
      if (wasActive) toast(reason, isUnexpected ? 'error' : 'info');
    });
  } catch (error) {
    if (authorizationAbort === abortController) authorizationAbort = null;
    if (generation !== connectGeneration) return;
    pendingHistory = null;
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
    setState('error');
  }
}

async function disconnect(reason = bilingual('已由用户断开连接', 'Disconnected by user'), force = false): Promise<boolean> {
  if (connectionState === 'disconnecting') return false;
  // 编辑器里的未保存改动先自动保存；保存失败则阻止断开，避免静默丢字。
  const requestedGeneration = connectGeneration;
  if (!force && !(await fileManager.prepareDisconnect())) return false;
  if (requestedGeneration !== connectGeneration) return false;
  // prepareDisconnect 期间连接状态可能已经变化，再确认一次。
  if ((connectionState as ConnectionState) === 'disconnecting') return false;
  const generation = ++connectGeneration;
  setState('disconnecting');
  currentSessionId = '';
  pendingHistory = null;
  authorizationAbort?.abort();
  authorizationAbort = null;
  const activeSocket = socket;
  socket = null;
  sshReconnectManager?.reset();
  sshReconnectManager = null;
  reconnectParams = null;
  stopTimers();
  fileManager.reset();
  fileTree?.setReady(false);
  processManager.reset();
  resetNetworkMetric();
  clearHostKeyPrompt();
  invalidateHistoryPasswordLoad();
  currentExpectedFingerprint = '';
  currentRememberedFingerprint = '';
  updateConnectionStatus(messageTranslation(reason));
  event(reason, 'disconnect');
  let settled = false;
  const finish = (): void => {
    if (settled) return;
    settled = true;
    if (generation === connectGeneration && connectionState === 'disconnecting') setState('idle');
  };
  if (activeSocket && activeSocket.readyState < WebSocket.CLOSED) {
    activeSocket.addEventListener('close', finish, { once: true });
    if (activeSocket.readyState < WebSocket.CLOSING) activeSocket.close(1000, 'Disconnected by user');
    window.setTimeout(finish, 1_000);
  } else {
    window.setTimeout(finish, 180);
  }
  return true;
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
    if (connectionState === 'connecting' || connectionState === 'connected' || connectionState === 'disconnecting') {
      throw new Error(bilingual('已有活动的 SSH 连接', 'An SSH connection is already active'));
    }
    const options: WSSHOptions = typeof optionsOrHost === 'string'
      ? { host: optionsOrHost, port, username, password, privateKey }
      : optionsOrHost;
    applyWSSHOptions(options);
    await connect();
  };
  window.wssh = {
    connect: compatibilityConnect as WSSHCompatibilityAPI['connect'],
    send: sendTerminalData,
    resize: () => fitTerminal(true),
    set_encoding: (encoding: string) => {
      ui.encoding.value = encoding;
      decoder = createDecoder(encoding);
    },
    reset_encoding: () => {
      ui.encoding.value = 'utf-8';
      decoder = new TextDecoder('utf-8');
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
    void disconnect(connectionState === 'connecting'
      ? bilingual('连接已取消', 'Connection cancelled')
      : bilingual('已由用户断开连接', 'Disconnected by user'));
  } else if (connectionState !== 'disconnecting') {
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
    if (target && pendingHistory?.target === passwordContext(target)) pendingHistory = null;
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
    if (connectionState === 'connecting' || connectionState === 'connected' || connectionState === 'disconnecting') ui.connect.focus();
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
ui.clearTerminal.addEventListener('click', () => terminal.clear());
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
  setState(connectionState);
  setPanelOpen(panelOpen);
  if (connectionState === 'idle' && !currentTargetLabel) ui.sessionTitle.textContent = bilingual('无活动会话', 'No active session');
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
  sendHostKeyDecision(ui.hostKeyDialog.returnValue === 'accept');
});
// Bind the network interface selector once. Options are rebuilt by
// syncNetworkSelectOptions() only when the interface list changes, so the
// element keeps focus while the user interacts with it.
ui.resourceNetworkSelect.addEventListener('change', () => {
  const next = ui.resourceNetworkSelect.value;
  if (!next || next === netSelectedIface) return;
  netSelectedIface = next;
  resetNetworkBaseline();
  updateNetworkIfaceLabel();
});
terminal.onData((data) => terminalTools?.handleTerminalData(data));
new ResizeObserver(() => fitTerminal(true)).observe(ui.terminalStage);
window.addEventListener('beforeunload', (event) => {
  // 3 秒防抖窗口里的输入还在编辑器内存中，卸载时同步保存不可行：交给浏览器原生提示。
  if (fileManager.hasUnsavedEditorChanges()) {
    event.preventDefault();
    event.returnValue = '';
    // 用户可能选择留在本页；此时不能 reset，否则编辑器被销毁、改动照样丢。
    return;
  }
  fileManager.reset();
  fileTree?.setReady(false);
  fileTree?.destroy();
  processManager.reset();
  resetNetworkMetric();
  socket?.close(1000, 'Page closed');
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
  ui.sessionTitle.textContent = bilingual('无活动会话', 'No active session');
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
    disconnect: async () => { await disconnect(); },
    openTerminal: () => {
      dashboard?.openWorkspace();
      if (connectionState === 'idle' || connectionState === 'error') setPanelOpen(true);
    },
  }, fileManager);
  keychain = new Keychain(() => dashboard?.openWorkspace());
  keychain.addEventListener('change', () => fillKeychainSelect(ui.keychainId, keychain.keys));
  ui.form.querySelector('input[name="authMethod"][value="keychain"]')!.addEventListener('change', () => void keychain.load());
  element('manage-keychain').addEventListener('click', () => dashboard?.showKeychain());
  dashboard = new Dashboard({
    keychain,
    files: filePage,
    snippets: new Snippets(ui.terminalCard, (snippet) => {
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
    quickConnect: () => {
      clearForm();
      setPanelOpen(true);
      requestAnimationFrame(() => { fitTerminal(false); ui.host.focus(); });
    },
    leaveWorkspace: async (force = false) => {
      if (!(await disconnect(bilingual('已返回主机总览', 'Returned to host dashboard'), force))) return false;
      clearCredentials();
      return true;
    },
  });
  await dashboard.start();
}

void initialize().catch((error) => {
  toast(error instanceof Error ? error.message : '初始化失败，请刷新页面重试。', 'error');
});
