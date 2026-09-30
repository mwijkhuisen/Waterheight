// The two canaries of invariant 11 (CLAUDE.md, ARCHITECTURE §12.1). Their
// values are fixed by the invariant's text. An observation is stored as `real`,
// which cannot hold either value exactly, so PostgreSQL prints a stored canary
// differently: every leak check greps both renderings, taken from here.

export const CANARIES = {
  /** CANARY-OWNER: must appear in the owner outputs (as `real`) and nowhere public. */
  owner: { value: 777777.777, text: '777777.777', real: '777777.75' },
  /** The withheld series on NL-1: must appear nowhere. */
  withheld: { value: 123456.789, text: '123456.789', real: '123456.79' },
} as const;

/** Every spelling of both canaries: none may appear in a public output. */
export const CANARY_RENDERINGS: readonly string[] = [
  CANARIES.owner.text,
  CANARIES.owner.real,
  CANARIES.withheld.text,
  CANARIES.withheld.real,
];
