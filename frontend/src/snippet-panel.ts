import { SnippetList } from './snippet-list';
import { SnippetEditor } from './snippet-editor';
import { SnippetStore, type Snippet } from './snippet-store';

/**
 * Quick-command dropdown. It used to be a floating box parked over the
 * terminal — always in the way of whatever the shell was printing, and in need
 * of dragging to get out of it. It now opens from the top bar row instead,
 * where every other page-level action lives.
 */
export class SnippetPanel {
  readonly root = document.createElement('aside');
  private readonly body: HTMLElement;
  private open = false;

  constructor(private readonly menu: HTMLElement, private readonly store: SnippetStore, editor: SnippetEditor, use: (snippet: Snippet) => void, openLibrary: () => void) {
    this.root.id = 'snippet-panel';
    this.root.className = 'snippet-panel snippet-surface';
    this.root.setAttribute('aria-label', '快捷命令指令');
    this.root.hidden = true;
    this.root.innerHTML = `<header class="snippet-panel-heading">
      <span class="snippet-symbol" aria-hidden="true">{ }</span><strong>快捷命令指令</strong>
      <button class="snippet-manage" type="button" aria-label="管理快捷命令指令" title="管理快捷命令指令">↗</button>
    </header><div id="snippet-panel-body"><p class="snippet-panel-hint">常用命令，一次保存，随时取用。</p></div>`;
    this.body = this.root.querySelector('#snippet-panel-body')!;
    this.body.append(new SnippetList(store, editor, { compact: true, use: (snippet) => {
      use(snippet);
      // 窄屏上展开的面板会盖住整屏，取用后立即收起，让终端回到视野。
      if (matchMedia('(max-width: 700px)').matches) this.setOpen(false);
    } }).root);
    menu.append(this.root);
    this.root.querySelector('.snippet-manage')!.addEventListener('click', openLibrary);
  }

  get isOpen(): boolean { return this.open; }

  toggle(): void { this.setOpen(!this.open); }

  close(): void { this.setOpen(false); }

  private setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    this.root.hidden = !open;
    this.menu.querySelector<HTMLButtonElement>('#snippet-toggle')?.setAttribute('aria-expanded', String(open));
    // Editing is done in the library page too, so re-read on every open.
    if (open) void this.store.load();
  }
}
