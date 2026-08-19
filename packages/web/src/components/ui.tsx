/**
 * Small presentational primitives reused across the pages.
 *
 * These are the npm registry's recurring parts: the version pill next to a
 * package name, the keyword chips, the copyable install command, and the tab
 * strip with its red active underline.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FRESHNESS_COLOR, FRESHNESS_LABEL, type Freshness } from '../freshness.js';
import { Link } from '../router.js';

/** The rounded pill npm puts next to a package name for its version. */
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'accent' }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

/** Keyword chip. Links to a filtered search, the way npm's keywords do. */
export function Chip({ to, children }: { to: string; children: ReactNode }) {
  return <Link className="chip" to={to}>{children}</Link>;
}

/**
 * Freshness indicator. The dot never carries the meaning alone: the label is
 * rendered beside it, so state does not rest on colour.
 */
export function FreshnessTag({ state, label }: { state: Freshness; label?: string }) {
  return (
    <span className={`freshness freshness--${state}`}>
      <span className="freshness__dot" style={{ background: FRESHNESS_COLOR[state] }} aria-hidden="true" />
      <span>{label ?? FRESHNESS_LABEL[state]}</span>
    </span>
  );
}

/**
 * npm's install box: a monospace command with a copy button.
 *
 * Falls back to selecting the text when the clipboard API is unavailable --
 * older browsers, or any non-secure origin -- so the button is never a dead end.
 */
export function CopyBlock({ command, label }: { command: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const codeRef = useRef<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function selectText(): void {
    const node = codeRef.current;
    if (!node) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      selectText();
    }
  }

  return (
    <div className="copyblock">
      <code className="copyblock__code" ref={codeRef}>{command}</code>
      <button
        type="button"
        className="copyblock__button"
        onClick={() => void copy()}
        aria-label={copied ? 'Copied' : `Copy ${label ?? 'command'}`}
      >
        <span aria-hidden="true">{copied ? '✓' : '⧉'}</span>
      </button>
    </div>
  );
}

export interface Tab {
  id: string;
  label: string;
  /** Rendered muted after the label, as npm renders dependency counts. */
  count?: number;
}

export function Tabs({ tabs, active, onChange }: {
  tabs: Tab[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`tab-${tab.id}`}
          aria-selected={tab.id === active}
          aria-controls={`tabpanel-${tab.id}`}
          className={`tabs__tab${tab.id === active ? ' tabs__tab--active' : ''}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.count !== undefined && <span className="tabs__count">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Sidebar block: a small heading over a value, npm's metadata rhythm. */
export function MetaBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="meta">
      <h3 className="meta__title">{title}</h3>
      <div className="meta__body">{children}</div>
    </section>
  );
}

export function Notice({ tone = 'info', children, role }: {
  tone?: 'info' | 'error' | 'warn';
  children: ReactNode;
  role?: 'alert' | 'status';
}) {
  return <div className={`notice notice--${tone}`} role={role}>{children}</div>;
}

export function Skeleton({ variant }: { variant: 'line' | 'title' | 'row' | 'block' | 'chart' }) {
  return <span className={`skeleton skeleton--${variant}`} aria-hidden="true" />;
}
