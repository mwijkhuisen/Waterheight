import { type Kysely, sql } from 'kysely';
import type { Logger } from 'pino';
import { type MetaRow, VIEWS } from '../db/audience.ts';
import type { DB } from '../db/generated.ts';
import { errorCode } from '../db/pool.ts';
import { coded } from './util.ts';

export type Window = { dataEpochMs: number; displayStartMs: number };

/**
 * The display window of D9 (app_meta `data_epoch` and `display_start`, through
 * the public meta view), held in memory so that validating a request never
 * asks the database. The api loads it before it listens and refreshes it every
 * few minutes; a failed refresh keeps the last value. Until the first load the
 * routes that need it answer 503.
 */
export class DisplayWindow {
  private value: Window | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly db: Kysely<DB>;
  private readonly log: Pick<Logger, 'error'> | undefined;

  constructor(db: Kysely<DB>, log?: Pick<Logger, 'error'>) {
    this.db = db;
    this.log = log;
  }

  get current(): Window | undefined {
    return this.value;
  }

  async refresh(): Promise<boolean> {
    try {
      const { rows } = await sql<MetaRow>`
        SELECT data_epoch, display_start FROM ${sql.table(VIEWS.public.meta)}`.execute(this.db);
      const row = rows[0];
      if (!row?.data_epoch || !row.display_start) throw coded('no_display_window');
      this.value = { dataEpochMs: row.data_epoch.getTime(), displayStartMs: row.display_start.getTime() };
      return true;
    } catch (err) {
      this.log?.error({ code: errorCode(err) }, 'display window not loaded');
      return false;
    }
  }

  start(everyMs = 5 * 60_000): void {
    this.timer ??= setInterval(() => void this.refresh(), everyMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
