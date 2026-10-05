import { Writable } from "node:stream";
import pino from "pino";
import type { Database } from "../../src/lib/db/client";
import {
  createAlertService,
  type AlertService,
  type AlertServiceConfig,
  type EmailMessage,
  type EmailSender,
  type SendResult,
} from "../../src/modules/alerts";

export const ALERT_CONFIG: AlertServiceConfig = {
  recipients: ["ops@example.com"],
  brandName: "Test Brand",
  adminBaseUrl: "https://admin.test.example",
  leaseSeconds: 60,
  sendTimeoutMs: 5_000,
  reminderAfterMinutes: 15,
  graceSeconds: 60,
  lookbackHours: 72,
  batchSize: 5,
};

type Step = SendResult | "throw" | ((message: EmailMessage, signal: AbortSignal) => Promise<SendResult>);

const payloadOf = (message: EmailMessage) => JSON.stringify({ to: message.to, subject: message.subject, text: message.text });

/**
 * A scriptable email provider that models Resend's documented idempotency: a repeated key with an IDENTICAL payload
 * returns the original result and sends nothing (`delivered` keeps one entry); the same key with a DIFFERENT payload is
 * answered 409 invalid_idempotent_request ("retrying is useless"). `calls` counts every send attempt, so a test can tell
 * "we called twice" from "the recipient received two emails".
 */
export class ScriptedSender implements EmailSender {
  calls: EmailMessage[] = [];
  delivered = new Map<string, EmailMessage>();
  private payloads = new Map<string, string>();
  private script: Step[] = [];

  /** Queue results for the next sends, in order. After the script is exhausted every send is accepted. */
  queue(...steps: Step[]): this {
    this.script.push(...steps);
    return this;
  }

  /** A step that makes the provider ACCEPT the email and then never answer: the worker is killed while waiting. */
  acceptThenHang(): Step {
    return (message) => {
      this.accept(message);
      return new Promise<never>(() => undefined);
    };
  }

  private accept(message: EmailMessage): SendResult {
    const key = message.idempotencyKey;
    const known = this.payloads.get(key);
    if (known !== undefined) {
      if (known !== payloadOf(message)) return { outcome: "retryable_failure", errorCode: "invalid_idempotent_request", httpStatus: 409 };
      return { outcome: "accepted", providerMessageId: `msg_${[...this.payloads.keys()].indexOf(key) + 1}` };
    }
    this.payloads.set(key, payloadOf(message));
    this.delivered.set(key, message);
    return { outcome: "accepted", providerMessageId: `msg_${this.delivered.size}` };
  }

  async send(message: EmailMessage, { signal }: { signal: AbortSignal }): Promise<SendResult> {
    this.calls.push(message);
    const step = this.script.shift();
    if (step === "throw") throw new Error("provider exploded");
    if (typeof step === "function") return step(message, signal);
    if (step) return step;
    return this.accept(message);
  }
}

/** Collects pino output so tests can assert on what was (and was not) logged. */
export function captureLogger() {
  const lines: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) lines.push(JSON.parse(line) as Record<string, unknown>);
      callback();
    },
  });
  // Same level formatting as the production logger (src/lib/logger.ts): "error", not 50.
  const logger = pino({ level: "debug", formatters: { level: (label) => ({ level: label }) } }, stream);
  return { logger, lines, text: () => lines.map((line) => JSON.stringify(line)).join("\n") };
}

export function buildAlertService(
  db: Database,
  sender: EmailSender,
  options: { config?: Partial<AlertServiceConfig>; random?: () => number; logger?: ReturnType<typeof captureLogger>["logger"] } = {},
): AlertService {
  return createAlertService({
    db,
    sender,
    logger: options.logger ?? pino({ level: "silent" }),
    config: { ...ALERT_CONFIG, ...options.config },
    random: options.random ?? (() => 0.5), // zero jitter: exact, assertable delays
  });
}

/** Runs processDue until the queue is empty (what the worker's drain loop does). */
export async function drain(service: AlertService): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if ((await service.processDue()).claimed === 0) return;
  }
  throw new Error("drain did not converge");
}
