import { useMemo } from 'react';
import { useReachTravel, useStations } from '../../../lib/data/api.ts';
import { m } from '../../../paraglide/messages.js';
import type { Locale } from '../../../paraglide/runtime.js';
import { Pending, TableFrame } from './DataFrame.tsx';
import { travelRows } from './travel.ts';

// Typical travel times of flood peaks (the Method page, P10b; catalogue §3.7), from the installed reaches file:
// sourced ranges in hours between two stations, "indicative" and nothing more, never relative to now and never an
// arrival time. Station names come from the stations answer (an unknown station shows its id); the source's link only
// when it is an https URL. The stations are not waited for: the page shows ids until their names arrive.

export function TravelTimes({ locale }: { locale: Locale }) {
  const o = { locale };
  const travel = useReachTravel();
  const stations = useStations().data?.stations;
  const names = useMemo(() => new Map((stations ?? []).map((s) => [s.id, s.name])), [stations]);
  if (travel.data === undefined) return <Pending locale={locale} error={travel.isError} />;
  const rows = travelRows(travel.data, names, locale);
  if (rows.length === 0) return <p>{m.travel_none({}, o)}</p>;
  return (
    <TableFrame label={m.travel_caption({}, o)}>
      <thead>
        <tr>
          <th scope="col">{m.travel_col_from({}, o)}</th>
          <th scope="col">{m.travel_col_to({}, o)}</th>
          <th scope="col">{m.travel_col_time({}, o)}</th>
          <th scope="col">{m.travel_col_basis({}, o)}</th>
          <th scope="col">{m.col_source({}, o)}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <th scope="row">{r.from}</th>
            <td>{r.to}</td>
            <td>{r.range}</td>
            <td>{r.basis}</td>
            <td>
              {r.href === undefined ? (
                r.source
              ) : (
                <a href={r.href} rel="noopener noreferrer">
                  {r.source}
                </a>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </TableFrame>
  );
}
