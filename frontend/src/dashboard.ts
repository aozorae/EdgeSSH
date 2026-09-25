import { api, saveHost, removeHost, refreshHostLocation, type CloudHost, type HostInput } from './cloud-api';
import type { HostGlobe } from './globe';
import type { FilePage } from './file-page';
import type { Snippets } from './snippets';
import { ForwardPage } from './forward-page';
import { countryFlag } from './flags';
import { systemIcon } from './os-icons';
import './dashboard.css';

interface DashboardActions {
  files: FilePage;
  snippets: Snippets;
  refresh(): Promise<CloudHost[]>;
  connect(host: CloudHost): Promise<void>;
  quickConnect(): void;
  leaveWorkspace(): void;
}

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
  private authenticated = false;
  private returnFocus?: HTMLElement;
  private readonly dialog: HTMLDialogElement;
  private readonly form: HTMLFormElement;
  private readonly forwarding = new ForwardPage();

  constructor(private readonly actions: DashboardActions) {
    this.root.id = 'dashboard';
    this.root.innerHTML = `
      <header class="home-header">
        <a class="home-brand" href="/" aria-label="EdgeSSH 首页"><span class="brand-chevron">›_</span>Edge<span>SSH</span></a>
        <label class="home-search">${icon('search')}<input id="host-search" type="search" placeholder="搜索主机、分组或 IP 地址" aria-label="搜索主机"><kbd>Ctrl K</kbd></label>
        <button class="home-button primary header-add" data-add>＋ 新建主机</button>
        <div class="home-account"><span class="account-avatar">A</span><span id="account-label">验证身份中</span><a id="account-action" href="/auth/login" title="管理员登录">登录</a></div>
      </header>
      <div class="home-layout">
        <nav class="home-rail" aria-label="主导航">
          <button class="rail-item selected" id="rail-overview" aria-current="page">${icon('home')}<span>总览</span></button>
          <button class="rail-item" id="rail-hosts">${icon('server')}<span>主机</span></button>
          <button class="rail-item" id="rail-files">${icon('folder')}<span>文件管理</span></button>
          <button class="rail-item" id="rail-snippets">${icon('snippets')}<span>代码片段</span></button>
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
              <div class="globe-heading"><p class="home-eyebrow">A SMALLER WORLD</p><h2 id="globe-heading">散布全球，<br><span>就在手边。</span></h2><p>点击国旗，即刻连接。</p></div>
              <div class="host-globe" id="host-globe" aria-label="主机地理分布，可拖动旋转；也可使用主机列表连接"></div>
              <div class="globe-meta"><span id="region-count">0 个地区</span><button id="pause-globe" class="home-text-button" aria-pressed="false">暂停旋转</button></div>
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
            <label class="wide">认证方式<select name="authMethod"><option value="password">密码</option><option value="publickey">OpenSSH 私钥</option></select></label>
            <label class="wide" id="cloud-password-field">密码<input name="password" type="password" maxlength="4096" autocomplete="new-password"><small class="credential-help">密码会由 Worker 加密后保存。</small></label>
            <label class="wide" id="cloud-key-field" hidden>私钥<textarea name="privateKey" rows="5" maxlength="65536" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" spellcheck="false"></textarea><small class="credential-help">仅支持未加密的 OpenSSH 私钥。</small></label>
          </div>
          <details class="host-advanced"><summary>高级设置</summary><div class="host-form-grid">
            <label class="wide">主机指纹<input name="fingerprint" placeholder="SHA256:…，首次连接时确认" maxlength="128"></label>
            <label class="wide">初始命令<input name="initialCommand" maxlength="4096" placeholder="可选"></label>
            <label>终端类型<input name="termType" value="xterm-256color" maxlength="64" required></label>
            <label>编码<select name="encoding"><option value="utf-8">UTF-8</option><option value="gb18030">GB18030</option><option value="big5">Big5</option></select></label>
          </div></details>
          <p class="host-form-disclosure">首次保存会将解析后的公网 IP 发给 IPWho 服务查询城市，不发送密码或私钥。</p>
          <p id="host-form-error" class="host-form-error" role="alert" hidden></p>
          <div class="dialog-actions"><button class="home-button close-dialog" type="button">取消</button><button class="home-button primary" id="save-cloud-host" type="submit">加密保存</button></div>
        </form>
      </dialog>`;
    document.body.prepend(this.root);
    this.get('.home-layout').append(this.actions.files.root);
    this.get('.home-layout').append(this.actions.snippets.page);
    this.get('.home-layout').append(this.forwarding.root);
    this.dialog = this.get<HTMLDialogElement>('#host-editor-dialog');
    this.form = this.get<HTMLFormElement>('#cloud-host-form');
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
    this.get('#refresh-hosts').addEventListener('click', () => void this.refresh());
    for (const id of ['#rail-overview', '#rail-hosts']) this.get(id).addEventListener('click', () => {
      if (!this.actions.files.confirmLeave()) return;
      if (!this.isHome) this.actions.leaveWorkspace();
      this.show();
      if (id === '#rail-hosts') this.get<HTMLInputElement>('#host-search').focus();
    });
    this.get('#rail-files').addEventListener('click', () => this.showFiles());
    this.get('#rail-snippets').addEventListener('click', () => this.showSnippets());
    this.get('#rail-forward').addEventListener('click', () => this.showForwarding());
    for (const id of ['#quick-connect', '#bottom-quick']) this.get(id).addEventListener('click', () => {
      if (this.busy || !this.actions.files.confirmLeave()) return;
      this.actions.leaveWorkspace();
      this.openWorkspace(); this.actions.quickConnect();
    });
    this.field('authMethod').addEventListener('change', () => this.updateCredentialFields());
    this.form.addEventListener('submit', (event) => { event.preventDefault(); void this.save(); });
    this.get('#pause-globe').addEventListener('click', () => {
      this.paused = !this.paused;
      this.get('#pause-globe').setAttribute('aria-pressed', String(this.paused));
      this.get('#pause-globe').textContent = this.paused ? '继续旋转' : '暂停旋转';
      this.globe?.setActive(!this.paused);
    });
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
    } catch { this.get('#host-globe').textContent = '地图暂不可用，请从主机列表连接。'; }
  }

  setHosts(hosts: CloudHost[]): void {
    this.hosts = hosts;
    this.actions.files.setHosts(hosts);
    this.forwarding.setHosts(hosts);
    if (this.group && !hosts.some((host) => host.group === this.group)) this.group = '';
    this.renderFilters(); this.renderList();
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
    this.forwarding.hide();
    this.actions.files.hide();
    this.actions.snippets.hide();
    this.isHome = true; this.root.hidden = false;
    this.get('.home-content').hidden = false;
    this.selectNavigation('rail-overview');
    document.getElementById('app')!.hidden = true;
    document.body.dataset.view = 'dashboard';
    this.globe?.setActive(!this.paused);
  }

  openWorkspace(): void {
    this.forwarding.hide();
    this.actions.files.hide();
    this.actions.snippets.hide();
    this.isHome = false; this.root.hidden = true;
    document.getElementById('app')!.hidden = false;
    document.body.dataset.view = 'workspace';
    this.globe?.setActive(false);
    window.dispatchEvent(new Event('resize'));
    this.actions.snippets.load();
  }

  showFiles(): void {
    this.forwarding.hide();
    this.actions.snippets.hide();
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
    this.forwarding.hide();
    // 仅切换视图，不结束 SSH；在片段页编辑后可回到同一会话。
    this.actions.files.hide();
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
    this.actions.files.hide();
    this.actions.snippets.hide();
    this.isHome = false; this.root.hidden = false;
    this.get('.home-content').hidden = true;
    document.getElementById('app')!.hidden = true;
    document.body.dataset.view = 'forward';
    this.selectNavigation('rail-forward');
    this.globe?.setActive(false);
    this.forwarding.show();
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
    this.authenticated = false;
    this.get('#account-label').textContent = '未登录';
    const action = this.get<HTMLAnchorElement>('#account-action');
    action.href = '/auth/login'; action.textContent = '登录'; action.title = '管理员登录';
    this.setHosts([]);
    this.get('#host-list').textContent = '请点击右上角「登录」验证管理员身份。';
    this.root.querySelectorAll<HTMLButtonElement>('[data-add], #quick-connect, #bottom-quick, #rail-snippets').forEach((button) => { button.disabled = true; });
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
        const edit = document.createElement('button'); edit.className = 'host-row-action'; edit.textContent = '编辑'; edit.type = 'button'; edit.setAttribute('aria-label', `编辑 ${host.name}`);
        edit.addEventListener('click', () => this.openEditor(host));
        const remove = document.createElement('button'); remove.className = 'host-row-action delete'; remove.textContent = '×'; remove.type = 'button'; remove.setAttribute('aria-label', `删除 ${host.name}`);
        remove.addEventListener('click', async () => {
          if (!confirm(`删除主机「${host.name}」及保存的凭据？此操作不会删除服务器。`)) return;
          remove.disabled = true;
          try { await removeHost(host.id); await this.refresh(); }
          catch (error) { this.notice(error instanceof Error ? error.message : '删除失败。'); remove.disabled = false; }
        });
        row.append(symbol, copy, location, connect, edit, remove); list.append(row);
      }
    }
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

  private openEditor(host?: CloudHost): void {
    if (this.busy) return;
    this.returnFocus = document.activeElement as HTMLElement;
    this.editing = host; this.form.reset();
    this.get('#host-dialog-title').textContent = host ? '编辑主机' : '添加主机';
    for (const name of ['name', 'group', 'host', 'port', 'username', 'authMethod', 'fingerprint', 'initialCommand', 'termType', 'encoding'] as const) {
      if (host) this.field(name).value = String(host[name]);
    }
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
    const key = this.field('authMethod').value === 'publickey';
    this.get('#cloud-password-field').hidden = key;
    this.get('#cloud-key-field').hidden = !key;
  }

  private async save(): Promise<void> {
    if (this.busy || !this.form.reportValidity()) return;
    this.busy = true;
    const button = this.get<HTMLButtonElement>('#save-cloud-host'); button.disabled = true; button.textContent = '加密保存中…';
    const value = (name: string) => this.field(name).value;
    const input: HostInput = {
      name: value('name'), group: value('group'), host: value('host').trim(), port: Number(value('port')),
      username: value('username').trim(), authMethod: value('authMethod') as HostInput['authMethod'],
      fingerprint: value('fingerprint').trim(), initialCommand: value('initialCommand'), termType: value('termType'), encoding: value('encoding'),
    };
    const credential = input.authMethod === 'password' ? 'password' : 'privateKey';
    if (value(credential) || !this.editing || this.editing.authMethod !== input.authMethod) input[credential] = value(credential);
    try {
      await saveHost(input, this.editing?.id);
      this.dialog.close(); await this.refresh();
    } catch (error) {
      this.get('#host-form-error').textContent = error instanceof Error ? error.message : '保存失败。';
      this.get('#host-form-error').hidden = false;
    } finally { this.busy = false; button.disabled = false; button.textContent = '加密保存'; }
  }
}
