import { useContracts, useOwnerSources, useStatusPage } from '../../../lib/data/api.ts';
import { formatLocal } from '../../../lib/time/time.ts';
import { m } from '../../../paraglide/messages.js';
import type { Locale } from '../../../paraglide/runtime.js';
import { OwnerBadge } from '../../owner/OwnerBadge.tsx';
import { countryName } from './country.ts';
import { Pending, TableFrame } from './DataFrame.tsx';
import { numberText } from './numbers.ts';
import { classMatrix, forecastMatrix, type Matrix, statusRows } from './status.ts';

// The Status page's tables (P10b), from status.json only: per source the state, the last fetch, the newest value, the
// loader's lag and the coverage, the twin checks, and the classification and forecast coverage per country. Every
// cell is text, nothing is a link. The public file gives two counts of personal-use sources; the owner site's file
// lists them (with their badge) and shows both families' coverage side by side.

function CoverageTable({
  locale,
  label,
  columns,
  matrix,
}: {
  locale: Locale;
  label: string;
  columns: string[];
  matrix: Matrix;
}) {
  const o = { locale };
  const both = matrix.families.length > 1;
  const family = (f: 'public' | 'owner') => (f === 'public' ? m.stat_family_public({}, o) : m.stat_family_owner({}, o));
  return (
    <TableFrame label={label}>
      <thead>
        <tr>
          <th scope="col" rowSpan={both ? 2 : 1}>
            {m.stat_col_country({}, o)}
          </th>
          {both
            ? matrix.families.map((f) => (
                <th key={f} scope="colgroup" colSpan={columns.length}>
                  {family(f)}
                </th>
              ))
            : columns.map((c) => (
                <th key={c} scope="col">
                  {c}
                </th>
              ))}
        </tr>
        {both && (
          <tr>
            {matrix.families.flatMap((f) =>
              columns.map((c) => (
                <th key={`${f}|${c}`} scope="col">
                  {c}
                </th>
              )),
            )}
          </tr>
        )}
      </thead>
      <tbody>
        {matrix.rows.map((r) => (
          <tr key={r.country ?? 'total'}>
            <th scope="row">{r.country === null ? m.stat_total({}, o) : countryName(r.country, locale)}</th>
            {r.cells.map((cell, i) => (
              // The cells run family by family, `columns` each: a cell's family and column are its identity.
              <td key={`${matrix.families[Math.floor(i / columns.length)]}|${columns[i % columns.length]}`}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </TableFrame>
  );
}

export function StatusTables({ locale }: { locale: Locale }) {
  const o = { locale };
  const status = useStatusPage();
  const contracts = useContracts();
  const personal = useOwnerSources();
  if (status.data === undefined) return <Pending locale={locale} error={status.isError} />;
  const d = status.data;
  const rows = statusRows(
    d.sources.filter((s) => contracts?.hidden(s.id) !== true),
    locale,
  );
  return (
    <>
      <p>{m.stat_generated({ time: formatLocal(Date.parse(d.generatedAt), locale) }, o)}</p>
      {d.ownerLine !== null && (
        <p>
          {m.stat_owner_line(
            { healthy: numberText(d.ownerLine.healthy, locale), total: numberText(d.ownerLine.total, locale) },
            o,
          )}
        </p>
      )}
      <TableFrame label={m.stat_sources_caption({}, o)}>
        <thead>
          <tr>
            <th scope="col">{m.col_source({}, o)}</th>
            <th scope="col">{m.stat_col_status({}, o)}</th>
            <th scope="col">{m.stat_col_fetch({}, o)}</th>
            <th scope="col">{m.stat_col_newest({}, o)}</th>
            <th scope="col">{m.stat_col_lag({}, o)}</th>
            <th scope="col">{m.stat_col_coverage({}, o)}</th>
            <th scope="col">{m.stat_col_forecast({}, o)}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <th scope="row">
                {r.id}
                {personal.has(r.id) && (
                  <>
                    {' '}
                    <OwnerBadge locale={locale} />
                  </>
                )}
              </th>
              <td>{r.status}</td>
              <td>{r.lastFetch}</td>
              <td>{r.newest}</td>
              <td>{r.lag}</td>
              <td>{r.coverage}</td>
              <td>{r.forecast}</td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
      <TableFrame label={m.stat_twins_caption({}, o)}>
        <thead>
          <tr>
            <th scope="col">{m.stat_twins_ok({}, o)}</th>
            <th scope="col">{m.stat_twins_failing({}, o)}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{numberText(d.twins.ok, locale)}</td>
            <td>{numberText(d.twins.failing, locale)}</td>
          </tr>
        </tbody>
      </TableFrame>
      <CoverageTable
        locale={locale}
        label={m.stat_classes_caption({}, o)}
        columns={[m.stat_col_tier1({}, o), m.stat_col_first_release({}, o)]}
        matrix={classMatrix(d.classification, locale)}
      />
      <CoverageTable
        locale={locale}
        label={m.stat_forecast_caption({}, o)}
        columns={[m.stat_col_with_forecast({}, o)]}
        matrix={forecastMatrix(d.forecastCoverage, locale)}
      />
    </>
  );
}
