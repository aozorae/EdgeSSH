import { api, saveHost, removeHost, refreshHostLocation, hostCredentials, type CloudHost, type HostInput } from './cloud-api';
import type { HostGlobe, GlobeView } from './globe';
import type { FilePage } from './file-page';
import type { Snippets } from './snippets';
import { ForwardPage } from './forward-page';

/** Remembered shape of the home map; same key family as the session store. */
const GLOBE_VIEW_KEY = 'edgessh.globe-view.v1';
import { createElement, KeyRound } from 'lucide';
import { Keychain, fillKeychainSelect } from './keychain';
import { countryFlag } from './flags';
import { isContinent, regionStats, regionView, type RegionKey } from './continents';
import { systemIcon } from './os-icons';
import { testConnection } from './connection-test';
import { sessionTargetKey } from './session-target';
import { MAX_SESSIONS_PER_TARGET, SESSION_EVENT, type SessionSummary } from './session-manager';
import type { ConnectionState } from './session-context';
import './dashboard.css';

interface DashboardActions {
  files: FilePage;
  snippets: Snippets;
  keychain: Keychain;
  refresh(): Promise<CloudHost[]>;
  connect(host: CloudHost): Promise<void>;
  /** Dial the same target again as a *new* session instead of reusing one. */
  newSession(host: CloudHost): Promise<void>;
  quickConnect(): void;
  leaveWorkspace(): void;
  /** Every registered session; the dashboard renders it but never owns it. */
  sessions(): SessionSummary[];
  /** Id of the session bound to the shared UI, or null. */
  activeSessionId(): string | null;
  /** Localized copy for a connection state. */
  stateLabel(state: ConnectionState): string;
  /** Move a session to the front; gives it the terminal and the panels. */
  activateSession(id: string): void;
  /** Tear just this session down; every other one keeps running. */
  closeSession(id: string): void;
}

/** States that mean "this session is doing something", i.e. deserves a badge. */
const LIVE_STATES: ReadonlySet<ConnectionState> = new Set<ConnectionState>(['connecting', 'connected', 'disconnecting', 'error']);

const icons = {
  home: '<path d="m3 10 9-7 9 7v10H3Z"/><path d="M9 20v-7h6v7"/>',
  server: '<rect x="4" y="3" width="16" height="7" rx="2"/><rect x="4" y="14" width="16" height="7" rx="2"/><path d="M8 6.5h.01M8 17.5h.01M15 6.5h2M15 17.5h2"/>',
  terminal: '<path d="m5 6 6 6-6 6m8 0h6"/>',
  forward: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 8h18M7 14h10m-3-3 3 3-3 3"/>',
  snippets: '<path d="M9 3H7a2 2 0 0 0-2 2v4l-2 3 2 3v4a2 2 0 0 0 2 2h2m6-18h2a2 2 0 0 1 2 2v4l2 3-2 3v4a2 2 0 0 1-2 2h-2"/>',
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M3 9h18"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
};
function icon(name: keyof typeof icons): string { return `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`; }

export class Dashboard {
  readonly root = document.createElement('section');
  private hosts: CloudHost[] = [];
  private group = '';
  private globe?: HostGlobe;
  private editing?: CloudHost;
  private busy = false;
  private isHome = true;
  private paused = false;
  private globeView: GlobeView = 'sphere';
  /** Continent the map is framing, or null for the whole spinning world. */
  private region: RegionKey | null = null;
  private authenticated = false;
  private returnFocus?: HTMLElement;
  private readonly dialog: HTMLDialogElement;
  private readonly disconnectDialog: HTMLDialogElement;
  private readonly form: HTMLFormElement;
  private readonly forwarding = new ForwardPage();
  /** Session centre panel — a sibling of the home content, like the files view. */
  private readonly sessionsView = document.createElement('section');
  /** Open host badge menu, if any; its DOM lives inside the owning host row. */
  private openMenu?: HTMLElement;
  /** Session waiting behind the disconnect confirmation dialog. */
  private pendingDisconnectId?: string;
  /** Last rendered session snapshot, so the host list is not rebuilt needlessly. */
  private sessionSignature = '';

  constructor(private readonly actions: DashboardActions) {
    this.root.id = 'dashboard';
    this.root.innerHTML = `
      <header class="home-header">
        <!--
          这里原本是 href="/" 的链接：点击会整页导航到首页，而启动流程末尾的
          restorePersistedSessions() 又会立刻把已存在的会话接回工作台 —— 看起来
          就是「点 logo 误跳终端页」。改成按钮后点击只在当前页内重新拉取
          主机/会话数据，不再重新加载页面。
        -->
        <button type="button" class="home-brand" aria-label="刷新首页" title="刷新首页"><span class="brand-chevron">›_</span>Edge<span>SSH</span></button>
        <label class="home-search">${icon('search')}<input id="host-search" type="search" placeholder="搜索主机、分组或 IP 地址" aria-label="搜索主机"><kbd>Ctrl K</kbd></label>
        <button class="home-button primary header-add" data-add>＋ 新建主机</button>
        <div class="home-account"><span class="account-avatar">A</span><span id="account-label">验证身份中</span><a id="account-action" href="/auth/login" title="管理员登录">登录</a></div>
      </header>
      <div class="home-layout">
        <nav class="home-rail" aria-label="主导航">
          <button class="rail-item selected" id="rail-overview" aria-current="page">${icon('home')}<span>总览</span></button>
          <button class="rail-item" id="rail-hosts">${icon('server')}<span>主机</span></button>
          <button class="rail-item" id="rail-sessions">${icon('terminal')}<span>会话中心</span><span class="rail-badge" id="sessions-count" hidden></span></button>
          <button class="rail-item" id="rail-files">${icon('folder')}<span>文件管理</span></button>
          <button class="rail-item" id="rail-snippets">${icon('snippets')}<span>代码片段</span></button>
          <button class="rail-item" id="rail-keychain"><span>密钥链</span></button>
          <button class="rail-item" id="rail-forward">${icon('forward')}<span>端口转发</span></button>
          <button class="rail-item" id="quick-connect">${icon('terminal')}<span>快速连接</span></button>
          <span class="rail-security" title="管理员身份认证">${icon('shield')}<span id="auth-provider-label">身份<br>保护</span></span>
        </nav>
        <main class="home-content">
          <div id="home-notice" class="home-notice" role="status" hidden></div>
          <div class="home-main-grid">
            <section class="hosts-pane" aria-labelledby="hosts-heading">
              <div class="home-section-heading"><div><p class="home-eyebrow">YOUR INFRASTRUCTURE</p><h1 id="hosts-heading">我的主机</h1><p>安全保存，随处连接。</p></div><button class="home-button" data-add>＋ 添加主机</button></div>
              <div class="host-filters" id="host-filters" aria-label="按分组筛选"></div>
              <div id="host-list" class="host-list" aria-live="polite"><p class="home-empty">正在从云端加载主机…</p></div>
              <div class="host-list-footer"><span id="host-total">0 台主机</span><button class="home-text-button" id="refresh-hosts">刷新列表 ↻</button></div>
            </section>
            <section class="globe-pane" aria-labelledby="globe-heading">
              <div class="globe-heading"><p class="home-eyebrow">A SMALLER WORLD</p><div class="globe-title-row"><h2 id="globe-heading">散布全球，<br><span>就在手边。</span></h2><div class="globe-stats" id="globe-stats" role="group" aria-label="按大洲查看主机分布"></div></div><p>点击国旗，即刻连接。</p></div>
              <div class="host-globe" id="host-globe" aria-label="主机地理分布，可拖动旋转；也可使用主机列表连接"></div>
              <div class="globe-meta"><span id="region-count">0 个地区</span><span class="globe-actions"><button id="pause-globe" class="home-text-button" aria-pressed="false">暂停旋转</button><button id="globe-view" class="home-text-button" aria-pressed="false">平铺地图</button></span></div>
              <p class="globe-caption">城市级近似定位 · 位置不代表在线状态</p>
            </section>
          </div>
          <section class="home-bottom" aria-label="存储与连接信息">
            <div class="storage-note">${icon('shield')}<div><strong>凭据留在你的加密保险箱</strong><p>管理员认证 · D1 加密存储 · 密钥仅在 Worker</p></div><span class="storage-tag">AES-256-GCM</span></div>
            <button class="quick-card" id="bottom-quick">${icon('terminal')}<span><strong>临时连接</strong><small>打开完整 SSH 工作台</small></span><span>↗</span></button>
          </section>
          <footer class="home-footer"><span>EdgeSSH / Private workspace</span><span>首次保存时查询公网 IP 位置，失败时仍可连接。</span><a href="https://mappojs.com/" target="_blank" rel="noopener noreferrer">地图数据与灵感来自 Mappo.js</a></footer>
        </main>
      </div>
      <dialog id="host-editor-dialog" class="host-dialog" aria-labelledby="host-dialog-title">
        <form id="cloud-host-form" autocomplete="off">
          <div class="dialog-heading"><div><p class="home-eyebrow">ENCRYPTED HOST</p><h2 id="host-dialog-title">添加主机</h2></div><button type="button" class="home-button close-dialog" aria-label="关闭">×</button></div>
          <p class="dialog-intro">保存到你的云端主机库，不会写入浏览器本地存储。</p>
          <div class="host-form-grid">
            <label>名称<input name="name" maxlength="80" placeholder="例如：Tokyo VPS" required></label>
            <label>分组<input name="group" maxlength="40" value="个人" list="host-groups"><datalist id="host-groups"></datalist></label>
            <label class="wide">主机地址<input name="host" maxlength="253" placeholder="IP 地址或域名" required spellcheck="false"></label>
            <label>SSH 用户名<input name="username" value="root" maxlength="128" required spellcheck="false"></label>
            <label>端口<input name="port" type="number" min="1" max="65535" value="22" required></label>
            <label class="wide">认证方式<select name="authMethod"><option value="password">密码</option><option value="publickey">上传 / 填写私钥</option><option value="keychain">密钥链</option></select></label>
            <label class="wide" id="cloud-password-field">密码<input name="password" type="password" maxlength="4096" autocomplete="new-password"><small class="credential-help">密码会由 Worker 加密后保存。</small></label>
            <label class="wide" id="cloud-key-field" hidden>私钥<textarea name="privateKey" rows="5" maxlength="65536" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" spellcheck="false"></textarea><small class="credential-help">OpenSSH 新格式私钥；若设了口令，请在下方填写。</small></label>
            <label class="wide" id="cloud-key-file-field" hidden>私钥文件<input name="privateKeyFile" type="file" accept=".pem,.key,.openssh,text/plain"></label>
            <label class="wide" id="cloud-keychain-field" hidden>已有密钥<select name="keychainId"><option value="">选择密钥</option></select></label>
            <label class="wide" id="cloud-key-passphrase-field" hidden>私钥口令<input name="keyPassphrase" type="password" maxlength="1024" autocomplete="off"><small class="credential-help">私钥带口令时填写，与凭据一起加密保存；未加密则留空。</small></label>
          </div>
          <details class="host-advanced"><summary>高级设置</summary><div class="host-form-grid">
            <label class="wide">主机指纹<input name="fingerprint" placeholder="SHA256:…，首次连接时确认" maxlength="128"></label>
            <label class="wide">初始命令<input name="initialCommand" maxlength="4096" placeholder="可选"></label>
            <label>终端类型<input name="termType" value="xterm-256color" maxlength="64" required></label>
            <label>编码<select name="encoding"><option value="utf-8">UTF-8</option><option value="gb18030">GB18030</option><option value="big5">Big5</option></select></label>
          </div></details>
          <p class="host-form-disclosure">首次保存会将解析后的公网 IP 发给 IPWho 服务查询城市，不发送密码或私钥。</p>
          <p id="host-form-error" class="host-form-error" role="alert" hidden></p>
          <div class="dialog-actions"><button class="home-button close-dialog" type="button">取消</button><button class="home-button" id="test-cloud-host" type="button">测试连接</button><button class="home-button primary" id="save-cloud-host" type="submit">加密保存</button></div>
        </form>
      </dialog>
      <dialog id="session-disconnect-dialog" class="host-dialog session-disconnect-dialog" aria-labelledby="session-disconnect-title">
        <div class="dialog-heading"><div><p class="home-eyebrow">DISCONNECT</p><h2 id="session-disconnect-title">断开这个会话？</h2></div></div>
        <p class="dialog-intro" id="session-disconnect-body"></p>
        <div class="dialog-actions">
          <button class="home-button" id="session-disconnect-cancel" type="button">取消</button>
          <button class="home-button danger" id="session-disconnect-confirm" type="button">断开会话</button>
        </div>
      </dialog>`;
    this.buildSessionsView();
    document.body.prepend(this.root);
    this.get('.home-layout').append(this.sessionsView);
    this.get('.home-layout').append(this.actions.files.root);
    this.get('.home-layout').append(this.actions.snippets.page);
    this.get('.home-layout').append(this.forwarding.root);
    this.get('.home-layout').append(this.actions.keychain.root);
    this.get('#rail-keychain').prepend(createElement(KeyRound));
    this.actions.keychain.addEventListener('change', () => fillKeychainSelect(this.field('keychainId') as HTMLSelectElement, this.actions.keychain.keys));
    this.dialog = this.get<HTMLDialogElement>('#host-editor-dialog');
    this.disconnectDialog = this.get<HTMLDialogElement>('#session-disconnect-dialog');
    this.form = this.get<HTMLFormElement>('#cloud-host-form');
    this.get('#rail-sessions').addEventListener('click', () => this.showSessions());
    this.get('#session-disconnect-cancel').addEventListener('click', () => this.disconnectDialog.close());
    this.get('#session-disconnect-confirm').addEventListener('click', () => {
      const id = this.pendingDisconnectId;
      this.disconnectDialog.close();
      if (id) this.actions.closeSession(id);
    });
    this.disconnectDialog.addEventListener('close', () => { this.pendingDisconnectId = undefined; });
    // 下拉菜单是浮层：点到别处或按 Esc 都要收起，否则它会盖住其它主机的操作。
    document.addEventListener('click', (event) => {
      if (!this.openMenu) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('.session-menu') || target?.closest('.host-session-badge')) return;
      this.closeSessionMenu();
    });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') this.closeSessionMenu(); });
    // 会话会在别处变动（拨号、断开、状态迁移），这里只是跟着重画。
    window.addEventListener(SESSION_EVENT, () => this.renderSessionSurfaces());
    this.get('#account-action').addEventListener('click', async (event) => {
      if (!this.authenticated) return;
      event.preventDefault();
      try {
        const { redirect } = await api<{ redirect: string }>('/api/auth/logout', 'POST');
        location.assign(redirect);
      } catch (error) { this.notice(error instanceof Error ? error.message : '退出失败，请重试。'); }
    });
    window.addEventListener('auth-required', () => this.signedOut());
    this.root.querySelectorAll<HTMLButtonElement>('[data-add]').forEach((button) => button.addEventListener('click', () => this.openEditor()));
    this.root.querySelectorAll('.close-dialog').forEach((button) => button.addEventListener('click', () => this.closeEditor()));
    this.dialog.addEventListener('cancel', (event) => { if (this.busy) event.preventDefault(); });
    this.dialog.addEventListener('close', () => { this.form.reset(); this.editing = undefined; this.returnFocus?.focus(); });
    this.get('#host-search').addEventListener('input', () => this.renderList());
    this.get<HTMLButtonElement>('.home-brand').addEventListener('click', () => {
      if (!this.actions.files.confirmLeave()) return;
      this.show(); void this.refresh();
    });
    this.get('#refresh-hosts').addEventListener('click', () => void this.refresh());
    for (const id of ['#rail-overview', '#rail-hosts']) this.get(id).addEventListener('click', () => {
      if (!this.actions.files.confirmLeave()) return;
      if (!this.isHome) this.actions.leaveWorkspace();
      this.show();
      if (id === '#rail-hosts') this.get<HTMLInputElement>('#host-search').focus();
    });
    this.get('#rail-files').addEventListener('click', () => this.showFiles());
    this.get('#rail-snippets').addEventListener('click', () => this.showSnippets());
    this.get('#rail-keychain').addEventListener('click', () => this.showKeychain());
    this.get('#rail-forward').addEventListener('click', () => this.showForwarding());
    for (const id of ['#quick-connect', '#bottom-quick']) this.get(id).addEventListener('click', () => {
      if (this.busy || !this.actions.files.confirmLeave()) return;
      this.actions.leaveWorkspace();
      this.openWorkspace(); this.actions.quickConnect();
    });
    this.field('authMethod').addEventListener('change', () => this.updateCredentialFields());
    this.field('privateKeyFile').addEventListener('change', async () => {
      const input = this.field('privateKeyFile') as HTMLInputElement;
      const file = input.files?.[0]; input.setCustomValidity(''); if (!file) return;
      input.setCustomValidity('正在读取私钥文件。');
      try {
        if (file.size > 65536) throw new Error('私钥文件不能超过 64 KiB。');
        const text = await file.text();
        if (this.dialog.open && input.files?.[0] === file) { this.field('privateKey').value = text; input.setCustomValidity(''); }
      } catch (error) {
        if (input.files?.[0] !== file) return;
        input.setCustomValidity('私钥文件读取失败，请重新选择。');
        this.get('#host-form-error').textContent = error instanceof Error ? error.message : '私钥读取失败。'; this.get('#host-form-error').hidden = false;
      }
    });
    this.get('#test-cloud-host').addEventListener('click', () => void this.test());
    this.form.addEventListener('submit', (event) => { event.preventDefault(); void this.save(); });
    this.get('#pause-globe').addEventListener('click', () => {
      this.paused = !this.paused;
      this.get('#pause-globe').setAttribute('aria-pressed', String(this.paused));
      this.get('#pause-globe').textContent = this.paused ? '继续旋转' : '暂停旋转';
      this.globe?.setActive(!this.paused);
    });
    this.get('#globe-view').addEventListener('click', () => this.setGlobeView(this.globeView === 'flat' ? 'sphere' : 'flat'));
    try {
      const saved = localStorage.getItem(GLOBE_VIEW_KEY);
      if (saved === 'flat' || saved === 'sphere') this.setGlobeView(saved, false);
    } catch { /* 隐私模式下读不到 localStorage，保持默认球体 */ }
    document.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && this.isHome && !this.dialog.open) {
        event.preventDefault(); this.get<HTMLInputElement>('#host-search').focus();
      }
    });
    const back = document.createElement('button');
    back.className = 'icon-button home-back'; back.textContent = '← 主机总览'; back.type = 'button';
    back.addEventListener('click', () => {
      if (!this.actions.files.confirmLeave()) return;
      this.actions.leaveWorkspace(); this.show(); void this.refresh();
    });
    document.querySelector('#app .topbar-actions')!.prepend(back);
    const files = document.createElement('button');
    files.className = 'icon-button home-back'; files.textContent = '文件管理'; files.type = 'button';
    files.addEventListener('click', () => this.showFiles());
    document.querySelector('#app .topbar-actions')!.prepend(files);
    const forwarding = document.createElement('button');
    forwarding.className = 'icon-button home-back'; forwarding.textContent = '端口转发'; forwarding.type = 'button';
    forwarding.addEventListener('click', () => this.showForwarding());
    document.querySelector('#app .topbar-actions')!.append(forwarding);
    this.show();
  }

  private get<T extends HTMLElement = HTMLElement>(selector: string): T { return this.root.querySelector<T>(selector)!; }
  private field(name: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
    return this.form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  }

  async start(): Promise<void> {
    try {
      const { account, provider } = await api<{ account: { username: string }; provider: string }>('/api/auth/me');
      this.authenticated = true;
      this.get('#account-label').textContent = account.username;
      this.get('.account-avatar').textContent = account.username.slice(0, 1).toUpperCase();
      this.get('#auth-provider-label').textContent = provider === 'github' ? 'GitHub' : 'Access';
      const action = this.get<HTMLAnchorElement>('#account-action');
      action.textContent = '退出'; action.title = '退出登录'; action.href = '/api/auth/logout';
      await this.refresh();
    } catch (error) {
      this.signedOut();
      this.notice(error instanceof Error ? error.message : '无法验证管理员身份。');
    }
    try {
      const { HostGlobe } = await import('./globe');
      this.globe = new HostGlobe(this.get('#host-globe'), (host) => void this.connectHost(host));
      this.globe.setHosts(this.hosts);
      this.globe.setActive(this.isHome && !this.paused);
      // Restore without replaying the unroll animation on every page load.
      if (this.globeView !== 'sphere') this.globe.setView(this.globeView, false);
      // A chip can be picked before this dynamic import lands.
      if (this.region && isContinent(this.region)) this.globe.focusRegion(regionView(this.region, this.hosts), false);
    } catch { this.get('#host-globe').textContent = '地图暂不可用，请从主机列表连接。'; }
  }

  private setGlobeView(view: GlobeView, animate = true): void {
    this.globeView = view;
    const flat = view === 'flat';
    const toggle = this.get('#globe-view');
    toggle.setAttribute('aria-pressed', String(flat));
    toggle.textContent = flat ? '收回球体' : '平铺地图';
    // The unrolled map is every meridian at once — it never spins, so there is
    // nothing to pause. Hidden rather than removed: the meta row keeps its
    // layout instead of reflowing on every switch.
    this.get('#pause-globe').classList.toggle('is-hidden', flat);
    this.get('#host-globe').setAttribute('aria-label', flat
      ? '主机地理分布平铺地图，全部经度一次展开；点击标记或左侧列表连接'
      : '主机地理分布，可拖动旋转；也可使用主机列表连接');
    this.globe?.setView(view, animate);
    try { localStorage.setItem(GLOBE_VIEW_KEY, view); } catch { /* 隐私模式下忽略 */ }
  }

  setHosts(hosts: CloudHost[]): void {
    this.hosts = hosts;
    this.actions.files.setHosts(hosts);
    this.forwarding.setHosts(hosts);
    if (this.group && !hosts.some((host) => host.group === this.group)) this.group = '';
    this.renderFilters(); this.renderList(); this.renderRegions();
    this.globe?.setHosts(hosts);
    this.get('#region-count').textContent = `${new Set(hosts.map((host) => host.location?.countryCode).filter(Boolean)).size} 个国家 / 地区`;
    this.get('#host-total').textContent = `${hosts.length} 台主机 · ${hosts.filter((host) => !host.location).length} 台位置未知`;
  }

  async refresh(): Promise<void> {
    const button = this.get<HTMLButtonElement>('#refresh-hosts');
    button.disabled = true;
    try { this.setHosts(await this.actions.refresh()); this.get('#home-notice').hidden = true; }
    catch (error) { this.notice(error instanceof Error ? error.message : '主机加载失败，请重试。'); }
    finally { button.disabled = false; }
  }

  show(): void {
    this.hidePages();
    this.isHome = true; this.root.hidden = false;
    this.get('.home-content').hidden = false;
    this.selectNavigation('rail-overview');
    document.getElementById('app')!.hidden = true;
    document.body.dataset.view = 'dashboard';
    this.globe?.setActive(!this.paused);
  }

  openWorkspace(): void {
    this.hidePages();
    this.isHome = false; this.root.hidden = true;
    document.getElementById('app')!.hidden = false;
    document.body.dataset.view = 'workspace';
    this.globe?.setActive(false);
    window.dispatchEvent(new Event('resize'));
    this.actions.snippets.load();
  }

  showFiles(): void {
    this.hidePages();
    this.isHome = false; this.root.hidden = false;
    this.get('.home-content').hidden = true;
    document.getElementById('app')!.hidden = true;
    document.body.dataset.view = 'files';
    this.selectNavigation('rail-files');
    this.globe?.setActive(false);
    this.actions.files.show();
  }

  showSnippets(): void {
    if (!this.actions.files.confirmLeave()) return;
    this.hidePages();
    // 仅切换视图，不结束 SSH；在片段页编辑后可回到同一会话。
    this.isHome = false; this.root.hidden = false;
    this.get('.home-content').hidden = true;
    document.getElementById('app')!.hidden = true;
    document.body.dataset.view = 'snippets';
    this.selectNavigation('rail-snippets');
    this.globe?.setActive(false);
    this.actions.snippets.show();
  }

  showForwarding(): void {
    if (!this.actions.files.confirmLeave()) return;
    this.hidePages();
    this.isHome = false; this.root.hidden = false;
    this.get('.home-content').hidden = true;
    document.getElementById('app')!.hidden = true;
    document.body.dataset.view = 'forward';
    this.selectNavigation('rail-forward');
    this.globe?.setActive(false);
    this.forwarding.show();
  }

  showKeychain(): void {
    if (!this.actions.files.confirmLeave()) return;
    this.hidePages();
    this.isHome = false; this.root.hidden = false;
    this.get('.home-content').hidden = true;
    document.getElementById('app')!.hidden = true;
    document.body.dataset.view = 'keychain'; this.selectNavigation('rail-keychain');
    this.get('#rail-keychain').scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.globe?.setActive(false); this.actions.keychain.show();
  }

  showSessions(): void {
    if (!this.actions.files.confirmLeave()) return;
    this.hidePages();
    // 切换视图不会动 SSH；会话中心只是会话的另一块说明牌。
    this.isHome = false; this.root.hidden = false;
    this.get('.home-content').hidden = true;
    document.getElementById('app')!.hidden = true;
    document.body.dataset.view = 'sessions';
    this.selectNavigation('rail-sessions');
    this.globe?.setActive(false);
    this.sessionsView.hidden = false;
    this.renderSessionList();
    this.get('#sessions-heading').focus();
  }

  /** Hide every sibling page, including the session centre. */
  private hidePages(): void {
    this.actions.keychain.hide();
    this.forwarding.hide();
    this.actions.files.hide();
    this.actions.snippets.hide();
    this.closeSessionMenu();
    this.sessionsView.hidden = true;
  }

  // -----------------------------------------------------------------------
  // Multi-session surfaces: host badge + menu, rail badge, session centre.
  // The dashboard stays a view — `main.ts` owns the sessions themselves.
  // -----------------------------------------------------------------------

  private liveSessions(): SessionSummary[] {
    return this.actions.sessions().filter((session) => LIVE_STATES.has(session.state));
  }

  private sessionsFor(targetKey: string): SessionSummary[] {
    return this.liveSessions().filter((session) => session.targetKey === targetKey);
  }

  /**
   * A session only knows `user@host:port`; running that back through the host
   * list is what lets the session centre say "Tokyo production" instead.
   */
  private sessionTitle(session: SessionSummary): string {
    const match = this.hosts.find((host) => sessionTargetKey(host.host, host.port, host.username) === session.targetKey);
    return match?.name ?? (session.label || session.targetKey);
  }

  /** Cheap equality check for "would any badge look different?". */
  private liveSignature(): string {
    return this.liveSessions().map((session) => `${session.id}@${session.targetKey}:${session.state}`).join('|');
  }

  /** Called on every registry change so the dashboard cannot fall out of sync. */
  private renderSessionSurfaces(): void {
    this.renderSessionCount();
    const signature = this.liveSignature();
    if (signature !== this.sessionSignature) {
      this.sessionSignature = signature;
      // Badges live inside host rows, so keeping them truthful means rebuilding
      // the rows; the menu would otherwise point at a session that is gone.
      if (!this.root.hidden && !this.get('.home-content').hidden) this.renderList();
      if (!this.sessionsView.hidden) this.renderSessionList();
      if (this.openMenu) {
        if (this.sessionsFor(this.openMenu.dataset.target ?? '').length) this.refreshSessionMenu();
        else this.closeSessionMenu();
      }
    }
  }

  private renderSessionCount(): void {
    const count = this.liveSessions().length;
    const badge = this.get('#sessions-count');
    badge.textContent = String(count);
    badge.hidden = count === 0;
    badge.setAttribute('aria-label', `${count} 个运行中的会话`);
    this.get('#rail-sessions').title = count ? `${count} 个运行中的会话` : '没有运行中的会话';
  }

  private renderSessionList(): void {
    const list = this.get('#session-list');
    const sessions = this.liveSessions();
    this.get('#sessions-total').textContent = `${sessions.length} 个会话`;
    list.replaceChildren();
    const activeId = this.actions.activeSessionId();
    if (!sessions.length) {
      const empty = document.createElement('div'); empty.className = 'home-empty';
      empty.innerHTML = `${icon('terminal')}<strong></strong><p></p>`;
      empty.querySelector('strong')!.textContent = '暂无运行中的会话';
      empty.querySelector('p')!.textContent = '在主机列表点击「连接」，会话会同时出现在这里。';
      list.append(empty); return;
    }
    for (const session of sessions) {
      const card = document.createElement('article');
      card.className = session.id === activeId ? 'session-card current' : 'session-card';
      card.dataset.session = session.id;
      const heading = document.createElement('div'); heading.className = 'session-card-heading';
      const label = document.createElement('strong'); label.textContent = this.sessionTitle(session);
      const state = document.createElement('span');
      state.className = `session-state ${session.state}`;
      state.textContent = this.actions.stateLabel(session.state);
      heading.append(label, state);
      if (session.id === activeId) {
        const current = document.createElement('span'); current.className = 'session-current-tag'; current.textContent = '当前';
        heading.append(current);
      }
      const meta = document.createElement('span'); meta.className = 'session-card-meta';
      const started = new Date(session.startedAt).toLocaleTimeString('zh-CN', { hour12: false });
      meta.textContent = `${session.label || session.targetKey} · 建立于 ${started}`;
      const name = this.sessionTitle(session);
      const actions = document.createElement('div'); actions.className = 'session-card-actions';
      const activate = document.createElement('button');
      activate.className = 'home-button'; activate.type = 'button'; activate.textContent = '切换到工作台';
      activate.dataset.activate = session.id;
      activate.setAttribute('aria-label', `切换到会话 ${name}`);
      activate.addEventListener('click', () => this.switchToSession(session.id));
      const close = document.createElement('button');
      close.className = 'home-button danger'; close.type = 'button'; close.textContent = '断开';
      close.dataset.disconnect = session.id;
      close.setAttribute('aria-label', `断开会话 ${name}`);
      close.addEventListener('click', () => this.confirmDisconnect(session.id));
      actions.append(activate, close);
      card.append(heading, meta, actions);
      list.append(card);
    }
  }

  private switchToSession(id: string): void {
    this.closeSessionMenu();
    this.actions.activateSession(id);
    this.openWorkspace();
  }

  /** Disconnecting one session is destructive, so it always asks first. */
  private confirmDisconnect(id: string): void {
    const session = this.actions.sessions().find((item) => item.id === id);
    if (!session) return;
    this.pendingDisconnectId = id;
    const name = this.sessionTitle(session);
    this.get('#session-disconnect-body').textContent =
      `${name} 的文件传输会随这个会话结束；其它会话不受影响。`;
    this.disconnectDialog.showModal();
    this.get<HTMLButtonElement>('#session-disconnect-cancel').focus();
  }

  private toggleSessionMenu(targetKey: string, anchor: HTMLElement, host: CloudHost): void {
    const wasOpen = this.openMenu?.dataset.target === targetKey;
    this.closeSessionMenu();
    if (wasOpen) return;
    const menu = this.buildSessionMenu(targetKey, host, anchor);
    if (!menu) return;
    menu.dataset.target = targetKey;
    menu.dataset.hostId = host.id;
    anchor.after(menu);
    anchor.setAttribute('aria-expanded', 'true');
    this.openMenu = menu;
    menu.querySelector('button')?.focus();
  }

  private refreshSessionMenu(): void {
    const menu = this.openMenu;
    const targetKey = menu?.dataset.target;
    const host = this.hosts.find((item) => item.id === menu?.dataset.hostId);
    const anchor = menu?.previousElementSibling as HTMLElement | null;
    if (!menu || !targetKey || !host || !anchor) { this.closeSessionMenu(); return; }
    const rebuilt = this.buildSessionMenu(targetKey, host, anchor);
    if (!rebuilt) { this.closeSessionMenu(); return; }
    rebuilt.dataset.target = targetKey;
    rebuilt.dataset.hostId = host.id;
    menu.replaceWith(rebuilt);
    this.openMenu = rebuilt;
  }

  private buildSessionMenu(targetKey: string, host: CloudHost, anchor: HTMLElement): HTMLElement | null {
    const sessions = this.sessionsFor(targetKey);
    if (!sessions.length) return null;
    const menu = document.createElement('div');
    menu.className = 'session-menu';
    menu.setAttribute('role', 'menu');
    const activeId = this.actions.activeSessionId();
    for (const session of sessions) {
      const row = document.createElement('div'); row.className = 'session-menu-row';
      const name = this.sessionTitle(session);
      const label = document.createElement('span'); label.className = 'session-menu-label';
      label.textContent = name;
      label.title = session.targetKey;
      const state = document.createElement('span'); state.className = `session-menu-state ${session.state}`;
      state.textContent = this.actions.stateLabel(session.state);
      const activate = document.createElement('button');
      activate.type = 'button'; activate.className = 'home-button session-menu-button';
      activate.textContent = session.id === activeId ? '回到工作台' : '切换';
      activate.dataset.activate = session.id;
      activate.setAttribute('aria-label', `切换到会话 ${name}`);
      activate.addEventListener('click', () => this.switchToSession(session.id));
      const close = document.createElement('button');
      close.type = 'button'; close.className = 'home-button danger session-menu-button';
      close.textContent = '断开';
      close.dataset.disconnect = session.id;
      close.setAttribute('aria-label', `断开会话 ${name}`);
      close.addEventListener('click', () => this.confirmDisconnect(session.id));
      row.append(label, state, activate, close);
      menu.append(row);
    }
    menu.append(this.buildAnotherSessionRow(sessions.length, host, anchor));
    return menu;
  }

  /** Second shell for the same target — otherwise the per-target cap is unreachable. */
  private buildAnotherSessionRow(count: number, host: CloudHost, anchor: HTMLElement): HTMLElement {
    const another = document.createElement('button');
    another.type = 'button'; another.className = 'home-button session-menu-new';
    another.textContent = '＋ 再开一个会话';
    const atLimit = count >= MAX_SESSIONS_PER_TARGET;
    another.disabled = atLimit;
    another.title = atLimit ? `该主机最多 ${MAX_SESSIONS_PER_TARGET} 个会话。` : `为 ${host.name} 再开一个会话`;
    another.addEventListener('click', () => void this.openAnotherSession(host, anchor));
    return another;
  }

  private closeSessionMenu(): void {
    this.openMenu?.remove();
    this.openMenu = undefined;
    this.root.querySelectorAll<HTMLElement>('.host-session-badge').forEach((badge) => badge.setAttribute('aria-expanded', 'false'));
  }

  private buildSessionsView(): void {
    this.sessionsView.id = 'sessions-pane';
    this.sessionsView.className = 'sessions-page';
    this.sessionsView.hidden = true;
    this.sessionsView.setAttribute('aria-labelledby', 'sessions-heading');
    this.sessionsView.innerHTML = `
      <header class="home-section-heading"><div><p class="home-eyebrow">LIVE SESSIONS</p>
        <h1 id="sessions-heading" tabindex="-1">会话中心</h1>
        <p>每一条会话各自连着一台主机；切换到工作台查看它，或单独断开。</p></div>
        <span class="home-eyebrow" id="sessions-total">0 个会话</span></header>
      <div id="session-list" class="session-list" aria-live="polite"></div>`;
  }

  private selectNavigation(id: string): void {
    this.root.querySelectorAll<HTMLElement>('.rail-item').forEach((button) => {
      button.classList.toggle('selected', button.id === id);
      if (button.id === id) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
  }

  private notice(message: string): void {
    const notice = this.get('#home-notice'); notice.textContent = message; notice.hidden = false;
  }

  private signedOut(): void {
    this.actions.leaveWorkspace();
    this.actions.snippets.clear();
    this.actions.keychain.clear();
    this.authenticated = false;
    this.get('#account-label').textContent = '未登录';
    const action = this.get<HTMLAnchorElement>('#account-action');
    action.href = '/auth/login'; action.textContent = '登录'; action.title = '管理员登录';
    this.setHosts([]);
    this.get('#host-list').textContent = '请点击右上角「登录」验证管理员身份。';
    this.root.querySelectorAll<HTMLButtonElement>('[data-add], #quick-connect, #bottom-quick, #rail-snippets, #rail-keychain').forEach((button) => { button.disabled = true; });
    this.show();
  }

  private renderFilters(): void {
    const root = this.get('#host-filters'); root.replaceChildren();
    for (const group of ['', ...new Set(this.hosts.map((host) => host.group))]) {
      const button = document.createElement('button'); button.type = 'button';
      button.className = this.group === group ? 'active' : '';
      button.setAttribute('aria-pressed', String(this.group === group));
      button.textContent = `${group || '全部主机'}  ${group ? this.hosts.filter((host) => host.group === group).length : this.hosts.length}`;
      button.addEventListener('click', () => { this.group = group; this.renderFilters(); this.renderList(); });
      root.append(button);
    }
  }

  /**
   * One chip per continent that actually has hosts, then the unresolved tail.
   * Selecting a continent frames it on the map; selecting it again lets the
   * world go back to spinning.
   */
  private renderRegions(): void {
    const rows = regionStats(this.hosts);
    // A continent can lose its last host to a rename or a delete; the map has
    // to be released along with the chip, or it would stay zoomed into nothing.
    if (this.region && !rows.some((row) => row.key === this.region)) this.region = null;
    const root = this.get('#globe-stats'); root.replaceChildren();
    for (const row of rows) {
      const button = document.createElement('button'); button.type = 'button';
      button.className = row.key === 'unknown' ? 'globe-stat is-unknown' : 'globe-stat';
      button.setAttribute('aria-pressed', String(this.region === row.key));
      const label = document.createElement('span'); label.textContent = row.label;
      const count = document.createElement('b'); count.textContent = String(row.count);
      button.append(label, document.createTextNode('：'), count);
      if (row.key === 'unknown') {
        // Nothing to turn towards, so the chip is a count and not a control.
        button.disabled = true;
        button.title = '这些主机没有解析到地理位置';
      } else {
        button.title = this.region === row.key ? `取消聚焦${row.label}` : `在地图上聚焦${row.label}`;
        button.addEventListener('click', () => this.selectRegion(this.region === row.key ? null : row.key));
      }
      root.append(button);
    }
  }

  private selectRegion(key: RegionKey | null): void {
    this.region = key;
    this.renderRegions();
    this.globe?.focusRegion(key && isContinent(key) ? regionView(key, this.hosts) : null);
  }

  private renderList(): void {
    const query = this.get<HTMLInputElement>('#host-search').value.trim().toLowerCase();
    const hosts = this.hosts.filter((host) => (!this.group || host.group === this.group)
      && [host.name, host.host, host.username, host.group, host.location?.city ?? ''].join(' ').toLowerCase().includes(query));
    const list = this.get('#host-list'); list.replaceChildren();
    if (!hosts.length) {
      const empty = document.createElement('div'); empty.className = 'home-empty';
      empty.innerHTML = `${icon('server')}<strong></strong><p></p>`;
      empty.querySelector('strong')!.textContent = this.hosts.length ? '没有匹配的主机' : '从你的第一台服务器开始';
      empty.querySelector('p')!.textContent = this.hosts.length ? '试试其他名称、分组或 IP 地址。' : '添加主机后，它会出现在列表与地球上。';
      list.append(empty); return;
    }
    for (const group of new Set(hosts.map((host) => host.group))) {
      const heading = document.createElement('h3'); heading.className = 'host-group-heading';
      heading.textContent = `${group} · ${hosts.filter((host) => host.group === group).length}`; list.append(heading);
      for (const host of hosts.filter((host) => host.group === group)) {
        const row = document.createElement('article'); row.className = 'host-row';
        const symbol = document.createElement('span'); symbol.className = 'host-symbol';
        symbol.innerHTML = systemIcon(host.system, icon('server'));
        const systemLabel = host.system
          ? [host.system.name, host.system.version, host.system.architecture].filter(Boolean).join(' · ')
          : '连接主机后自动探测操作系统';
        symbol.title = systemLabel;
        symbol.setAttribute('role', 'img');
        symbol.setAttribute('aria-label', systemLabel);
        const copy = document.createElement('div'); copy.className = 'host-copy';
        const name = document.createElement('strong'); name.textContent = host.name;
        const address = document.createElement('span'); address.textContent = `${host.username}@${host.host}:${host.port}`; address.title = address.textContent;
        copy.append(name, address);
        const location = document.createElement('span'); location.className = 'host-location';
        const locationText = document.createElement('span'); locationText.className = 'host-location-text';
        if (host.location) {
          const place = host.location.city || host.location.region || host.location.country;
          locationText.textContent = place;
          location.title = [place, host.location.region, host.location.ip].filter(Boolean).join(' · ');
          location.append(countryFlag(host.location.countryCode), locationText);
        } else {
          location.classList.add('unknown');
          locationText.textContent = '位置未知';
          location.append(locationText);
        }
        const relocate = document.createElement('button'); relocate.type = 'button'; relocate.className = 'host-location-refresh';
        relocate.innerHTML = icon('refresh'); relocate.title = '重新获取公网 IP 与位置';
        relocate.setAttribute('aria-label', `重新获取 ${host.name} 的公网 IP 与位置`);
        relocate.addEventListener('click', () => void this.refreshLocation(host, relocate));
        location.append(relocate);
        const connect = document.createElement('button'); connect.className = 'home-button connect-host'; connect.textContent = '连接'; connect.type = 'button';
        connect.addEventListener('click', () => void this.connectHost(host));
        // 「连接」与会话徽标共处一列：原先的六列行网格和三档断点里的定位规则
        // 都不用为多会话再加一列，只需在最外层替换成这个容器。
        const rowActions = document.createElement('div'); rowActions.className = 'host-actions';
        const key = sessionTargetKey(host.host, host.port, host.username);
        const active = this.sessionsFor(key);
        if (active.length) {
          const badge = document.createElement('button');
          badge.type = 'button'; badge.className = 'host-session-badge'; badge.dataset.target = key;
          badge.setAttribute('aria-haspopup', 'menu');
          badge.setAttribute('aria-expanded', 'false');
          badge.textContent = String(active.length);
          badge.title = `${host.name} 有 ${active.length} 个运行中的会话`;
          badge.setAttribute('aria-label', badge.title);
          badge.addEventListener('click', (clickEvent) => {
            clickEvent.stopPropagation();
            this.toggleSessionMenu(key, badge, host);
          });
          rowActions.append(badge);
        }
        rowActions.append(connect);
        const edit = document.createElement('button'); edit.className = 'host-row-action'; edit.textContent = '编辑'; edit.type = 'button'; edit.setAttribute('aria-label', `编辑 ${host.name}`);
        edit.addEventListener('click', () => this.openEditor(host));
        const remove = document.createElement('button'); remove.className = 'host-row-action delete'; remove.textContent = '×'; remove.type = 'button'; remove.setAttribute('aria-label', `删除 ${host.name}`);
        remove.addEventListener('click', async () => {
          if (!confirm(`删除主机「${host.name}」及保存的凭据？此操作不会删除服务器。`)) return;
          remove.disabled = true;
          try { await removeHost(host.id); await this.refresh(); }
          catch (error) { this.notice(error instanceof Error ? error.message : '删除失败。'); remove.disabled = false; }
        });
        row.append(symbol, copy, location, rowActions, edit, remove); list.append(row);
      }
    }
    // 徽标是从这里渲染的，所以重画后的快照就已经是最新的了。
    this.sessionSignature = this.liveSignature();
    this.renderSessionCount();
  }

  private async refreshLocation(host: CloudHost, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    this.notice(`正在重新获取 ${host.name} 的公网 IP 与位置…`);
    try {
      const updated = await refreshHostLocation(host.id);
      this.setHosts(this.hosts.map((item) => item.id === updated.id ? updated : item));
      if (updated.location) {
        const place = updated.location.city || updated.location.region || updated.location.country;
        this.notice(`已定位 ${host.name}：${place}${updated.location.ip ? ` · ${updated.location.ip}` : ''}`);
      } else this.notice(`仍无法获取 ${host.name} 的公网 IP 位置，请检查主机地址或稍后重试。`);
    } catch (error) {
      this.notice(error instanceof Error ? error.message : '重新定位失败，请稍后重试。');
      button.disabled = false;
    }
  }

  private async connectHost(host: CloudHost): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.root.setAttribute('aria-busy', 'true');
    this.notice(`正在读取 ${host.name} 的连接凭据…`);
    try { await this.actions.connect(host); this.openWorkspace(); this.get('#home-notice').hidden = true; }
    catch (error) { this.notice(error instanceof Error ? error.message : '连接准备失败。'); }
    finally { this.busy = false; this.root.removeAttribute('aria-busy'); }
  }

  /** Same target again, but deliberately a second shell instead of reusing one. */
  private async openAnotherSession(host: CloudHost, anchor?: HTMLElement): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.root.setAttribute('aria-busy', 'true');
    this.notice(`正在为 ${host.name} 再开一个会话…`);
    try {
      this.closeSessionMenu();
      await this.actions.newSession(host);
      this.openWorkspace();
      this.get('#home-notice').hidden = true;
    } catch (error) {
      this.notice(error instanceof Error ? error.message : '无法为该主机再开会话。');
      if (anchor) this.toggleSessionMenu(sessionTargetKey(host.host, host.port, host.username), anchor, host);
    } finally { this.busy = false; this.root.removeAttribute('aria-busy'); }
  }

  private openEditor(host?: CloudHost): void {
    if (this.busy) return;
    this.returnFocus = document.activeElement as HTMLElement;
    this.editing = host; this.form.reset();
    (this.field('privateKeyFile') as HTMLInputElement).setCustomValidity('');
    this.get('#host-dialog-title').textContent = host ? '编辑主机' : '添加主机';
    for (const name of ['name', 'group', 'host', 'port', 'username', 'authMethod', 'fingerprint', 'initialCommand', 'termType', 'encoding'] as const) {
      if (host) this.field(name).value = String(host[name]);
    }
    if (host?.keychainId) this.field('authMethod').value = 'keychain';
    fillKeychainSelect(this.field('keychainId') as HTMLSelectElement, this.actions.keychain.keys, host?.keychainId ?? '');
    this.root.querySelectorAll('.credential-help').forEach((node) => { node.textContent = host ? '留空保留已保存的凭据；切换认证方式时需填写新凭据。' : '凭据仅由 Worker 加密后存入 D1。'; });
    const groups = this.get('#host-groups'); groups.replaceChildren();
    for (const group of new Set(this.hosts.map((item) => item.group))) {
      const option = document.createElement('option'); option.value = group; groups.append(option);
    }
    this.get('#host-form-error').hidden = true;
    this.updateCredentialFields(); this.dialog.showModal(); this.field('name').focus();
  }

  private closeEditor(): void { if (!this.busy) this.dialog.close(); }
  private updateCredentialFields(): void {
    const method = this.field('authMethod').value;
    this.get('#cloud-password-field').hidden = method !== 'password';
    this.get('#cloud-key-field').hidden = method !== 'publickey';
    this.get('#cloud-key-file-field').hidden = method !== 'publickey';
    this.field('privateKeyFile').disabled = method !== 'publickey';
    this.get('#cloud-keychain-field').hidden = method !== 'keychain';
    // 「上传私钥」与「密钥链」两种公钥方式都要能填口令
    this.get('#cloud-key-passphrase-field').hidden = method !== 'publickey' && method !== 'keychain';
    this.field('keychainId').required = method === 'keychain';
    if (method === 'keychain') void this.actions.keychain.load();
  }

  private showFormResult(message: string, ok: boolean): void {
    const node = this.get('#host-form-error');
    node.textContent = message;
    node.classList.toggle('is-success', ok);
    node.hidden = false;
  }

  private async test(): Promise<void> {
    if (this.busy || !this.form.reportValidity()) return;
    const value = (name: string) => this.field(name).value;
    const selection = value('authMethod');
    const method: 'password' | 'publickey' = selection === 'password' ? 'password' : 'publickey';
    let password = method === 'password' ? value('password') : '';
    let privateKey = selection === 'publickey' ? value('privateKey').trim() : '';
    const keychainId = selection === 'keychain' ? value('keychainId') : '';
    let keyPassphrase = method === 'publickey' ? value('keyPassphrase') : '';

    this.busy = true;
    const testButton = this.get<HTMLButtonElement>('#test-cloud-host');
    const saveButton = this.get<HTMLButtonElement>('#save-cloud-host');
    testButton.disabled = true; saveButton.disabled = true;
    testButton.textContent = '测试中…';
    this.get('#host-form-error').hidden = true;
    try {
      // 编辑既有主机时凭据可以留空以沿用原凭据，这里取回已保存凭据做真实探测，
      // 保证测试与后续保存使用同一份凭据。
      const keepCredential = this.editing?.authMethod === method && (selection === 'password'
        ? !password
        : selection === 'keychain' ? keychainId === this.editing.keychainId : !privateKey && !this.editing.keychainId);
      if (this.editing && keepCredential) {
        const saved = await hostCredentials(this.editing.id);
        if (selection === 'password') password = saved.password ?? '';
        else {
          if (selection === 'publickey') privateKey = saved.privateKey ?? '';
          keyPassphrase = keyPassphrase || saved.keyPassphrase || '';
        }
      }
      const result = await testConnection({
        host: value('host').trim(), port: Number(value('port')), username: value('username').trim(),
        authMethod: method, fingerprint: value('fingerprint').trim(),
        ...(method === 'password' ? { password } : keychainId ? { keychainId } : { privateKey }),
        ...(method === 'publickey' && keyPassphrase ? { keyPassphrase } : {}),
      });
      const detail = result.ok && result.fingerprint ? `（服务器指纹 ${result.fingerprint}）` : '';
      this.showFormResult(`${result.message}${detail}`, result.ok);
    } catch (error) {
      this.showFormResult(error instanceof Error ? error.message : '测试失败。', false);
    } finally {
      this.busy = false;
      testButton.disabled = false; saveButton.disabled = false;
      testButton.textContent = '测试连接';
    }
  }

  private async save(): Promise<void> {
    if (this.busy || !this.form.reportValidity()) return;
    this.busy = true;
    const button = this.get<HTMLButtonElement>('#save-cloud-host'); button.disabled = true; button.textContent = '加密保存中…';
    const value = (name: string) => this.field(name).value;
    const input: HostInput = {
      name: value('name'), group: value('group'), host: value('host').trim(), port: Number(value('port')),
      username: value('username').trim(), authMethod: value('authMethod') === 'password' ? 'password' : 'publickey',
      fingerprint: value('fingerprint').trim(), initialCommand: value('initialCommand'), termType: value('termType'), encoding: value('encoding'),
    };
    if (value('authMethod') === 'keychain') input.keychainId = value('keychainId');
    else {
      const credential = input.authMethod === 'password' ? 'password' : 'privateKey';
      if (value(credential) || !this.editing || this.editing.authMethod !== input.authMethod || this.editing.keychainId) input[credential] = value(credential);
    }
    // 私钥口令留空表示沿用旧值；但若本次换了新私钥，留空就是「新私钥无口令」。
    if (input.authMethod === 'publickey') {
      const passphrase = value('keyPassphrase');
      if (passphrase || input.privateKey !== undefined) input.keyPassphrase = passphrase;
    }
    try {
      await saveHost(input, this.editing?.id);
      this.dialog.close(); await this.refresh();
    } catch (error) {
      this.get('#host-form-error').textContent = error instanceof Error ? error.message : '保存失败。';
      this.get('#host-form-error').hidden = false;
    } finally { this.busy = false; button.disabled = false; button.textContent = '加密保存'; }
  }
}
