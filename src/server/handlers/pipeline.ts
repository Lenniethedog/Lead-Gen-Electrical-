import type { Logger } from "pino";
import type { Database } from "@/lib/db/client";
import { jsonResponse } from "@/lib/http";
import { getPipelineHealth, type PipelineProblem } from "@/modules/alerts";
import { getBillingHealth, type BillingProblem } from "@/modules/billing";
import { getDeliveryHealth, type DeliveryProblem } from "@/modules/delivery";
import { getRoutingHealth, type RoutingProblem } from "@/modules/routing";

export interface PipelineDeps {
  db: Database;
  logger: Logger;
  /** How long a computed answer is reused. Bounds the database load from a public endpoint. Default 5 s. */
  ttlMs?: number;
  /** Injectable for tests. */
  getHealth?: (db: Database) => Promise<{ ok: boolean; problems: Array<PipelineProblem | RoutingProblem | DeliveryProblem | BillingProblem> }>;
  now?: () => number;
}

type Reported = PipelineProblem | RoutingProblem | DeliveryProblem | BillingProblem | "database";

/** Alerting, routing and delivery are jobs of the same worker: any one failing means leads are not being looked after. Money must also add up. */
async function defaultHealth(db: Database): Promise<{ ok: boolean; problems: Array<PipelineProblem | RoutingProblem | DeliveryProblem | BillingProblem> }> {
  const [alerts, routing, delivery, billing] = await Promise.all([getPipelineHealth(db), getRoutingHealth(db), getDeliveryHealth(db), getBillingHealth(db)]);
  return { ok: alerts.ok && routing.ok && delivery.ok && billing.ok, problems: [...alerts.problems, ...routing.problems, ...delivery.problems, ...billing.problems] };
}

/**
 * GET /api/pipeline: is the worker doing its job right now (alerting every new lead, and routing it when routing is on)? Point an uptime monitor at it
 * (with a keyword check on `"status":"ok"`) so a dead worker, a stuck provider or a broken enqueue
 * path pages a human; /api/ready cannot see any of those, because the web process is fine while the
 * worker is dead.
 *
 * 200 when healthy, 503 when not. The body carries problem CODES only (no ids, no counts of leads),
 * because the endpoint is public. Answers are cached for a few seconds so a monitor, or an abuser,
 * cannot turn it into database load.
 */
export function createPipelineHandler(deps: PipelineDeps): () => Promise<Response> {
  const ttlMs = deps.ttlMs ?? 5_000;
  const now = deps.now ?? Date.now;
  const getHealth = deps.getHealth ?? defaultHealth;
  let cached: { at: number; problems: Reported[] } | undefined;
  let inFlight: Promise<Reported[]> | undefined;

  async function compute(): Promise<Reported[]> {
    try {
      return (await getHealth(deps.db)).problems;
    } catch (error) {
      deps.logger.error({ err: error, check: "pipeline" }, "pipeline health check failed");
      return ["database"];
    }
  }

  return async function handlePipeline(): Promise<Response> {
    if (!cached || now() - cached.at >= ttlMs) {
      // Concurrent callers share one computation instead of each hitting the database.
      inFlight ??= compute().finally(() => {
        inFlight = undefined;
      });
      cached = { at: now(), problems: await inFlight };
    }
    const problems = cached.problems;
    return jsonResponse(
      problems.length === 0 ? { status: "ok" } : { status: "degraded", problems },
      { status: problems.length === 0 ? 200 : 503 },
    );
  };
}
