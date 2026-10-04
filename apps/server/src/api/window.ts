import { BUCKET_MS } from '@rws/contracts';
import { type Kysely, sql } from 'kysely';
import type { Logger } from 'pino';
import { type ChannelAudience, type MetaRow, VIEWS } from '../db/audience.ts';
import type { DB } from '../db/generated.ts';
import { errorCode } from '../db/pool.ts';
import { coded } from './util.ts';

export type Window = { dataEpochMs: number; displayStartMs: number };

/** How often a loaded window is read again. */
export const REFRESH_MS = 5 * 60_000;
/** How often a window that never loaded is tried again. */
export const RETRY_MS = 10_000;

/**
 * The display window of D9 (app_meta `data_epoch` and `display_start`, through
 * the family's meta view: the api's public, a publisher's own), held in memory so that validating a request never
 * asks the database. The api loads it before it listens and refreshes it every
 * 5 minutes, or every 10 seconds while it has never loaded; a failed refresh
 * keeps the last value. Until the first load the routes that need it answer
 * 503. `displayStart` is rounded up to the 10-minute grid, so the floored `t`
 * and `from` that equal it are served.
 */
export class DisplayWindow {
  private value: Window | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly db: Kysely<DB>;
  private readonly log: Pick<Logger, 'error'> | undefined;
  private readonly family: ChannelAudience;

  constructor(db: Kysely<DB>, log?: Pick<Logger, 'error'>, family: ChannelAudience = 'public') {
    this.db = db;
    this.log = log;
    this.family = family;
  }

  get current(): Window | undefined {
    return this.value;
  }

  async refresh(): Promise<boolean> {
    try {
      const { rows } = await sql<MetaRow>`
        SELECT data_epoch, display_start FROM ${sql.table(VIEWS[this.family].meta)}`.execute(this.db);
      const row = rows[0];
      if (!row?.data_epoch || !row.display_start) throw coded('no_display_window');
      this.value = {
        dataEpochMs: row.data_epoch.getTime(),
        displayStartMs: Math.ceil(row.display_start.getTime() / BUCKET_MS) * BUCKET_MS,
      };
      return true;
    } catch (err) {
      this.log?.error({ code: errorCode(err) }, 'display window not loaded');
      return false;
    }
  }

  /** Refreshes on a timer that does not keep the process alive: every RETRY_MS until loaded, then every REFRESH_MS. */
  start(): void {
    if (this.timer !== undefined) return;
    const next = () => {
      const timer = setTimeout(
        () =>
          void this.refresh().then(() => {
            if (this.timer === timer) next(); // not stopped meanwhile
          }),
        this.value === undefined ? RETRY_MS : REFRESH_MS,
      );
      timer.unref();
      this.timer = timer;
    };
    next();
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
