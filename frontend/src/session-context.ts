// Per-session state container for the terminal workspace.
//
// Historically every SSH-dependent value lived as a module-level `let` in
// `main.ts`, which structurally limited the page to a single connection. This
// class is the first step of the multi-session refactor: it gathers those
// variables so several independent contexts can coexist. `SessionManager`
// owns the collection and decides which context is bound to the shared DOM.
//
// Nothing here touches the document. Rendering-only state (language, theme,
// event log elements) deliberately stays global in `main.ts`.

import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import type { FileManager } from './file-manager';
import type { FileTree } from './file-tree';
import type { CloudHost, Credentials } from './cloud-api';
import type { HostKeyPrompt } from './host-key';
import type { ProcessManager } from './process-manager';
import type { WebSocketReconnectManager } from './ws-reconnect';

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnecting' | 'error';

export interface LocalizedMessage {
  zh: string;
  en: string;
}

/** Credential snapshot taken at dial time so a reconnect never re-reads the form. */
export interface ReconnectParams {
  host: string;
  port: number;
  username: string;
  authMethod: string;
  password?: string;
  privateKey?: string;
  keychainId?: string;
  keyPassphrase?: string;
  pinnedKey?: string;
  term: string;
  encoding: string;
}

/** Depth of the per-session throughput ring buffer. Shared with the renderer. */
export const NET_SPARK_POINTS = 60;

export type SavedProfileRef = CloudHost & Credentials;

export interface PendingHistory {
  generation: number;
  target: string;
  profile: Promise<SavedProfileRef>;
}

export interface NetworkBaseline {
  rx: number;
  tx: number;
  ts: number;
}

export interface SessionContextOptions {
  /** Locally generated id — never the backend Durable Object id. */
  id: string;
}

export class SessionContext {
  readonly id: string;

  /** Backend Durable Object id, empty until the ticket is issued. */
  backendSessionId = '';

  state: ConnectionState = 'idle';
  startedAt = 0;

  socket: WebSocket | null = null;
  /** Bumped on every teardown so late async callbacks can detect staleness. */
  generation = 0;
  decoder = new TextDecoder('utf-8');
  authorizationAbort: AbortController | null = null;

  uptimeTimer: number | null = null;
  pingTimer: number | null = null;
  resizeFrame = 0;

  /** Normalised `user@host:port` used to match sessions against dashboard rows. */
  targetKey = '';
  targetLabel = '';
  initialCommand = '';
  initialCommandSent = false;

  // Host-key verification is per-session: two sessions may be prompting for
  // two different hosts at the same time.
  pendingHostKey: HostKeyPrompt | null = null;
  awaitingHostKeyDecision = false;
  expectedFingerprint = '';
  rememberedFingerprint = '';

  // Per-session header/status copy. Rendered only while this context is active.
  subtitle: LocalizedMessage = { zh: '选择目标并连接', en: 'Choose a target and connect' };
  eventMessage: LocalizedMessage = { zh: 'Worker 运行时待命', en: 'Worker runtime standing by' };

  pendingHistory: PendingHistory | null = null;

  reconnectManager: WebSocketReconnectManager | null = null;
  reconnectParams: ReconnectParams | null = null;

  // Network metrics arrive per SSH connection, so every session needs its own
  // baseline map and ring buffer; sharing them produced bogus rate spikes.
  netBaselines = new Map<string, NetworkBaseline>();
  netIfaceList: string[] = [];
  netSelectedIface: string | null = null;
  readonly netSpark = new Float32Array(NET_SPARK_POINTS);
  netSparkIdx = 0;
  netSparkFilled = 0;

  /** Terminal + auxiliary channels. Assigned once during bootstrap. */
  terminal!: Terminal;
  fitAddon!: FitAddon;
  fileManager!: FileManager;
  fileTree!: FileTree;
  processManager!: ProcessManager;

  /**
   * Per-session xterm host inside `#terminal-stage`. Created lazily by
   * `mountTerminal()`, and the same session always reuses the same node so a
   * background session keeps its scrollback and rendered buffer while another
   * tab is in front.
   */
  terminalEl: HTMLElement | null = null;
  /** Guards `Terminal.open()`: xterm may only attach to a host once. */
  terminalOpened = false;

  constructor(options: SessionContextOptions) {
    this.id = options.id;
  }

  get connected(): boolean {
    return this.state === 'connected';
  }

  /** True while the SSH socket exists and can still carry traffic. */
  get socketOpen(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }
}
