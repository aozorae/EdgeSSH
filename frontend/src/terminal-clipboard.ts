import type { Terminal } from '@xterm/xterm';

interface ClipboardOptions {
  localize: (zh: string, en: string) => string;
  notify: (message: string, error: boolean) => void;
}

// The native xterm context menu relies on a moving, hidden textarea. A separate
// menu snapshots the selection before focus or live SSH output can change it.
export function installTerminalClipboard(terminal: Terminal, options: ClipboardOptions): void {
  const element = terminal.element;
  if (!element) throw new Error('Open the terminal before installing clipboard support');
  const menu = document.createElement('div');
  menu.className = 'terminal-context-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.setAttribute('role', 'menuitem');
  const selectAll = document.createElement('button');
  selectAll.type = 'button';
  selectAll.setAttribute('role', 'menuitem');
  menu.append(copy, selectAll);
  document.body.append(menu);
  let selectedText = '';

  const close = (focus = false) => {
    menu.hidden = true;
    selectedText = '';
    if (focus) terminal.focus();
  };

  // Older browsers and denied clipboard permissions can still support a
  // user-initiated copy event. Never send the selected text to the SSH channel.
  const legacyCopy = (text: string): boolean => {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.readOnly = true;
    textarea.style.cssText = 'position:fixed;left:-9999px;top:0';
    const parent = document.fullscreenElement?.contains(element) ? document.fullscreenElement : document.body;
    parent.appendChild(textarea);
    textarea.select();
    try {
      return document.execCommand('copy');
    } finally {
      textarea.remove();
      terminal.focus();
    }
  };

  const copyText = async (text: string) => {
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          if (!legacyCopy(text)) throw new Error('Clipboard write failed');
        }
      } else if (!legacyCopy(text)) {
        throw new Error('Clipboard write failed');
      }
      options.notify(options.localize('已复制选中文字。', 'Selected text copied.'), false);
    } catch {
      options.notify(options.localize('复制失败，请检查浏览器剪贴板权限。', 'Copy failed. Check browser clipboard permissions.'), true);
    }
  };

  // Respect mouse-aware remote programs. Shift+right-click always opens the
  // local menu, while ordinary right-click reaches the PTY in mouse mode.
  const useLocalMenu = (event: MouseEvent) =>
    terminal.modes.mouseTrackingMode === 'none' || event.shiftKey;
  element.addEventListener('mousedown', (event) => {
    if (event.button !== 2 || !useLocalMenu(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  element.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!useLocalMenu(event)) {
      close();
      return;
    }
    selectedText = terminal.getSelection();
    // Fullscreen elements live in the browser top layer; a body-level menu
    // would be hidden behind the terminal while fullscreen is active.
    const parent = document.fullscreenElement?.contains(element) ? document.fullscreenElement : document.body;
    parent.appendChild(menu);
    copy.textContent = options.localize('复制', 'Copy');
    copy.disabled = selectedText.length === 0;
    selectAll.textContent = options.localize('全选', 'Select all');
    menu.hidden = false;
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(0, Math.min(event.clientX, window.innerWidth - bounds.width))}px`;
    menu.style.top = `${Math.max(0, Math.min(event.clientY, window.innerHeight - bounds.height))}px`;
    (copy.disabled ? selectAll : copy).focus({ preventScroll: true });
  }, true);
  copy.addEventListener('click', () => {
    const text = selectedText;
    close(true);
    void copyText(text);
  });
  selectAll.addEventListener('click', () => {
    close(true);
    terminal.selectAll();
  });
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      (document.activeElement === copy || copy.disabled ? selectAll : copy).focus();
    } else if (event.key === 'Tab') close();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!menu.hidden && !menu.contains(event.target as Node)) close();
  }, true);
  window.addEventListener('blur', () => close());
  window.addEventListener('resize', () => close());
  document.addEventListener('scroll', () => close(), true);

  terminal.attachCustomKeyEventHandler((event) => {
    const copyKey = !event.altKey && (
      ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c')
      || (event.ctrlKey && !event.shiftKey && event.key === 'Insert')
    );
    if (!copyKey || !terminal.hasSelection()) return true;
    event.preventDefault();
    if (event.type === 'keydown') void copyText(terminal.getSelection());
    return false;
  });
}
