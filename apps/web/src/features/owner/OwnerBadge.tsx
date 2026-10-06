import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';

// A text badge for an owner-audience station, series, forecast band or threshold (T12). No owner data in it.

export function OwnerBadge({ locale }: { locale: Locale }) {
  return <strong>{m.owner_badge({}, { locale })}</strong>;
}
