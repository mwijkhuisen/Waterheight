import type { ReachTravelData } from '../../../lib/data/contracts.ts';
import { httpsHref } from '../../../lib/href.ts';
import { travelPriorOf, travelText } from '../../../lib/travel.ts';
import { m } from '../../../paraglide/messages.js';
import type { Locale } from '../../../paraglide/runtime.js';

// The Method page's travel times (P10b; catalogue §3.7), pure: sourced ranges between two stations, "indicative", in
// hours. Never relative to now and never an arrival time: a pair is "lo–hi h" and nothing more.

export interface TravelRowView {
  key: string;
  from: string;
  to: string;
  range: string;
  basis: string;
  source: string;
  /** The source's link when it is an https URL (invariant 3), else undefined. */
  href: string | undefined;
}

/** A pair whose station is unknown to the stations answer shows the id as the file gives it. */
export function travelRows(
  travel: ReachTravelData,
  names: ReadonlyMap<string, string>,
  locale: Locale,
): TravelRowView[] {
  return travel.travel_times.map((t) => ({
    key: `${t.from_station_id}\n${t.to_station_id}\n${t.basis}`,
    from: names.get(t.from_station_id) ?? t.from_station_id,
    to: names.get(t.to_station_id) ?? t.to_station_id,
    range: travelText(travelPriorOf(t), locale) ?? m.travel_no_source({}, { locale }),
    basis: t.basis,
    source: t.source,
    href: httpsHref(t.source_url),
  }));
}
