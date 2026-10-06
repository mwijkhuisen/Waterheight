import { m } from '../../../paraglide/messages.js';
import type { Locale } from '../../../paraglide/runtime.js';
import { TableFrame } from './DataFrame.tsx';
import { classRows, referenceRows } from './method.ts';

// The class crosswalk and the reference roles of the Method page (P10b), from features/pages/method.gen.ts only: the
// public, ungated rows of the code's own tables (catalogue §4.9, ADR-0009), so the page cannot drift from the
// classifier. Codes and short names are the agencies' own words, shown as published; every other word is a message.

export function CrosswalkTable({ locale }: { locale: Locale }) {
  const o = { locale };
  return (
    <>
      <TableFrame label={m.method_classes_caption({}, o)}>
        <thead>
          <tr>
            <th scope="col">{m.col_source({}, o)}</th>
            <th scope="col">{m.method_col_agency({}, o)}</th>
            <th scope="col">{m.method_col_scale({}, o)}</th>
            <th scope="col">{m.method_col_code({}, o)}</th>
            <th scope="col">{m.col_state({}, o)}</th>
            <th scope="col">{m.method_col_measure({}, o)}</th>
            <th scope="col">{m.method_col_group({}, o)}</th>
            <th scope="col">{m.col_notes({}, o)}</th>
          </tr>
        </thead>
        <tbody>
          {classRows(locale).map((r) => (
            <tr key={r.key}>
              <th scope="row">{r.source}</th>
              <td>{r.agency}</td>
              <td>{r.scale}</td>
              <td>{r.code}</td>
              <td>{r.level}</td>
              <td>{r.measure}</td>
              <td>{r.group}</td>
              <td>{r.note}</td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
      <TableFrame label={m.method_refs_caption({}, o)}>
        <thead>
          <tr>
            <th scope="col">{m.col_source({}, o)}</th>
            <th scope="col">{m.method_col_agency({}, o)}</th>
            <th scope="col">{m.method_col_reference({}, o)}</th>
            <th scope="col">{m.method_col_rule({}, o)}</th>
            <th scope="col">{m.col_state({}, o)}</th>
            <th scope="col">{m.method_col_measure({}, o)}</th>
            <th scope="col">{m.method_col_group({}, o)}</th>
            <th scope="col">{m.method_col_form({}, o)}</th>
          </tr>
        </thead>
        <tbody>
          {referenceRows(locale).map((r) => (
            <tr key={r.key}>
              <th scope="row">{r.source}</th>
              <td>{r.agency}</td>
              <td>{r.short}</td>
              <td>{r.rule}</td>
              <td>{r.level}</td>
              <td>{r.measure}</td>
              <td>{r.group}</td>
              <td>{r.form}</td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
    </>
  );
}
