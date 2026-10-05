import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local stand-in for Resend's POST /emails, for tests of the real HTTP adapter and of the worker
 * process. It models the one provider behaviour the design leans on: a repeated Idempotency-Key
 * returns the ORIGINAL result and sends nothing new, so `delivered` counts distinct emails.
 *
 * Script failures with `queue(...)`: each scripted step answers one request, in order; once the
 * script is empty it answers 200. `delayMs` holds the response (to test timeouts and worker kills).
 */
export interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  idempotencyKey: string | undefined;
  body: { from?: string; to?: string[]; subject?: string; text?: string };
}

export interface Step {
  status: number;
  body?: unknown;
  delayMs?: number;
  /** Accept the TCP connection but never answer: exercises the client's own timeout. */
  hang?: boolean;
  /** Record the email as delivered even though the response is a failure (the "accepted, then the answer was lost" case). */
  deliverAnyway?: boolean;
  /** Deliver the email IMMEDIATELY, then hold the response for `delayMs`: the client dies while the provider already accepted. */
  deliverEarly?: boolean;
}

export interface FakeResend {
  url: string;
  requests: RecordedRequest[];
  /** Distinct emails the provider would actually have sent (one per idempotency key). */
  delivered: RecordedRequest[];
  queue(...steps: Step[]): void;
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startFakeResend(options: { latencyMs?: number } = {}): Promise<FakeResend> {
  const requests: RecordedRequest[] = [];
  const delivered: RecordedRequest[] = [];
  const seen = new Map<string, string>();
  const payloadByKey = new Map<string, string>();
  const script: Step[] = [];
  const sockets = new Set<import("node:net").Socket>();
  let counter = 0;

  const server: Server = createServer(async (request, response) => {
    const raw = await readBody(request);
    let body: RecordedRequest["body"] = {};
    try {
      body = JSON.parse(raw) as RecordedRequest["body"];
    } catch {
      /* leave empty: a malformed body is recorded as such */
    }
    const key = request.headers["idempotency-key"];
    const recorded: RecordedRequest = {
      method: request.method ?? "",
      path: request.url ?? "",
      authorization: request.headers.authorization,
      idempotencyKey: typeof key === "string" ? key : undefined,
      body,
    };
    requests.push(recorded);

    const step = script.shift();
    if (step?.hang) return; // never answer

    const respond = (status: number, payload: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };

    const deliver = () => {
      const id = recorded.idempotencyKey ? seen.get(recorded.idempotencyKey) : undefined;
      if (id) return id; // repeat of an already delivered email (identical payload): same answer, nothing sent
      counter += 1;
      const fresh = `email_${counter}`;
      if (recorded.idempotencyKey) seen.set(recorded.idempotencyKey, fresh);
      delivered.push(recorded);
      return fresh;
    };

    // Resend's documented rule: the same key with a DIFFERENT payload is 409 invalid_idempotent_request.
    const payload = JSON.stringify(recorded.body);
    if (recorded.idempotencyKey && payloadByKey.has(recorded.idempotencyKey) && payloadByKey.get(recorded.idempotencyKey) !== payload) {
      response.writeHead(409, { "content-type": "application/json" });
      return void response.end(
        JSON.stringify({ statusCode: 409, name: "invalid_idempotent_request", message: "this idempotency key has already been used on a request that had a different payload" }),
      );
    }
    if (recorded.idempotencyKey && !payloadByKey.has(recorded.idempotencyKey)) payloadByKey.set(recorded.idempotencyKey, payload);

    const early = step?.deliverEarly ? deliver() : undefined;
    const delay = step?.delayMs ?? options.latencyMs ?? 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

    if (step && step.status >= 400) {
      if (step.deliverAnyway) deliver();
      return respond(step.status, step.body ?? { statusCode: step.status, name: "scripted_failure", message: "scripted" });
    }
    respond(step?.status ?? 200, step?.body ?? { id: early ?? deliver() });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    delivered,
    queue: (...steps) => void script.push(...steps),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
