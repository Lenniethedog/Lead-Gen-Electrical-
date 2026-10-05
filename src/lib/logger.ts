import pino, { type Logger } from "pino";

/**
 * Structured JSON logging (one line per event, to stdout; the platform ships it).
 *
 * The ONLY real protection against leaking personal data in logs is not logging it: log ids,
 * codes and counts, never request bodies. The redaction list below is a seat belt for mistakes.
 * For readable local output: `npm run dev:pretty`.
 */
const REDACT_PATHS = [
  "phone", "email", "name", "fullName", "notes", "ip", "postcode", "password", "token", "secret",
  "turnstileToken", "authorization", "cookie",
  "*.phone", "*.email", "*.name", "*.fullName", "*.notes", "*.ip", "*.postcode", "*.password",
  "*.token", "*.secret", "*.turnstileToken", "*.authorization", "*.cookie",
  "req.headers.authorization", "req.headers.cookie",
];

const LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

/** What an error-level log line looks like to an error reporter: the message, the error, and safe tags only. */
export interface LoggedError {
  message: string;
  error?: Error;
  /** Only these identifying fields are ever forwarded; everything else in the log record stays in the log. */
  tags: Record<string, string>;
}

type LogErrorSink = (entry: LoggedError) => void;
let logErrorSink: LogErrorSink | undefined;

/** Registers where error-level log lines are also sent (e.g. Sentry). Pass undefined to detach. */
export function setLogErrorSink(sink: LogErrorSink | undefined): void {
  logErrorSink = sink;
}

const FORWARDED_FIELDS = ["alertId", "leadId", "kind", "errorCode", "check", "attemptNo", "httpStatus", "workerId"] as const;

function toLoggedError(args: unknown[]): LoggedError {
  const first = args[0];
  const record = first !== null && typeof first === "object" ? (first as Record<string, unknown>) : undefined;
  const message = typeof first === "string" ? first : typeof args[1] === "string" ? args[1] : "error logged";
  const tags: Record<string, string> = {};
  for (const field of FORWARDED_FIELDS) {
    const value = record?.[field];
    if (typeof value === "string" || typeof value === "number") tags[field] = String(value).slice(0, 100);
  }
  const error = record?.err instanceof Error ? record.err : undefined;
  return { message, ...(error && { error }), tags };
}

export function createLogger(
  options: { level?: string; destination?: pino.DestinationStream; service?: string } = {},
): Logger {
  const level = options.level && LEVELS.has(options.level) ? options.level : "info";
  return pino(
    {
      level,
      base: { service: options.service ?? "leadgen-web" },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: REDACT_PATHS, censor: "[redacted]" },
      hooks: {
        // Error-level lines also reach the error reporter, if one is registered. A reporting failure
        // must never break logging, which must never break the request.
        logMethod(args, method, level) {
          if (level >= 50 && logErrorSink) {
            try {
              logErrorSink(toLoggedError(args as unknown[]));
            } catch {
              /* ignore */
            }
          }
          return method.apply(this, args as Parameters<typeof method>);
        },
      },
    },
    options.destination,
  );
}

let rootLogger: Logger | undefined;
let serviceName = "leadgen-web";

/** Names this process in every log line ("leadgen-worker"). Call once, before the first getLogger(). */
export function setLogService(name: string): void {
  serviceName = name;
  rootLogger = undefined;
}

/** Process-wide logger. Create child loggers per request: `getLogger().child({ requestId })`. */
export function getLogger(): Logger {
  return (rootLogger ??= createLogger({ level: process.env.LOG_LEVEL, service: serviceName }));
}
