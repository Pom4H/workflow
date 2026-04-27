import type { Pool } from 'pg';

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
   * How often (ms) `streams.get` re-queries the `streams` table as a safety
   * net for chunks delivered while the LISTEN client was reconnecting.
   * Default is 5000. Set to 0 to disable polling entirely.
   *
   * See `CreateStreamerOptions.pollIntervalMs` for the full contract.
   */
  streamPollIntervalMs?: number;
};
