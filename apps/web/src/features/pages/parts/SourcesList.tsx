import { lazy, Suspense } from 'react';
import { useAudience, useContracts, useSources } from '../../../lib/data/api.ts';
import { m } from '../../../paraglide/messages.js';
import type { Locale } from '../../../paraglide/runtime.js';
import { OwnerBadge } from '../../owner/OwnerBadge.tsx';
import { Pending } from './DataFrame.tsx';
import styles from './pages.module.css';
import { attributionRows, licenceLine } from './sources.ts';

// The Sources page's list (P10b), from sources.json only: every source the site shows, its licence and every credit
// the registry requires or suggests in every language, with the date a licence asks for. Provider and registry text is
// text, and a link only when it is an https URL (invariant 3). Nothing is keyed to a source id, so a source that turns
// public later is listed with no code change. On the owner site a personal-use source carries its badge and its basis,
// from the owner chunk the layout already loads (never a chunk of its own).

const OwnerBasis = lazy(() => import('../../owner/index.ts').then((o) => ({ default: o.OwnerBasis })));

export function SourcesList({ locale }: { locale: Locale }) {
  const o = { locale };
  const sources = useSources();
  const contracts = useContracts();
  const owner = useAudience() === 'owner';
  if (sources.data === undefined) return <Pending locale={locale} error={sources.isError} />;
  const list = sources.data.sources.filter((s) => contracts?.hidden(s.id) !== true);
  if (list.length === 0) return <p>{m.src_none({}, o)}</p>;
  return (
    <ul className={styles.sources}>
      {list.map((s) => {
        const licence = licenceLine(s.licence, locale);
        const personal = owner && s.audience === 'owner';
        return (
          <li key={s.id} className={styles.source}>
            <h3>
              {s.name}
              {personal && (
                <>
                  {' '}
                  <OwnerBadge locale={locale} />
                </>
              )}
            </h3>
            <dl className={styles.facts}>
              <dt>{m.src_provider({}, o)}</dt>
              <dd>{s.provider}</dd>
              <dt>{m.src_id({}, o)}</dt>
              <dd>{s.id}</dd>
              <dt>{m.src_licence({}, o)}</dt>
              <dd>
                {licence.href === undefined ? (
                  (licence.text ?? m.src_licence_none({}, o))
                ) : (
                  <a href={licence.href} rel="noopener noreferrer">
                    {licence.text}
                  </a>
                )}
              </dd>
              <dt>{m.src_attribution({}, o)}</dt>
              <dd>
                <ul className={styles.rows}>
                  {attributionRows(s, locale).map((a) => (
                    <li key={`${a.lang}|${a.text}`}>
                      <span lang={a.lang ?? undefined}>
                        {a.href === undefined ? (
                          a.text
                        ) : (
                          <a href={a.href} rel="noopener noreferrer">
                            {a.text}
                          </a>
                        )}
                      </span>
                      {a.lang !== null && <span className={styles.lang}> ({a.lang})</span>}
                      {!a.required && <span className={styles.optional}> ({m.src_optional({}, o)})</span>}
                    </li>
                  ))}
                </ul>
              </dd>
            </dl>
            {personal && s.privateBasis != null && (
              <Suspense fallback={null}>
                <OwnerBasis locale={locale} basis={s.privateBasis} />
              </Suspense>
            )}
          </li>
        );
      })}
    </ul>
  );
}
