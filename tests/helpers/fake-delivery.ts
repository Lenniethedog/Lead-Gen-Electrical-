import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const close = (server: Server) => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve())));

export interface FakeTwilio {
  url: string;
  /** Each accepted message: the form fields and the Authorization header. */
  messages: Array<{ form: Record<string, string>; authorization: string | undefined; path: string }>;
  /** Answer the next request with this status and JSON body instead of accepting it. */
  failNext(status: number, body: Record<string, unknown>): void;
  close(): Promise<void>;
}

/** A local stand-in for Twilio's POST /2010-04-01/Accounts/{sid}/Messages.json. */
export async function startFakeTwilio(): Promise<FakeTwilio> {
  const messages: FakeTwilio["messages"] = [];
  const failures: Array<{ status: number; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const form = Object.fromEntries(new URLSearchParams(await readBody(request)));
    const failure = failures.shift();
    if (failure) return void response.writeHead(failure.status, { "content-type": "application/json" }).end(JSON.stringify(failure.body));
    messages.push({ form, authorization: request.headers.authorization, path: request.url ?? "" });
    response.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ sid: `SM${String(messages.length).padStart(32, "a")}` }));
  });
  const url = await listen(server);
  return { url, messages, failNext: (status, body) => void failures.push({ status, body }), close: () => close(server) };
}

export interface WebhookReceiver {
  url: string;
  requests: Array<{ headers: IncomingMessage["headers"]; body: string; path: string }>;
  /** Hold the answer to the next request for this long (a slow or hung receiver). */
  holdNext(ms: number): void;
  /** Answer the next request with this status. */
  answerNext(status: number): void;
  close(): Promise<void>;
}

/** A business's webhook endpoint. */
export async function startWebhookReceiver(): Promise<WebhookReceiver> {
  const requests: WebhookReceiver["requests"] = [];
  const holds: number[] = [];
  const answers: number[] = [];
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    requests.push({ headers: request.headers, body, path: request.url ?? "" });
    const hold = holds.shift();
    if (hold) await new Promise((resolve) => setTimeout(resolve, hold));
    if (!response.writableEnded) response.writeHead(answers.shift() ?? 200).end("ok");
  });
  const url = await listen(server);
  return { url: `${url}/hook`, requests, holdNext: (ms) => void holds.push(ms), answerNext: (status) => void answers.push(status), close: () => close(server) };
}
