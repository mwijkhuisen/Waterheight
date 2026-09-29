import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

export type Messages = Readonly<Record<string, unknown>>;

/** Reads messages/<locale>.json for every locale ("$schema"-style keys ignored). */
export function loadMessages(dir: string, locales: readonly string[]): Map<string, Messages> {
  return new Map(
    locales.map((locale) => {
      const all = JSON.parse(readFileSync(join(dir, `${locale}.json`), 'utf8')) as Record<string, unknown>;
      return [locale, Object.fromEntries(Object.entries(all).filter(([key]) => !key.startsWith('$')))];
    }),
  );
}

/** Every locale must define exactly the same keys; returns the problems found. */
export function keyDrift(messages: ReadonlyMap<string, Messages>): string[] {
  const all = new Set([...messages.values()].flatMap((m) => Object.keys(m)));
  const problems: string[] = [];
  for (const [locale, m] of messages) {
    for (const key of all) if (!(key in m)) problems.push(`message "${key}" is missing in ${locale}.json`);
  }
  return problems.sort();
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

/**
 * Fills `%m:key%` placeholders in each HTML page from the message file of the
 * page's static `<html lang>`, so <title> and <main> exist without JavaScript.
 * The build fails on a missing key, an unknown page language or key drift
 * between the locales.
 */
export function i18nHtml(options: { messagesDir: string; locales: readonly string[] }): Plugin {
  let messages = new Map<string, Messages>();
  return {
    name: 'rws-i18n-html',
    buildStart() {
      messages = loadMessages(options.messagesDir, options.locales);
      const drift = keyDrift(messages);
      if (drift.length > 0) this.error(drift.join('\n'));
    },
    transformIndexHtml(html, ctx) {
      const lang = /<html[^>]*\slang="([^"]+)"/.exec(html)?.[1];
      const m = lang === undefined ? undefined : messages.get(lang);
      if (m === undefined) throw new Error(`${ctx.path}: <html lang> must be one of ${options.locales.join(', ')}`);
      return html.replace(/%m:([a-z0-9_]+)%/g, (_, key: string) => {
        const value = m[key];
        if (typeof value !== 'string') throw new Error(`${ctx.path}: message "${key}" is missing in ${lang}.json`);
        return escapeHtml(value);
      });
    },
  };
}
