// The colophon's contact link (P10b). The address comes from /runtime-config.json, where `z.email()` has already
// passed it; this helper is stricter on purpose, because the result becomes an href: a plain address of letters,
// digits and `._+-` only, so no `?` (a mailto header such as `subject` or `body`), `&`, `%`, whitespace, `<`, `>` or
// quote can ever reach the link. Anything else is no link (the page shows the text instead). No imports.

const PLAIN_ADDRESS =
  /^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;

/** `mailto:<address>` for a plain address, else undefined. */
export function contactHref(email: string | undefined): string | undefined {
  return email !== undefined && email.length <= 254 && PLAIN_ADDRESS.test(email) ? `mailto:${email}` : undefined;
}
