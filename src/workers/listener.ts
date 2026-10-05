import { Client, type ClientConfig } from "pg";
import type { Logger } from "pino";

/**
 * A LISTEN connection that survives network blips. NOTIFY is only an accelerator: the worker also
 * polls, so a missed notification (or a dead connection) delays an alert by at most one poll
 * interval, never loses it. That is why this file may stay small and simple.
 *
 * It must be a direct connection: LISTEN does not work through a transaction-mode pooler.
 */
export interface Listener {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface ListenerOptions {
  connection: ClientConfig;
  channel: string;
  /** Called for every notification AND after every (re)connect, to catch up on anything missed meanwhile. */
  onWake: () => void;
  logger: Logger;
  /** What the notifications are about, for the log ("new operator alerts"). */
  purpose?: string;
  /** Reconnect backoff bounds. */
  retryMinMs?: number;
  retryMaxMs?: number;
}

export function createListener(options: ListenerOptions): Listener {
  const { connection, channel, onWake, logger } = options;
  const retryMinMs = options.retryMinMs ?? 500;
  const retryMaxMs = options.retryMaxMs ?? 30_000;
  // The channel name is interpolated into SQL (LISTEN cannot be parameterised): it is a constant
  // chosen by this codebase, and this guard keeps it that way.
  if (!/^[a-z_][a-z0-9_]*$/.test(channel)) throw new Error("invalid LISTEN channel name");

  let stopped = false;
  let client: Client | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let retryDelay = retryMinMs;

  function scheduleReconnect() {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void connect();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, retryMaxMs);
  }

  async function connect(): Promise<void> {
    if (stopped) return;
    const next = new Client({ ...connection, keepAlive: true });
    client = next;
    let lost = false;
    const onLost = (error?: Error) => {
      if (lost) return;
      lost = true;
      if (client === next) client = undefined;
      next.removeAllListeners();
      next.on("error", () => undefined); // a late error on a discarded client must not crash the process
      void next.end().catch(() => undefined);
      if (!stopped) {
        logger.warn({ err: error, channel }, "listener connection lost; polling continues, reconnecting");
        scheduleReconnect();
      }
    };
    next.on("error", onLost);
    next.on("end", () => onLost());
    next.on("notification", () => onWake());
    try {
      await next.connect();
      await next.query(`listen ${channel}`);
      retryDelay = retryMinMs;
      logger.info({ channel }, `listening for ${options.purpose ?? "notifications"}`);
      onWake(); // anything enqueued while we were not listening
    } catch (error) {
      onLost(error instanceof Error ? error : new Error(String(error)));
    }
  }

  return {
    async start() {
      await connect();
    },
    async stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      const current = client;
      client = undefined;
      if (current) {
        current.removeAllListeners();
        current.on("error", () => undefined);
        await current.end().catch(() => undefined);
      }
    },
  };
}
