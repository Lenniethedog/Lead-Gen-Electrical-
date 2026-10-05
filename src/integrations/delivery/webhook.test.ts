import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "@/lib/secrets";
import { createWebhookSender } from "./webhook";

interface Received { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve)))));
});

async function receiver(handle: (request: http.IncomingMessage, response: http.ServerResponse, received: Received) => void) {
  const seen: Received[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const received = { method: request.method!, url: request.url!, headers: request.headers, body: Buffer.concat(chunks).toString() };
      seen.push(received);
      handle(request, response, received);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { seen, port: (server.address() as AddressInfo).port };
}

const message = (url: string) => ({ url, secret: "whsec_unit_test", body: JSON.stringify({ lead: "L-1" }), deliveryId: "n-1", event: "lead.assigned" });
const ctx = () => ({ signal: AbortSignal.timeout(5_000) });
const loose = () => createWebhookSender({ allowLoopbackForTests: true });

describe("a successful delivery", () => {
  it("posts the body with a signature the receiver can verify with only the secret, and the delivery id to de-duplicate on", async () => {
    const { seen, port } = await receiver((_, response) => response.writeHead(200).end("ok"));
    expect(await loose().send(message(`http://127.0.0.1:${port}/hook?x=1`), ctx())).toEqual({ outcome: "accepted" });
    const [call] = seen;
    expect(call).toMatchObject({ method: "POST", url: "/hook?x=1", body: '{"lead":"L-1"}' });
    expect(call!.headers).toMatchObject({ "content-type": "application/json", "x-leadgen-event": "lead.assigned", "x-leadgen-delivery": "n-1" });
    const timestamp = Number(call!.headers["x-leadgen-timestamp"]);
    expect(Math.abs(timestamp - Date.now() / 1000)).toBeLessThan(5);
    expect(verifyWebhookSignature("whsec_unit_test", timestamp, call!.body, String(call!.headers["x-leadgen-signature"]))).toBe(true);
    expect(verifyWebhookSignature("another_secret", timestamp, call!.body, String(call!.headers["x-leadgen-signature"]))).toBe(false);
  });
});

describe("how the receiver's answer is judged", () => {
  const answer = async (status: number) => {
    const { port } = await receiver((_, response) => response.writeHead(status).end("x"));
    return loose().send(message(`http://127.0.0.1:${port}/`), ctx());
  };
  it("2xx is accepted; 408, 429 and 5xx are retried; other 4xx are permanent", async () => {
    expect(await answer(204)).toEqual({ outcome: "accepted" });
    for (const status of [408, 429, 500, 502, 503]) expect(await answer(status), String(status)).toMatchObject({ outcome: "retryable_failure", httpStatus: status });
    for (const status of [400, 401, 403, 404, 410, 422]) expect(await answer(status), String(status)).toMatchObject({ outcome: "permanent_failure", httpStatus: status });
  });
  it("never follows a redirect: a 3xx is permanent and the second URL is never requested", async () => {
    const target = await receiver((_, response) => response.writeHead(200).end());
    const { port } = await receiver((_, response) => response.writeHead(302, { location: `http://127.0.0.1:${target.port}/internal` }).end());
    expect(await loose().send(message(`http://127.0.0.1:${port}/`), ctx())).toMatchObject({ outcome: "permanent_failure", errorCode: "redirect_not_followed", httpStatus: 302 });
    expect(target.seen).toHaveLength(0);
  });
  it("reads only a capped amount of a huge response, and still judges it by its status", async () => {
    const { port } = await receiver((_, response) => {
      response.writeHead(200);
      const big = Buffer.alloc(1_000_000, 65);
      response.write(big);
      response.end(big);
    });
    expect(await loose().send(message(`http://127.0.0.1:${port}/`), ctx())).toEqual({ outcome: "accepted" });
  });
  it("a receiver that never answers is abandoned at the timeout, as retryable", async () => {
    const { port } = await receiver(() => undefined);
    const result = await loose().send(message(`http://127.0.0.1:${port}/`), { signal: AbortSignal.timeout(300) });
    expect(result).toEqual({ outcome: "retryable_failure", errorCode: "timeout" });
  });
  it("a refused connection is retryable, not permanent", async () => {
    const { port } = await receiver((_, response) => response.end());
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve)))));
    expect(await loose().send(message(`http://127.0.0.1:${port}/`), ctx())).toEqual({ outcome: "retryable_failure", errorCode: "network_error" });
  });
});

describe("the destination is defended, with the test-only exemption OFF (as in production)", () => {
  const strict = (addresses: string[], onResolve?: () => void) => createWebhookSender({ resolve: async () => { onResolve?.(); return addresses; } });

  it("refuses plain http, URLs with credentials and malformed URLs, permanently, without any network call", async () => {
    const sender = strict(["93.184.216.34"]);
    expect(await sender.send(message("http://example.com/hook"), ctx())).toEqual({ outcome: "permanent_failure", errorCode: "https_required" });
    expect(await sender.send(message("https://user:pass@example.com/hook"), ctx())).toEqual({ outcome: "permanent_failure", errorCode: "credentials_in_url" });
    expect(await sender.send(message("not a url"), ctx())).toEqual({ outcome: "permanent_failure", errorCode: "invalid_url" });
    expect(await sender.send(message("ftp://example.com/"), ctx())).toEqual({ outcome: "permanent_failure", errorCode: "https_required" });
  });
  it("refuses a name that resolves to ANY private address, even alongside a public one", async () => {
    for (const addresses of [["10.0.0.5"], ["127.0.0.1"], ["169.254.169.254"], ["93.184.216.34", "10.0.0.5"], ["::1"], ["::ffff:192.168.1.1"], ["fd00::1"]]) {
      expect(await strict(addresses).send(message("https://hook.example.com/x"), ctx()), addresses.join()).toEqual({ outcome: "permanent_failure", errorCode: "destination_not_public" });
    }
  });
  it("refuses literal private addresses in the URL, including loopback and metadata, v4 and v6", async () => {
    const never = strict(["93.184.216.34"], () => { throw new Error("must not resolve"); });
    for (const url of ["https://127.0.0.1/x", "https://169.254.169.254/latest/meta-data/", "https://10.1.2.3:8443/x", "https://[::1]/x", "https://[fe80::1]/x", "https://[::ffff:7f00:1]/x"]) {
      expect(await never.send(message(url), ctx()), url).toEqual({ outcome: "permanent_failure", errorCode: "destination_not_public" });
    }
  });
  it("a name that does not resolve is retryable (DNS may come back), not permanent", async () => {
    const sender = createWebhookSender({ resolve: async () => { throw new Error("ENOTFOUND"); } });
    expect(await sender.send(message("https://nowhere.example/x"), ctx())).toEqual({ outcome: "retryable_failure", errorCode: "dns_error" });
    expect(await createWebhookSender({ resolve: async () => [] }).send(message("https://nowhere.example/x"), ctx())).toEqual({ outcome: "retryable_failure", errorCode: "dns_error" });
  });
  it("resolves ONCE and connects to the address it checked, sending the original host name (no second lookup to rebind)", async () => {
    const { seen, port } = await receiver((_, response) => response.writeHead(200).end());
    let lookups = 0;
    const sender = createWebhookSender({ allowLoopbackForTests: true, resolve: async () => { lookups += 1; return lookups === 1 ? ["127.0.0.1"] : ["10.0.0.1"]; } });
    expect(await sender.send(message(`http://receiver.example:${port}/hook`), ctx())).toEqual({ outcome: "accepted" });
    expect(lookups).toBe(1);
    expect(seen[0]!.headers.host).toBe(`receiver.example:${port}`);
  });
});
