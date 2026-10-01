import type { Map as MapLibreMap } from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import { ensureTemporal, formatAmsterdam } from '../../../lib/time/temporal.ts';
import { m } from '../../../paraglide/messages.js';
import type { Locale } from '../../../paraglide/runtime.js';
import { protocolUsers } from '../protocol.ts';
import { useMapLibre } from '../useMapLibre.ts';
import { addStations } from './stations.ts';
import './spike.css';

// The P3 spike page (/_spike/, /en/_spike/): built only by `vite build --mode
// e2e`, never shipped (apps/web/test/build.test.ts). window.__spike is the
// Playwright tests' view into the page.

export interface SpikeHook {
  map: MapLibreMap | null;
  errors: string[];
  stationsStyled: number;
  protocolUsers: () => number;
  temporal?: {
    impl: 'native' | 'polyfill';
    /** 2026-10-25, the DST fall-back: the two instants of 02:30 local time. */
    first: { hour: number; offset: string };
    second: { hour: number; offset: string };
    formatted: string;
  };
}

declare global {
  interface Window {
    __spike?: SpikeHook;
  }
}

const hook: SpikeHook = { map: null, errors: [], stationsStyled: 0, protocolUsers };
window.__spike = hook;

function SpikeMap({ locale }: { locale: Locale }) {
  const ref = useRef<HTMLDivElement>(null);
  const state = useMapLibre(ref, locale, { canvasContextAttributes: { preserveDrawingBuffer: true } });
  useEffect(() => {
    if (state.status !== 'ready') return;
    const map = state.map;
    hook.map = map;
    map.on('error', (e) => hook.errors.push(e.error?.message ?? 'error'));
    const add = () => {
      hook.stationsStyled = addStations(map);
    };
    if (map.isStyleLoaded()) add();
    else map.once('load', add);
    return () => {
      hook.map = null;
      hook.stationsStyled = 0;
    };
  }, [state]);
  return (
    <>
      {state.status === 'loading' && <p>{m.map_loading({}, { locale })}</p>}
      {state.status === 'error' && (
        <p role="alert">
          {m.map_unavailable({}, { locale })} ({state.code})
        </p>
      )}
      <div ref={ref} className="spike-map" />
    </>
  );
}

export function Spike({ locale }: { locale: Locale }) {
  const [shown, setShown] = useState(true);
  const [time, setTime] = useState('');
  useEffect(() => {
    ensureTemporal().then((impl) => {
      const at = (iso: string) => {
        const z = Temporal.Instant.from(iso).toZonedDateTimeISO('Europe/Amsterdam');
        return { hour: z.hour, offset: z.offset };
      };
      const formatted = formatAmsterdam('2026-10-25T01:30:00Z', locale);
      hook.temporal = { impl, first: at('2026-10-25T00:30:00Z'), second: at('2026-10-25T01:30:00Z'), formatted };
      setTime(formatted);
    });
  }, [locale]);
  return (
    <>
      <h1>{m.spike_heading({}, { locale })}</h1>
      <p>{m.spike_intro({}, { locale })}</p>
      <p>
        {m.spike_time({}, { locale })}: <time dateTime="2026-10-25T01:30:00Z">{time}</time>
      </p>
      <button type="button" onClick={() => setShown((s) => !s)}>
        {shown ? m.spike_toggle_hide({}, { locale }) : m.spike_toggle_show({}, { locale })}
      </button>
      {shown && <SpikeMap locale={locale} />}
    </>
  );
}
