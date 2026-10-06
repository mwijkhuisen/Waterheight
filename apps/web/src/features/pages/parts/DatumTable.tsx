import { m } from '../../../paraglide/messages.js';
import type { Locale } from '../../../paraglide/runtime.js';
import { TableFrame } from './DataFrame.tsx';
import { datumRows } from './method.ts';

// The vertical datums of the Method page (P10b), from @rws/core/datums, the table the station panel converts with:
// H_NAP = H_datum + offset. A datum with no usable offset (the French and local ones) says "not converted" and never
// a number.

export function DatumTable({ locale }: { locale: Locale }) {
  const o = { locale };
  return (
    <TableFrame label={m.datum_caption({}, o)}>
      <thead>
        <tr>
          <th scope="col">{m.datum_col_datum({}, o)}</th>
          <th scope="col">{m.datum_col_offset({}, o)}</th>
          <th scope="col">{m.datum_col_uncertainty({}, o)}</th>
          <th scope="col">{m.datum_col_status({}, o)}</th>
        </tr>
      </thead>
      <tbody>
        {datumRows(locale).map((r) => (
          <tr key={r.datum}>
            <th scope="row">{r.datum}</th>
            <td>{r.offset ?? m.stat_na({}, o)}</td>
            <td>{r.uncertainty ?? m.stat_na({}, o)}</td>
            <td>{r.converted}</td>
          </tr>
        ))}
      </tbody>
    </TableFrame>
  );
}
