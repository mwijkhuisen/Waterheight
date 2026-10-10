import { amsterdam, floorHour, formatShort } from '../../../lib/time/time.ts';
import { m } from '../../../paraglide/messages.js';
import type { Locale } from '../../../paraglide/runtime.js';
import { LADDER } from '../../legend/palette.ts';
import { OwnerBadge } from '../../owner/OwnerBadge.tsx';
import type { Cell } from './grid.ts';
import styles from './hovmoller.module.css';
import type { Gap, HovPath } from './path.ts';

// The accessible twin of the chart (P11c, issue #26): the same cells as a real table, hours down (newest first),
// stations across, a hatched column where a stretch has no station. Nothing is carried by colour alone: every cell
// says its change or "no data" in words. Station names and the like are provider text: React text nodes only.

/** The newest rows shown at first; the rest on request (keeps the table, and axe, fast). */
export const NEWEST_ROWS = 48;

/** "25 okt 02:00 CEST": Amsterdam time with its own zone label, so the repeated DST hour reads as two rows. */
export const hourLabel = (ms: number, locale: Locale): string => `${formatShort(ms, locale)} ${amsterdam(ms).label}`;

/** "+12 cm", "−40 m³/s": the 24-hour change, signed, whole numbers, the unit of its quantity. */
export function changeText(cell: Cell | undefined, locale: Locale): string {
  if (cell === undefined || cell.change === null || cell.quantity === null) return m.hov_no_data({}, { locale });
  const n = new Intl.NumberFormat(locale === 'nl' ? 'nl-NL' : 'en-GB', {
    maximumFractionDigits: 0,
    signDisplay: 'exceptZero',
  }).format(cell.change);
  return `${n.replaceAll('-', '−')} ${cell.quantity === 'H' ? 'cm' : 'm³/s'}`;
}

const stateWord = {
  no_ref: m.state_no_ref,
  low: m.state_low,
  normal: m.state_normal,
  elevated: m.state_elevated,
  high: m.state_high,
  extreme: m.state_extreme,
} as const;

/** The state word of a ladder level, "no data" for null. */
export function stateText(level: number | null, locale: Locale): string {
  const state = level === null ? undefined : LADDER[level];
  return state === undefined ? m.hov_no_data({}, { locale }) : stateWord[state]({}, { locale });
}

/** The message of a gap band. */
export const gapText = (gap: Gap, locale: Locale): string =>
  gap.kind === 'wallonia'
    ? m.hov_gap_wallonia({}, { locale })
    : m.hov_gap_plain({ km: Math.round(gap.km) }, { locale });

interface Props {
  locale: Locale;
  /** The path's name, for the caption. */
  pathName: string;
  path: HovPath;
  hours: readonly number[];
  /** [row][column], rows as `hours`. */
  cells: readonly (readonly Cell[])[];
  /** State mode: the level per [row][column] replaces the change in the cells. */
  levels?: readonly (readonly (number | null)[])[] | undefined;
  t: number;
  selected: string | undefined;
  all: boolean;
  onAll: () => void;
  onHour: (hour: number) => void;
  onStation: (id: string) => void;
}

export function HovTable({
  locale,
  pathName,
  path,
  hours,
  cells,
  levels,
  t,
  selected,
  all,
  onAll,
  onHour,
  onStation,
}: Props) {
  const o = { locale };
  const shown = all ? hours.length : Math.min(hours.length, NEWEST_ROWS);
  const rows = Array.from({ length: shown }, (_, k) => hours.length - 1 - k).flatMap((ri) => {
    const hour = hours[ri];
    return hour === undefined ? [] : [{ ri, hour }];
  });
  // Columns in km order with a gap column where a stretch has no station.
  const heads = path.columns.flatMap((column, i) => {
    const gap = path.gaps.find((g) => g.fromX === column.x);
    return [{ kind: 'column' as const, i, column }, ...(gap === undefined ? [] : [{ kind: 'gap' as const, i, gap }])];
  });
  const now = floorHour(t);
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption>{m.hov_caption({ path: pathName }, o)}</caption>
        <thead>
          <tr>
            <th scope="col">{m.hov_col_time({}, o)}</th>
            {heads.map((h) =>
              h.kind === 'gap' ? (
                <th scope="col" key={`gap-${h.i}`} className={styles.gapHead}>
                  {gapText(h.gap, locale)}
                </th>
              ) : (
                <th scope="col" key={h.column.id}>
                  <button type="button" aria-pressed={selected === h.column.id} onClick={() => onStation(h.column.id)}>
                    {h.column.name}
                  </button>
                  {h.column.owner && (
                    <>
                      {' '}
                      <OwnerBadge locale={locale} />
                    </>
                  )}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ ri, hour }) => (
            <tr key={hour}>
              <th scope="row">
                <button type="button" aria-current={hour === now ? 'time' : undefined} onClick={() => onHour(hour)}>
                  {hourLabel(hour, locale)}
                </button>
              </th>
              {heads.map((h) =>
                h.kind === 'gap' ? (
                  <td key={`gap-${h.i}`} className={styles.gapCell} />
                ) : (
                  <td key={h.column.id}>
                    {levels === undefined
                      ? changeText(cells[ri]?.[h.i], locale)
                      : stateText(levels[ri]?.[h.i] ?? null, locale)}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {shown < hours.length && (
        <button type="button" className={styles.more} onClick={onAll}>
          {m.hov_hours_all({}, o)}
        </button>
      )}
    </div>
  );
}
