import { useStatusPage } from '../../../lib/data/api.ts';
import { m } from '../../../paraglide/messages.js';
import type { Locale } from '../../../paraglide/runtime.js';
import { countryName } from './country.ts';
import { Pending, TableFrame } from './DataFrame.tsx';
import { reachRows } from './method.ts';
import { forecastMatrix } from './status.ts';

// Where official forecasts exist (the Method page, P10b; catalogue §0.5), from status.json's forecast coverage: the
// first-release stations with a current forecast per country and per river reach, and for a reach what a permission
// would add and which agencies publish none. Agency and reach names come from the file and are text.

export function ForecastCoverage({ locale }: { locale: Locale }) {
  const o = { locale };
  const status = useStatusPage();
  if (status.data === undefined) return <Pending locale={locale} error={status.isError} />;
  // The owner site shows its own family's coverage (the one its map shows); the public site its only one.
  const pair = status.data.forecastCoverage;
  const coverage = pair.owner === undefined ? pair.public : pair.owner;
  if (coverage === null) return <p>{m.data_unavailable({}, o)}</p>;
  const countries = forecastMatrix({ public: coverage, owner: undefined }, locale).rows;
  return (
    <>
      <TableFrame label={m.coverage_countries_caption({}, o)}>
        <thead>
          <tr>
            <th scope="col">{m.stat_col_country({}, o)}</th>
            <th scope="col">{m.stat_col_with_forecast({}, o)}</th>
          </tr>
        </thead>
        <tbody>
          {countries.map((r) => (
            <tr key={r.country ?? 'total'}>
              <th scope="row">{r.country === null ? m.stat_total({}, o) : countryName(r.country, locale)}</th>
              <td>{r.cells.join(' ')}</td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
      <TableFrame label={m.coverage_reaches_caption({}, o)}>
        <thead>
          <tr>
            <th scope="col">{m.coverage_col_reach({}, o)}</th>
            <th scope="col">{m.stat_col_with_forecast({}, o)}</th>
            <th scope="col">{m.coverage_col_forecast({}, o)}</th>
          </tr>
        </thead>
        <tbody>
          {reachRows(coverage, locale).map((r) => (
            <tr key={r.id}>
              <th scope="row">{r.name}</th>
              <td>{r.cover}</td>
              <td>
                <ul>
                  {r.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
    </>
  );
}
