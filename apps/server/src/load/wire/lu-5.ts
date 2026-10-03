import { emptyNormalised, SchemaDrift } from '@rws/core';
import { TIME as LU5_TIME, normalise } from '../../adapters/lu-5/normalise.ts';
import { parseCap, parseList } from '../../adapters/lu-5/parse.ts';
import { checkXmlText, GuardFailure, XML_MAX_BYTES } from '../../http/guards.ts';
import type { DstProof, LoadAdapter } from '../adapters.ts';

// P7a: the loader wiring of LU-5 (its specs, its time convention and, for a gated convention, its DST proof),
// merged into load/adapters.ts. A wiring file may use the guards and the registry tables; the adapter stays pure.
//
// `lu-5-cap` has two kinds of manifest line: the dataset's resource list (the root request and its next pages;
// only the shape is checked, nothing is stored) and each CAP file (variant `file/<resource id>`), which runs the
// XML guard here (size, UTF-8, no DOCTYPE or ENTITY, the tag, item and depth caps, well-formedness) before the
// pure parser, which checks the text again.

export const SOURCE = 'LU-5';
export const TIME = LU5_TIME;
export const PROOF: Readonly<Record<string, DstProof>> = {};

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** A body as text: UTF-8 or drift, and within the XML guard's size. */
function utf8(body: Uint8Array, max: number): string {
  if (body.length > max) throw new SchemaDrift('xml_size');
  try {
    return UTF8.decode(body);
  } catch {
    throw new SchemaDrift('xml_utf8');
  }
}

export const ADAPTER: LoadAdapter = {
  version: 1,
  specs: {
    'lu-5-cap': {
      maxBytes: 2 * 1024 * 1024,
      needsVariant: false,
      run: (body, ctx) => {
        if (!ctx.variant.startsWith('file/')) {
          parseList(utf8(body, 2 * 1024 * 1024));
          return emptyNormalised();
        }
        const xml = utf8(body, XML_MAX_BYTES);
        try {
          checkXmlText(xml);
        } catch (err) {
          if (err instanceof GuardFailure) throw new SchemaDrift(err.reason);
          throw err;
        }
        return normalise(parseCap(xml), ctx);
      },
    },
  },
};
