import { boundedJson, type JsonCaps, SchemaDrift } from '@rws/core';

// The envelope of a Vigicrues JSON service (catalogue §2.5; FR-4, and FR-5 when it takes this over). Vigicrues answers
// HTTP 200 whatever happened, and states the outcome in the body:
//  - `{ "error_msg": …, "code": 400 }`: the request failed. SchemaDrift `provider_error` (quarantined and alerted);
//    the provider's text is never copied into the error (fixed code only);
//  - `{ "message": …, "code": 204 }`: "no content", the answer for a station that has no forecast ("toutes
//    prévisions"). Not an error and not drift: `none`. The code decides, never the wording of the message;
//  - anything else is the service's own document, returned for the caller's strict schema.
// Bounded before it is parsed (`boundedJson`), as every provider document.

export type Envelope = { kind: 'document'; doc: unknown } | { kind: 'none' };

const utf8 = new TextDecoder('utf-8', { fatal: true });

export function readEnvelope(body: Uint8Array, caps: JsonCaps): Envelope {
  let text: string;
  try {
    text = utf8.decode(body);
  } catch {
    throw new SchemaDrift('encoding');
  }
  const doc = boundedJson(text, caps);
  if (typeof doc === 'object' && doc !== null && !Array.isArray(doc)) {
    if (Object.hasOwn(doc, 'error_msg')) throw new SchemaDrift('provider_error');
    const { code, message } = doc as { code?: unknown; message?: unknown };
    if (code === 204 && typeof message === 'string' && Object.keys(doc).length === 2) return { kind: 'none' };
  }
  return { kind: 'document', doc };
}
