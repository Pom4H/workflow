import type { Pool } from 'pg';
import type { ListenAdapter } from './listen-adapter.js';

type PgConnectionConfig =
  | { connectionString: string; maxPoolSize?: number; pool?: undefined }
  | { pool: Pool; connectionString?: undefined; maxPoolSize?: undefined };

export type PostgresWorldConfig = PgConnectionConfig & {
  jobPrefix?: string;
  queueConcurrency?: number;
  /**
   * Override the flush interval (in ms) for buffered stream writes.
   * Default is 10ms. Set to 0 for immediate flushing.
   */
  streamFlushIntervalMs?: number;
  /**
   * Plug in an alternative LISTEN/NOTIFY transport for the streamer.
   * Defaults to the bundled `pg`-backed adapter (with self-healing reconnect).
   * See {@link ListenAdapter} for the contract; useful for swapping in
   * `bun:sql`'s native listen (oven-sh/bun#29710) once it lands, or a
   * different pub/sub backend entirely.
   */
  listenAdapter?: ListenAdapter;
};
