import { m } from '../../../paraglide/messages.js';
import type { Locale } from '../../../paraglide/runtime.js';
import { LOG } from '../policy.ts';

// The numbers of the privacy page's log sentences. They come from policy.ts, which test/privacy-policy.test.ts holds
// to the Caddy files and the beacon's cap, so the page says what the configuration does and no message holds a number.

export function LogPolicy({ locale, topic }: { locale: Locale; topic: 'access' | 'beacon' }) {
  return (
    <p>
      {topic === 'access'
        ? m.privacy_log_mask({ ipv4: String(LOG.ipv4), ipv6: String(LOG.ipv6), days: String(LOG.keepDays) }, { locale })
        : m.privacy_beacon_size({ kb: String(LOG.beaconMaxBytes / 1024) }, { locale })}
    </p>
  );
}
