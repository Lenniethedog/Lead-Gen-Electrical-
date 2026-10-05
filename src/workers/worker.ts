import type { Logger } from "pino";
import type { Database } from "@/lib/db/client";
import { pruneHeartbeats, recordHeartbeat, removeWorkerHeartbeat, type AlertService } from "@/modules/alerts";
import type { DeliveryService } from "@/modules/delivery";
import type { RoutingService } from "@/modules/routing";
import type { Listener } from "./listener";

/**
 * The worker's control loop. Three independent jobs, each with its own drain loop so a slow email provider can never delay routing,
 * and a slow business's webhook can never delay either:
 *   - alerts: email an operator about each new lead,
 *   - routing (stage 4): hand each new lead to a business, when automatic routing is switched on,
 *   - delivery (stage 5): tell each business about its lead (email, text message, webhook), for businesses on automatic delivery.
 * Each job is woken by three triggers feeding ONE drain loop: a LISTEN/NOTIFY wake-up (milliseconds after the change commits),
 * a poll every `pollMs` (the safety net if a notification is missed), and the reconciler tick every `reconcileMs` (which also writes
 * the heartbeat). Everything the loops do is idempotent and safe to repeat; correctness lives in the database (leases, compare-and-set,
 * the routing lock, unique keys), so this file only has to keep the loops turning and never let one failure stop them.
 */
export interface WorkerDeps {
  db: Database;
  alerts: AlertService;
  /** Absent in a worker that only sends alerts (tests); the real entrypoint always provides it. */
  routing?: RoutingService;
  /** Absent in a worker that does not deliver to businesses (tests); the real entrypoint always provides it. */
  delivery?: DeliveryService;
  logger: Logger;
  workerId: string;
  /** Built by the caller so it can call back into `wake()`. */
  createListener: (onWake: () => void) => Listener;
  /** Wakes the routing loop when a lead becomes routable or something routing depends on changes. */
  createRoutingListener?: (onWake: () => void) => Listener;
  /** Wakes the delivery loop when a notification is created or retried. */
  createDeliveryListener?: (onWake: () => void) => Listener;
  pollMs: number;
  reconcileMs: number;
  /** How long stop() waits for in-flight work before returning anyway (the lease / the transaction covers the rest). */
  shutdownGraceMs?: number;
  /** Most leads routed before the loop lets other work run (a burst is drained in several passes). */
  routingBatch?: number;
}

export interface Worker {
  start(): Promise<void>;
  /** Stops taking work, lets in-flight work finish (bounded), and removes the heartbeat. */
  stop(): Promise<void>;
  /** Ask for an alert drain as soon as possible (what a NOTIFY does). */
  wake(): void;
  /** Ask for a routing pass as soon as possible. */
  wakeRouting(): void;
  /** Ask for a delivery pass as soon as possible. */
  wakeDelivery(): void;
}

interface Loop {
  wake(): void;
  inFlight(): Promise<void> | undefined;
}

export function createWorker(deps: WorkerDeps): Worker {
  const { db, alerts, routing, delivery, logger, workerId } = deps;
  const shutdownGraceMs = deps.shutdownGraceMs ?? 20_000;
  const routingBatch = deps.routingBatch ?? 50;

  let stopping = false;
  let pollTimer: NodeJS.Timeout | undefined;
  let reconcileTimer: NodeJS.Timeout | undefined;
  let lastPrune = 0;
  /** The reconcile pass that is running now, if any: stop() waits for it so its heartbeat cannot be written after the heartbeat is removed. */
  let reconciling: Promise<void> | undefined;
  let listener: Listener | undefined;
  let routingListener: Listener | undefined;
  let deliveryListener: Listener | undefined;

  /**
   * One drain loop: `step` does a unit of work and says whether there may be more. A wake-up that arrives mid-drain makes it go round
   * once more instead of being dropped; a failure is logged and the next wake-up or poll tries again (nothing is lost meanwhile).
   */
  function createLoop(name: string, step: () => Promise<boolean>): Loop {
    let draining: Promise<void> | undefined;
    let again = false;
    async function drainOnce(): Promise<void> {
      try {
        for (;;) {
          const more = await step();
          if (!more || stopping) break;
        }
      } catch (error) {
        logger.error({ err: error }, `${name} drain failed; will retry on the next wake-up or poll`);
      }
    }
    return {
      wake() {
        if (stopping) return;
        if (draining) {
          again = true;
          return;
        }
        draining = (async () => {
          do {
            again = false;
            await drainOnce();
          } while (again && !stopping);
        })().finally(() => {
          draining = undefined;
        });
      },
      inFlight: () => draining,
    };
  }

  const alertLoop = createLoop("alert", async () => (await alerts.processDue()).claimed > 0);
  const routingLoop = routing
    ? createLoop("routing", async () => {
        const tally = await routing.drain({ max: routingBatch });
        // A failing lead is parked by the router; stop the pass rather than spin, and let the next poll look again.
        return tally.errors === 0 && tally.routed >= routingBatch;
      })
    : undefined;

  const deliveryLoop = delivery ? createLoop("delivery", async () => (await delivery.pump()) > 0) : undefined;

  const wake = () => alertLoop.wake();
  const wakeRouting = () => routingLoop?.wake();
  const wakeDelivery = () => deliveryLoop?.wake();
  const wakeAll = () => {
    alertLoop.wake();
    routingLoop?.wake();
    deliveryLoop?.wake();
  };

  function reconcileTick(): Promise<void> {
    if (stopping) return Promise.resolve();
    const run = reconcilePass().finally(() => {
      if (reconciling === run) reconciling = undefined;
    });
    reconciling = run;
    return run;
  }

  async function reconcilePass(): Promise<void> {
    try {
      await alerts.reconcile();
      await delivery?.reconcile();
      if (stopping) return; // shutting down: the heartbeat is being removed, do not write it back
      await recordHeartbeat(db, { workerId, reconciled: true });
      if (Date.now() - lastPrune > 3_600_000) {
        lastPrune = Date.now();
        await pruneHeartbeats(db);
      }
    } catch (error) {
      logger.error({ err: error }, "reconcile tick failed; will retry");
    }
    wakeAll(); // anything the reconciler requeued or created is now due, and routing gets a look even if no notification arrived
  }

  return {
    wake,
    wakeRouting,
    wakeDelivery,
    async start() {
      await recordHeartbeat(db, { workerId, reconciled: false });
      listener = deps.createListener(wake);
      await listener.start();
      if (routingLoop && deps.createRoutingListener) {
        routingListener = deps.createRoutingListener(wakeRouting);
        await routingListener.start();
      }
      if (deliveryLoop && deps.createDeliveryListener) {
        deliveryListener = deps.createDeliveryListener(wakeDelivery);
        await deliveryListener.start();
      }
      pollTimer = setInterval(wakeAll, deps.pollMs);
      reconcileTimer = setInterval(() => void reconcileTick(), deps.reconcileMs);
      logger.info({ workerId, pollMs: deps.pollMs, reconcileMs: deps.reconcileMs, routing: routingLoop !== undefined, delivery: deliveryLoop !== undefined }, "worker started");
      await reconcileTick(); // do not wait a full interval to look for backlog after a (re)start
    },
    async stop() {
      stopping = true;
      if (pollTimer) clearInterval(pollTimer);
      if (reconcileTimer) clearInterval(reconcileTimer);
      await listener?.stop();
      await routingListener?.stop();
      await deliveryListener?.stop();
      const inFlight = [alertLoop.inFlight(), routingLoop?.inFlight(), deliveryLoop?.inFlight(), delivery?.settled(), reconciling].filter((promise): promise is Promise<void> => promise !== undefined);
      if (inFlight.length > 0) {
        const finished = await Promise.race([
          Promise.all(inFlight).then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), shutdownGraceMs)),
        ]);
        if (!finished) logger.warn({ shutdownGraceMs }, "stopped with work still in flight; alert leases will expire and the reconciler will retry them, and a routing transaction that never commits changes nothing");
      }
      await removeWorkerHeartbeat(db, workerId).catch(() => undefined);
      logger.info({ workerId }, "worker stopped");
    },
  };
}
