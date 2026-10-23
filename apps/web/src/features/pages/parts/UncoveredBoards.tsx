import { Fragment } from 'react';
import { m } from '../../../paraglide/messages.js';
import type { Locale } from '../../../paraglide/runtime.js';
import { TableFrame } from './DataFrame.tsx';
import { uncoveredRows } from './method.ts';

// The Dutch water boards with no data on the map (D32), from method.gen.ts (catalogue 2.8 and registry/uncovered.yaml):
// the rivers and the nearest public gauges, each a plain link to the map. No board source is named.

export function UncoveredBoards({ locale }: { locale: Locale }) {
  const o = { locale };
  return (
    <TableFrame label={m.uncovered_caption({}, o)}>
      <thead>
        <tr>
          <th scope="col">{m.uncovered_col_board({}, o)}</th>
          <th scope="col">{m.uncovered_col_rivers({}, o)}</th>
          <th scope="col">{m.uncovered_col_gauge({}, o)}</th>
        </tr>
      </thead>
      <tbody>
        {uncoveredRows(locale).map((r) => (
          <tr key={r.board}>
            <th scope="row">{r.board}</th>
            <td>{r.rivers}</td>
            <td>
              {r.gauges.map((g, i) => (
                <Fragment key={g.id}>
                  {i > 0 ? ', ' : ''}
                  <a href={g.href}>{g.name}</a>
                </Fragment>
              ))}
            </td>
          </tr>
        ))}
      </tbody>
    </TableFrame>
  );
}
