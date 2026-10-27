import type { CloudHost } from './cloud-api';
import type { FileManager } from './file-manager';
import type { ArboristFileList } from './file-list';
import type { SessionSummary } from './session-manager';
import './file-page.css';

export type FileConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnecting' | 'error';

/** States worth offering in the picker — an idle shell has no files to show. */
const LIVE_STATES: ReadonlySet<string> = new Set(['connecting', 'connected', 'disconnecting']);

interface FilePageActions {
  connect(host: CloudHost): Promise<void>;
  disconnect(): void;
  openTerminal(): void;
  /** Same read-only session snapshot the dashboard works with. */
  sessions(): SessionSummary[];
  activeSessionId(): string | null;
  activateSession(id: string): void;
}

const folderIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M3 9h18"/></svg>';

/** 页面只负责主机选择和布局；移动同一个面板，避免为同一 SSH 会话重复附着 SFTP。 */
export class FilePage {
  readonly root = document.createElement('main');
  private readonly dockMarker = document.createComment('shared-file-manager');
  private readonly select: HTMLSelectElement;
  private readonly connectButton: HTMLButtonElement;
  private hosts: CloudHost[] = [];
  private state: FileConnectionState = 'idle';
  private preparing = false;
  private mounted = false;
  private list: ArboristFileList | null = null;
  private activeTarget: { id?: string; label: string } | null = null;
  /**
   * The file panel is shared DOM, so its manager travels with the front session
   * instead of being captured once at construction.
   */
  private manager?: FileManager;
  private readonly sessionField: HTMLElement;
  private readonly sessionSelect: HTMLSelectElement;

  constructor(private readonly panel: HTMLElement, private readonly actions: FilePageActions) {
    panel.before(this.dockMarker);
    this.root.className = 'files-page';
    this.root.hidden = true;
    this.root.innerHTML = `
      <header class="files-heading">
        <div><p class="home-eyebrow">REMOTE FILES</p><h1 id="files-heading" tabindex="-1">文件管理</h1>
          <p>在服务器之间切换，让每一份文件井然有序。</p></div>
        <button class="home-button" id="files-terminal" type="button">打开 SSH 终端 ↗</button>
      </header>
      <section class="files-connection" aria-label="文件管理连接">
        <span class="files-host-icon">${folderIcon}</span>
        <label class="files-host-field" for="files-host"><span>目标主机</span>
          <select id="files-host" aria-describedby="files-host-hint"><option value="">请选择主机</option></select>
        </label>
        <button id="files-connect" class="home-button primary" type="button" disabled>连接主机</button>
        <div class="files-connection-meta"><span id="files-connection-state" class="files-state" data-state="idle" role="status">未连接</span>
          <span id="files-host-hint">使用已保存的 SSH 凭据安全连接</span></div>
        <label class="files-host-field files-session-field" id="files-session-field" hidden for="files-session"><span>作用会话</span>
          <select id="files-session" aria-label="作用会话"></select></label>
      </section>
      <p id="files-notice" class="files-notice" role="status" hidden></p>
      <section class="files-browser" aria-label="远程文件">
        <div class="files-browser-heading"><strong>${folderIcon}远程目录</strong><span>SFTP · 加密传输</span></div>
        <div class="files-panel-slot"></div>
      </section>
      <footer class="files-footer"><span>双击目录进入 · 选中文件后操作 · 路径栏按 Enter 跳转</span>
        <span>单文件 ≤ 64 MiB · 仅支持删除空目录</span></footer>`;
    this.select = this.get<HTMLSelectElement>('#files-host');
    this.connectButton = this.get<HTMLButtonElement>('#files-connect');
    this.sessionField = this.get('#files-session-field');
    this.sessionSelect = this.get<HTMLSelectElement>('#files-session');
    this.select.addEventListener('change', () => this.renderConnection());
    this.sessionSelect.addEventListener('change', () => {
      const id = this.sessionSelect.value;
      if (id) this.actions.activateSession(id);
    });
    this.connectButton.addEventListener('click', () => void this.toggleConnection());
    this.get('#files-terminal').addEventListener('click', () => this.actions.openTerminal());
  }

  private get<T extends HTMLElement = HTMLElement>(selector: string): T {
    return this.root.querySelector<T>(selector)!;
  }

  show(): void {
    this.mounted = true;
    this.root.hidden = false;
    this.refreshSessions();
    this.get('.files-panel-slot').append(this.panel);
    this.panel.hidden = false;
    this.panel.setAttribute('role', 'region');
    this.panel.setAttribute('aria-labelledby', 'files-heading');
    this.get('#files-heading').focus();
    void this.mountList();
  }

  private async mountList(): Promise<void> {
    try {
      // 按需加载 React 和 Arborist，不增加总览及原终端首次打开的脚本负担。
      const { ArboristFileList } = await import('./file-list');
      if (!this.mounted || this.list) return;
      const host = document.createElement('div');
      host.className = 'files-list';
      this.panel.querySelector('.file-table-wrap')!.prepend(host);
      this.list = new ArboristFileList(host, {
        select: (index) => this.manager?.selectEntry(index),
        activate: (index) => this.manager?.activateIndex(index),
      });
      this.panel.querySelector<HTMLTableElement>('.file-table')!.hidden = true;
      this.manager?.setListView(this.list);
    } catch {
      this.manager?.setListView(null);
      this.list?.destroy();
      this.list = null;
      this.panel.querySelector<HTMLTableElement>('.file-table')!.hidden = false;
      if (this.mounted) this.setMessage('文件列表组件加载失败，请刷新页面重试。当前仍可使用原文件表格。', true);
    }
  }

  hide(): void {
    if (!this.mounted) return;
    this.mounted = false;
    this.list?.destroy();
    this.list = null;
    this.panel.querySelector<HTMLTableElement>('.file-table')!.hidden = false;
    this.manager?.setListView(null);
    this.root.hidden = true;
    this.dockMarker.after(this.panel);
    this.panel.setAttribute('role', 'tabpanel');
    this.panel.setAttribute('aria-labelledby', 'file-manager-tab');
    this.panel.hidden = document.getElementById('file-manager-tab')!.getAttribute('aria-selected') !== 'true';
  }

  /**
   * Called whenever the front session changes: the panel's manager is per
   * session, so the page must follow whoever owns the shared DOM now.
   */
  setManager(manager: FileManager | undefined): void {
    if (this.manager === manager) return;
    this.manager?.setListView(null);
    this.manager = manager;
    // The list itself is loaded once; a new owner just gets it back.
    manager?.setListView(this.list);
  }

  /** Session picker: which of the live sessions the file panel acts on. */
  refreshSessions(): void {
    const live = this.actions.sessions().filter((session) => LIVE_STATES.has(session.state));
    this.sessionField.hidden = live.length === 0;
    if (!live.length) { this.sessionSelect.replaceChildren(); return; }
    const serials = new Map<string, number>();
    const options = live.map((session) => {
      const serial = (serials.get(session.targetKey) ?? 0) + 1;
      serials.set(session.targetKey, serial);
      return new Option(this.describe(session, serial), session.id);
    });
    this.sessionSelect.replaceChildren(...options);
    const activeId = this.actions.activeSessionId();
    const target = live.find((session) => session.id === activeId) ?? live[0];
    this.sessionSelect.value = target.id;
    this.sessionSelect.disabled = live.length < 2;
  }

  private describe(session: SessionSummary, serial: number): string {
    const label = session.label || session.targetKey;
    // Same host twice ("root@10.0.0.1:22") needs something to tell them apart.
    return serial > 1 ? `${label} #${serial}` : label;
  }

  setHosts(hosts: CloudHost[]): void {
    const selected = this.select.value;
    this.hosts = hosts;
    this.select.replaceChildren(new Option(hosts.length ? '请选择主机' : '暂无主机，请先在总览添加', ''));
    for (const host of hosts) {
      this.select.add(new Option(`${host.name} · ${host.username}@${host.host}:${host.port}`, host.id));
    }
    this.select.value = hosts.some((host) => host.id === selected) ? selected : '';
    this.selectActiveTarget();
    this.renderConnection();
  }

  setConnection(state: FileConnectionState, hostId?: string, target = ''): void {
    this.state = state;
    this.activeTarget = state === 'connecting' || state === 'connected' ? { id: hostId, label: target } : null;
    this.selectActiveTarget();
    this.renderConnection();
  }

  private selectActiveTarget(): void {
    this.select.querySelector('[data-current-session]')?.remove();
    if (!this.activeTarget) return;
    if (this.hosts.some((host) => host.id === this.activeTarget!.id)) {
      this.select.value = this.activeTarget.id!;
    } else {
      // 临时连接也能进入文件页，但不能把旧的下拉选项误标成当前服务器。
      const option = new Option(`当前会话 · ${this.activeTarget.label}`, '');
      option.dataset.currentSession = 'true';
      this.select.add(option);
      option.selected = true;
    }
  }

  setMessage(message: string, error = false): void {
    const notice = this.get('#files-notice');
    notice.textContent = message;
    notice.classList.toggle('error', error);
    notice.hidden = !message;
  }

  private renderConnection(): void {
    const active = this.state === 'connecting' || this.state === 'connected';
    const busy = this.preparing || this.state === 'disconnecting';
    this.select.disabled = active || busy || !this.hosts.length;
    this.connectButton.disabled = busy || (!active && !this.select.value);
    this.get<HTMLButtonElement>('#files-terminal').disabled = this.preparing;
    this.connectButton.classList.toggle('primary', !active);
    this.connectButton.textContent = this.preparing ? '读取凭据中…'
      : this.state === 'connecting' ? '取消连接'
        : this.state === 'connected' ? '断开连接'
          : this.state === 'disconnecting' ? '正在断开…' : '连接主机';
    const labels: Record<FileConnectionState, string> = {
      idle: '未连接', connecting: '正在连接', connected: 'SSH 已连接', disconnecting: '正在断开', error: '连接失败',
    };
    const badge = this.get('#files-connection-state');
    badge.textContent = labels[this.state];
    badge.dataset.state = this.state;
    this.get('#files-host-hint').textContent = active
      ? '与终端共用会话 · 切换主机前请先断开'
      : '使用已保存的 SSH 凭据安全连接';
  }

  private async toggleConnection(): Promise<void> {
    if (this.state === 'connecting' || this.state === 'connected') {
      if (!this.confirmLeave()) return;
      this.actions.disconnect();
      return;
    }
    const host = this.hosts.find((item) => item.id === this.select.value);
    if (!host || this.preparing || this.state === 'disconnecting') return;
    this.preparing = true;
    this.renderConnection();
    this.setMessage(`正在读取 ${host.name} 的连接凭据…`);
    try { await this.actions.connect(host); }
    catch (error) { this.setMessage(error instanceof Error ? error.message : '连接准备失败，请重试。', true); }
    finally { this.preparing = false; this.renderConnection(); }
  }

  confirmLeave(): boolean {
    // 只有正在传输时才打断导航，避免用户无意中取消上传或下载。
    const progress = this.panel.querySelector<HTMLElement>('#file-manager-progress')!;
    return progress.hidden || confirm('文件正在传输，离开或断开连接将取消传输。仍要继续吗？');
  }
}
