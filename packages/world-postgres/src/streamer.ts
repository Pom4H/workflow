import { EventEmitter } from 'node:events';
import type {
  GetChunksOptions,
  StreamChunksResponse,
  Streamer,
  StreamInfoResponse,
} from '@workflow/world';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { Client, type Pool } from 'pg';
import { monotonicFactory } from 'ulid';
import * as z from 'zod';
import { type Drizzle, Schema } from './drizzle/index.js';
import { Mutex } from './util.js';

const StreamPublishMessage = z.object({
  streamId: z.string(),
  chunkId: z.templateLiteral(['chnk_', z.string()]),
});

interface StreamChunkEvent {
  id: `chnk_${string}`;
  data: Uint8Array;
  eof: boolean;
}

class Rc<T extends { drop(): void }> {
  private refCount = 0;
  constructor(private resource: T) {}
  acquire() {
    this.refCount++;
    return {
      ...this.resource,
      [Symbol.dispose]: () => {
        this.release();
      },
    };
  }
  release() {
    this.refCount--;
    if (this.refCount <= 0) {
      this.resource.drop();
    }
  }
}

/**
 * Subscribe to a PostgreSQL NOTIFY channel using a dedicated client created
 * from the pool's connection options. `channel` must be a trusted identifier.
 *
 * The dedicated `Client` is long-lived and will eventually be dropped by the
 * server (idle TCP timeout, pgbouncer rotation, k8s CNI eviction). The
 * unpatched implementation does not reconnect, so a process running for more
 * than a few hours stops receiving notifications and only a restart restores
 * delivery (cf. brianc/node-postgres#967, where the pg maintainers say the
 * consumer must reconnect on `error`/`end`).
 *
 * This implementation wraps `Client` in a reconnect loop with exponential
 * backoff (250 ms → 30 s cap). The initial connect must succeed (callers
 * expect a live subscription before the promise resolves); subsequent
 * reconnects are best-effort. Notifications fired while the dedicated client
 * is reconnecting are lost on the wire — the polling fallback in
 * `readFromStream` picks them up from the database on its periodic tick, so
 * end-to-end stream delivery stays correct.
 */
export const listenChannel = async (
  pool: Pool,
  channel: string,
  onPayload: (payload: string) => Promise<void>
): Promise<{ close: () => Promise<void> }> => {
  let client: Client | null = null;
  let closed = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const onNotification = (msg: { payload?: string | undefined }) => {
    onPayload(msg.payload ?? '').catch(() => {});
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
          '[world-postgres listenChannel] reconnect failed',
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
        '[world-postgres listenChannel] client error',
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

export type PostgresStreamer = Streamer & {
  /** Unlisten from the LISTEN subscription and release resources. */
  close(): Promise<void>;
};

export function createStreamer(pool: Pool, drizzle: Drizzle): PostgresStreamer {
  const ulid = monotonicFactory();
  const events = new EventEmitter<{
    [key: `strm:${string}`]: [StreamChunkEvent];
  }>();
  const { streams } = Schema;
  const genChunkId = () => `chnk_${ulid()}` as const;
  const mutexes = new Map<string, Rc<{ drop(): void; mutex: Mutex }>>();
  const getMutex = (key: string) => {
    let mutex = mutexes.get(key);
    if (!mutex) {
      mutex = new Rc({
        mutex: new Mutex(),
        drop: () => mutexes.delete(key),
      });
      mutexes.set(key, mutex);
    }
    return mutex.acquire();
  };

  const STREAM_TOPIC = 'workflow_event_chunk';

  const listenSubscription = listenChannel(pool, STREAM_TOPIC, async (msg) => {
    const parsed = StreamPublishMessage.parse(JSON.parse(msg));

    const key = `strm:${parsed.streamId}` as const;
    if (!events.listenerCount(key)) {
      return;
    }

    const resource = getMutex(key);
    await resource.mutex.andThen(async () => {
      const [value] = await drizzle
        .select({ eof: streams.eof, data: streams.chunkData })
        .from(streams)
        .where(
          and(
            eq(streams.streamId, parsed.streamId),
            eq(streams.chunkId, parsed.chunkId)
          )
        )
        .limit(1);
      if (!value) return;
      const { data, eof } = value;
      events.emit(key, { id: parsed.chunkId, data, eof });
    });
  });

  const notifyStream = async (payload: string) => {
    await pool.query('SELECT pg_notify($1, $2)', [STREAM_TOPIC, payload]);
  };

  // Helper to convert chunk to Buffer
  const toBuffer = (chunk: string | Uint8Array): Buffer =>
    !Buffer.isBuffer(chunk) ? Buffer.from(chunk) : chunk;

  return {
    async writeToStream(
      name: string,
      _runId: string | Promise<string>,
      chunk: string | Uint8Array
    ) {
      // Await runId if it's a promise to ensure proper flushing
      const runId = await _runId;

      const chunkId = genChunkId();
      await drizzle.insert(streams).values({
        chunkId,
        streamId: name,
        runId,
        chunkData: toBuffer(chunk),
        eof: false,
      });
      await notifyStream(
        JSON.stringify(
          StreamPublishMessage.encode({
            chunkId,
            streamId: name,
          })
        )
      );
    },

    async writeToStreamMulti(
      name: string,
      _runId: string | Promise<string>,
      chunks: (string | Uint8Array)[]
    ) {
      if (chunks.length === 0) return;

      // Generate all chunk IDs up front to preserve ordering
      const chunkIds = chunks.map(() => genChunkId());

      // Await runId if it's a promise to ensure proper flushing
      const runId = await _runId;

      // Batch insert all chunks in a single query
      await drizzle.insert(streams).values(
        chunks.map((chunk, i) => ({
          chunkId: chunkIds[i],
          streamId: name,
          runId,
          chunkData: toBuffer(chunk),
          eof: false,
        }))
      );

      // Notify for each chunk (could be batched in future if needed)
      for (const chunkId of chunkIds) {
        await notifyStream(
          JSON.stringify(
            StreamPublishMessage.encode({
              chunkId,
              streamId: name,
            })
          )
        );
      }
    },
    async closeStream(
      name: string,
      _runId: string | Promise<string>
    ): Promise<void> {
      // Await runId if it's a promise to ensure proper flushing
      const runId = await _runId;

      const chunkId = genChunkId();
      await drizzle.insert(streams).values({
        chunkId,
        streamId: name,
        runId,
        chunkData: Buffer.from([]),
        eof: true,
      });
      await notifyStream(
        JSON.stringify(
          StreamPublishMessage.encode({
            streamId: name,
            chunkId,
          })
        )
      );
    },
    async getStreamChunks(
      name: string,
      _runId: string,
      options?: GetChunksOptions
    ): Promise<StreamChunksResponse> {
      const limit = options?.limit ?? 100;

      // Decode cursor to get the last seen chunkId
      let cursorChunkId: string | null = null;
      if (options?.cursor) {
        try {
          const decoded = JSON.parse(
            Buffer.from(options.cursor, 'base64').toString('utf-8')
          );
          cursorChunkId = decoded.c;
        } catch {
          // Invalid cursor, start from beginning
        }
      }

      // Fetch only data rows (exclude EOF) with limit + 1 to detect hasMore.
      // Filtering EOF here avoids the edge case where an EOF row sorting
      // mid-batch (e.g. due to clock skew) silently drops data rows.
      const rows = await drizzle
        .select({
          chunkId: streams.chunkId,
          data: streams.chunkData,
        })
        .from(streams)
        .where(
          and(
            eq(streams.streamId, name),
            eq(streams.eof, false),
            ...(cursorChunkId
              ? [gt(streams.chunkId, cursorChunkId as `chnk_${string}`)]
              : [])
          )
        )
        .orderBy(asc(streams.chunkId))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const pageRows = rows.slice(0, limit);

      // Check if stream is complete via a separate EOF query
      let streamDone = false;
      const [eofRow] = await drizzle
        .select({ eof: streams.eof })
        .from(streams)
        .where(and(eq(streams.streamId, name), eq(streams.eof, true)))
        .limit(1);
      if (eofRow) {
        streamDone = true;
      }

      // Build the cursor index: we need a running index across pages.
      // Decode the current start index from the cursor.
      let baseIndex = 0;
      if (options?.cursor) {
        try {
          const decoded = JSON.parse(
            Buffer.from(options.cursor, 'base64').toString('utf-8')
          );
          if (typeof decoded.i === 'number') {
            baseIndex = decoded.i;
          }
        } catch {
          // Invalid cursor
        }
      }

      const chunks = pageRows.map((row, i) => ({
        index: baseIndex + i,
        data: new Uint8Array(row.data),
      }));

      const nextCursor =
        hasMore && pageRows.length > 0
          ? Buffer.from(
              JSON.stringify({
                c: pageRows[pageRows.length - 1].chunkId,
                i: baseIndex + pageRows.length,
              })
            ).toString('base64')
          : null;

      return {
        data: chunks,
        cursor: nextCursor,
        hasMore,
        done: streamDone,
      };
    },

    async getStreamInfo(
      name: string,
      _runId: string
    ): Promise<StreamInfoResponse> {
      // Use COUNT(*) instead of fetching all rows into memory
      const [countResult] = await drizzle
        .select({ count: sql<number>`count(*)` })
        .from(streams)
        .where(and(eq(streams.streamId, name), eq(streams.eof, false)));

      const dataCount = Number(countResult?.count ?? 0);

      // Check for EOF
      const [eofRow] = await drizzle
        .select({ eof: streams.eof })
        .from(streams)
        .where(and(eq(streams.streamId, name), eq(streams.eof, true)))
        .limit(1);

      return {
        tailIndex: dataCount - 1,
        done: !!eofRow,
      };
    },

    async readFromStream(
      name: string,
      startIndex?: number
    ): Promise<ReadableStream<Uint8Array>> {
      const cleanups: (() => void)[] = [];

      return new ReadableStream<Uint8Array>({
        async start(controller) {
          // an empty string is always < than any string,
          // so `'' < ulid()` and `ulid() < ulid()` (maintaining order)
          let lastChunkId = '';
          let offset = startIndex ?? 0;
          let buffer = [] as StreamChunkEvent[] | null;
          let polling = false;
          let closed = false;

          function enqueue(msg: {
            id: string;
            data: Uint8Array;
            eof: boolean;
          }) {
            if (lastChunkId >= msg.id) {
              // already sent or out of order
              return;
            }

            if (offset > 0) {
              offset--;
              return;
            }

            if (msg.data.byteLength) {
              controller.enqueue(new Uint8Array(msg.data));
            }
            if (msg.eof) {
              controller.close();
            }
            lastChunkId = msg.id;
          }

          function onData(data: StreamChunkEvent) {
            if (buffer) {
              buffer.push(data);
              return;
            }
            enqueue(data);
          }
          events.on(`strm:${name}`, onData);
          cleanups.push(() => {
            events.off(`strm:${name}`, onData);
          });

          const chunks = await drizzle
            .select({
              id: streams.chunkId,
              eof: streams.eof,
              data: streams.chunkData,
            })
            .from(streams)
            .where(and(eq(streams.streamId, name)))
            .orderBy(streams.chunkId);

          // Resolve negative offset relative to the data chunk count
          // (excluding the trailing EOF marker, if present)
          if (typeof offset === 'number' && offset < 0) {
            const dataCount =
              chunks.length > 0 && chunks[chunks.length - 1].eof
                ? chunks.length - 1
                : chunks.length;
            offset = Math.max(0, dataCount + offset);
          }

          for (const chunk of [...chunks, ...(buffer ?? [])]) {
            enqueue(chunk);
          }
          buffer = null;

          // Polling fallback. NOTIFY is the fast path, but events are silently
          // dropped while the dedicated `listenChannel` client is reconnecting
          // (and would be dropped entirely on the unpatched implementation).
          // A light periodic re-query of chunks past `lastChunkId` is the
          // always-on safety net: every POLL_INTERVAL_MS it pulls any chunks
          // the EventEmitter missed, deduped by the `enqueue` ordering check.
          // Stops automatically on EOF (controller.close prevents further
          // enqueues), on cancel, or on closed controller (try/catch in poll).
          const POLL_INTERVAL_MS = 5_000;
          const pollTimer = setInterval(async () => {
            if (polling || closed) return;
            polling = true;
            try {
              const fresh = await drizzle
                .select({
                  id: streams.chunkId,
                  eof: streams.eof,
                  data: streams.chunkData,
                })
                .from(streams)
                .where(
                  and(
                    eq(streams.streamId, name),
                    gt(streams.chunkId, lastChunkId as `chnk_${string}`)
                  )
                )
                .orderBy(streams.chunkId);
              for (const chunk of fresh) {
                enqueue(chunk);
              }
            } catch (err) {
              // Best-effort. Logs only; the next tick retries.
              // eslint-disable-next-line no-console
              console.warn(
                '[world-postgres readFromStream] poll failed',
                (err as Error)?.message ?? err
              );
            } finally {
              polling = false;
            }
          }, POLL_INTERVAL_MS);
          cleanups.push(() => {
            closed = true;
            clearInterval(pollTimer);
          });
        },
        cancel() {
          cleanups.forEach((fn) => void fn());
        },
      });
    },

    async listStreamsByRunId(runId: string): Promise<string[]> {
      // Query distinct stream IDs associated with the runId
      const results = await drizzle
        .selectDistinct({ streamId: streams.streamId })
        .from(streams)
        .where(eq(streams.runId, runId));

      return results.map((r) => r.streamId);
    },

    async close() {
      const sub = await listenSubscription.catch(() => undefined);
      if (sub) await sub.close();
    },
  };
}
