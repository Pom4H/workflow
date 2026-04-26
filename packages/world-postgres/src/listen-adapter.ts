import { Client, type Pool } from 'pg';

/**
 * A live subscription returned by a {@link ListenAdapter}. Calling `close`
 * tears down the underlying connection (or pub/sub primitive) and stops
 * delivering payloads.
 */
export interface ListenSubscription {
  close(): Promise<void>;
}

/**
 * Pluggable LISTEN/NOTIFY transport for the streamer.
 *
 * The default implementation ({@link createPgListenAdapter}) uses a dedicated
 * `pg` client and the PostgreSQL `LISTEN`/`NOTIFY` protocol. Alternative
 * adapters can plug in different runtimes (e.g. `bun:sql`'s native
 * `sql.listen`, see oven-sh/bun#29710) or different transports (Redis pub/sub,
 * NATS, etc.) without touching streamer/storage code.
 *
 * Adapters MUST:
 *   * resolve the `listen()` promise only after the subscription is live so
 *     callers may rely on "no missed events from this point on";
 *   * survive transient connection drops (auto-reconnect) — events lost on
 *     the wire during a reconnect window are recovered by the streamer's
 *     polling fallback in `readFromStream`;
 *   * deliver each payload at-least-once. Duplicates are tolerated by the
 *     streamer (deduped via chunkId ordering).
 */
export interface ListenAdapter {
  listen(
    channel: string,
    onPayload: (payload: string) => Promise<void> | void
  ): Promise<ListenSubscription>;
  notify(channel: string, payload: string): Promise<void>;
}

/**
 * Default adapter backed by `pg` (`node-postgres`).
 *
 * Wraps the dedicated `Client` in a reconnect loop with exponential backoff
 * (250 ms → 30 s cap). The initial connect must succeed (callers expect a
 * live subscription before the promise resolves); subsequent reconnects are
 * best-effort. Notifications fired while the dedicated client is reconnecting
 * are lost on the wire — the polling fallback in the streamer's
 * `readFromStream` picks them up from the database on its periodic tick, so
 * end-to-end stream delivery stays correct.
 *
 * The dedicated `Client` is long-lived and will eventually be dropped by the
 * server (idle TCP timeout, pgbouncer rotation, k8s CNI eviction). The
 * unpatched `pg` behaviour does not reconnect, so a process running for more
 * than a few hours stops receiving notifications and only a restart restores
 * delivery (cf. brianc/node-postgres#967).
 */
export function createPgListenAdapter(pool: Pool): ListenAdapter {
  const notify = async (channel: string, payload: string): Promise<void> => {
    await pool.query('SELECT pg_notify($1, $2)', [channel, payload]);
  };

  const listen = async (
    channel: string,
    onPayload: (payload: string) => Promise<void> | void
  ): Promise<ListenSubscription> => {
    let client: Client | null = null;
    let closed = false;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const onNotification = (msg: { payload?: string | undefined }) => {
      try {
        const r = onPayload(msg.payload ?? '');
        if (r && typeof (r as Promise<void>).catch === 'function') {
          (r as Promise<void>).catch(() => {});
        }
      } catch {
        // swallow handler errors
      }
    };

    const detach = (c: Client | null) => {
      if (!c) return;
      try {
        c.removeListener('notification', onNotification);
      } catch {
        // listener may already be detached
      }
      c.end().catch(() => {});
    };

    const scheduleReconnect = () => {
      if (closed || reconnectTimer) return;
      const delay = Math.min(30_000, 250 * 2 ** reconnectAttempt);
      reconnectAttempt++;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (closed) return;
        connect().catch((err) => {
          // eslint-disable-next-line no-console
          console.warn(
            '[world-postgres pg-listen] reconnect failed',
            (err as Error)?.message ?? err
          );
          scheduleReconnect();
        });
      }, delay);
    };

    const connect = async () => {
      if (closed) return;
      const next = new Client(pool.options);
      next.on('error', (err) => {
        // eslint-disable-next-line no-console
        console.warn(
          '[world-postgres pg-listen] client error',
          (err as Error)?.message ?? err
        );
        if (client === next) client = null;
        detach(next);
        scheduleReconnect();
      });
      next.on('end', () => {
        if (closed) return;
        if (client === next) client = null;
        scheduleReconnect();
      });
      try {
        await next.connect();
        await next.query(`LISTEN ${channel}`);
      } catch (err) {
        await next.end().catch(() => {});
        throw err;
      }
      next.on('notification', onNotification);
      client = next;
      reconnectAttempt = 0;
    };

    await connect();

    return {
      close: async () => {
        closed = true;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        const c = client;
        client = null;
        if (!c) return;
        try {
          c.removeListener('notification', onNotification);
        } catch {
          // listener may already be detached
        }
        try {
          await c.query(`UNLISTEN ${channel}`);
        } finally {
          await c.end().catch(() => {});
        }
      },
    };
  };

  return { listen, notify };
}

/**
 * Stub adapter that defers to a future `bun:sql` native LISTEN/NOTIFY
 * implementation (oven-sh/bun#29710). Until that PR lands, callers running
 * on Bun should keep using {@link createPgListenAdapter} — `node-postgres`
 * works fine on Bun's Node compat layer; only the LISTEN path was the
 * historical pain point, and that is now self-healing in this package.
 *
 * Once `sql.listen` ships in Bun stable, the implementation becomes:
 *
 * ```ts
 * import { SQL } from 'bun';
 * export function createBunSqlListenAdapter(sql: SQL): ListenAdapter {
 *   const notify = (channel: string, payload: string) =>
 *     sql.notify(channel, payload);
 *   const listen = async (channel: string, onPayload) => {
 *     const { unlisten } = await sql.listen(channel, onPayload);
 *     return { close: () => unlisten() };
 *   };
 *   return { listen, notify };
 * }
 * ```
 *
 * Currently exported as a typed stub so consumers can compile-time-pick the
 * adapter via `process.env` without conditional imports.
 */
export function createBunSqlListenAdapter(): ListenAdapter {
  const notSupported = (): never => {
    throw new Error(
      '[world-postgres] bun:sql LISTEN/NOTIFY adapter is not yet available; ' +
        'tracked at oven-sh/bun#29710. Use createPgListenAdapter for now.'
    );
  };
  return {
    listen: () => Promise.reject(notSupported()),
    notify: () => Promise.reject(notSupported()),
  };
}
