import { SnippetStore, type Snippet } from './snippet-store';
import { SnippetEditor } from './snippet-editor';
import { SnippetList } from './snippet-list';
import { SnippetPanel } from './snippet-panel';
import './snippets.css';

export const SNIPPET_LABEL = '快捷命令指令';

export class Snippets {
  readonly page = document.createElement('section');
  private readonly store = new SnippetStore();
  private readonly panel: SnippetPanel;

  constructor(topbarActions: HTMLElement, use: (snippet: Snippet) => void, openTerminal: () => void, openLibrary: () => void) {
    const editor = new SnippetEditor(this.store);
    this.page.id = 'snippets-page';
    this.page.className = 'snippet-page snippet-surface';
    this.page.hidden = true;
    this.page.setAttribute('aria-labelledby', 'snippets-heading');
    this.page.innerHTML = `<header class="snippet-page-heading"><span class="snippet-symbol" aria-hidden="true">{ }</span>
      <div><p>YOUR COMMAND LIBRARY</p><h1 id="snippets-heading" tabindex="-1">${SNIPPET_LABEL}</h1>
      <p>把常用命令留在手边，不必每次从头输入。</p></div>
      <button type="button" class="snippet-open-terminal">打开 SSH 终端 ↗</button></header>`;
    this.page.querySelector('.snippet-open-terminal')!.addEventListener('click', openTerminal);
    this.page.append(new SnippetList(this.store, editor).root);
    // 入口放在顶栏「文件管理 / 端口转发」这一排，面板挂在这一行下方，不再浮在终端上。
    const menu = document.createElement('div');
    menu.className = 'snippet-menu';
    const toggle = document.createElement('button');
    toggle.id = 'snippet-toggle';
    toggle.className = 'icon-button home-back';
    toggle.type = 'button';
    toggle.textContent = SNIPPET_LABEL;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', 'snippet-panel');
    menu.append(toggle);
    topbarActions.prepend(menu);
    this.panel = new SnippetPanel(menu, this.store, editor, use, openLibrary);
    toggle.addEventListener('click', () => this.panel.toggle());
    // Once open the panel covers the shell, so anything outside it — or Esc —
    // has to put it away again.
    document.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      // The editor dialog lives outside the menu but belongs to it — slamming
      // the panel shut on its own clicks would lose whatever was being typed.
      if (target?.closest('.snippet-menu, dialog, [role="dialog"]')) return;
      this.panel.close();
    });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') this.panel.close(); });
  }

  show(): void {
    this.page.hidden = false; void this.store.load(true);
    this.page.querySelector<HTMLElement>('h1')!.focus();
  }

  hide(): void { this.page.hidden = true; }
  load(): void { void this.store.load(true); }
  clear(): void { this.store.clear(); }
}
