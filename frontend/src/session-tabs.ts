// Session tab strip rendered between the terminal chrome row and the terminal
// stage. It is a pure view: every decision (which sessions exist, which is
// bound to the DOM, what closing one means) lives in `main.ts`.
//
// Kept out of `main.ts` because that module already owns ~2.4k lines; anything
// that is not SSH protocol state does not belong there.

import type { ConnectionState } from './session-context';
import type { SessionSummary } from './session-manager';

export interface SessionTabBarOptions {
  container: HTMLElement;
  /** Called when a tab body is clicked/keyboard-activated. */
  onActivate: (id: string) => void;
  /** Called by the tab's close button — the caller owns the teardown. */
  onClose: (id: string) => void;
  localize: (zh: string, en: string) => string;
  /** Human-readable state copy for the status dot's accessible text. */
  stateLabel: (state: ConnectionState) => string;
}

export interface SessionTabBar {
  render(sessions: SessionSummary[], activeId: string | null): void;
}

const TAB_CLASS = 'session-tab';
const CLOSE_CLASS = 'session-tab-close';

export function createSessionTabBar(options: SessionTabBarOptions): SessionTabBar {
  const { container, onActivate, onClose, localize, stateLabel } = options;

  container.addEventListener('click', (clickEvent) => {
    const target = clickEvent.target as HTMLElement | null;
    const closeButton = target?.closest<HTMLElement>(`.${CLOSE_CLASS}`);
    if (closeButton?.dataset.session) {
      clickEvent.stopPropagation();
      onClose(closeButton.dataset.session);
      return;
    }
    const tab = target?.closest<HTMLElement>(`.${TAB_CLASS}`);
    if (tab?.dataset.session) onActivate(tab.dataset.session);
  });

  container.addEventListener('keydown', (keyEvent) => {
    const tab = (keyEvent.target as HTMLElement | null)?.closest<HTMLElement>(`.${TAB_CLASS}`);
    if (!tab) return;
    const tabs = [...container.querySelectorAll<HTMLElement>(`.${TAB_CLASS}`)];
    const index = tabs.indexOf(tab);
    if (index < 0) return;
    if (keyEvent.key === 'ArrowRight' || keyEvent.key === 'ArrowLeft') {
      keyEvent.preventDefault();
      const next = tabs[(index + (keyEvent.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      next.focus();
      if (next.dataset.session) onActivate(next.dataset.session);
      return;
    }
    if (keyEvent.key === 'Delete' || keyEvent.key === 'Backspace') {
      keyEvent.preventDefault();
      if (tab.dataset.session) onClose(tab.dataset.session);
    }
  });

  function buildTab(session: SessionSummary, selected: boolean): HTMLElement {
    const tab = document.createElement('div');
    tab.className = TAB_CLASS;
    tab.dataset.session = session.id;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;

    const dot = document.createElement('span');
    dot.className = `session-tab-dot ${session.state}`;
    dot.setAttribute('role', 'status');

    const label = document.createElement('span');
    label.className = 'session-tab-label';
    label.textContent = session.label || '…';
    tab.title = `${session.label} · ${stateLabel(session.state)}`;

    const close = document.createElement('button');
    close.type = 'button';
    close.className = CLOSE_CLASS;
    close.dataset.session = session.id;
    close.textContent = '×';
    const closeLabel = localize('断开此会话', 'Disconnect this session');
    close.setAttribute('aria-label', closeLabel);
    close.title = closeLabel;

    tab.append(dot, label, close);
    return tab;
  }

  return {
    render(sessions: SessionSummary[], activeId: string | null): void {
      if (sessions.length === 0) {
        container.hidden = true;
        container.replaceChildren();
        return;
      }
      container.hidden = false;
      container.replaceChildren(...sessions.map((session) => buildTab(session, session.id === activeId)));
    },
  };
}
