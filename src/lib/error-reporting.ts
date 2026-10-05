import type { ErrorEvent } from "@sentry/node";
import { setLogErrorSink } from "./logger";

/**
 * Error reporting (Sentry), configured so that personal data cannot reach a third party.
 *
 * Defence in depth, because a consumer's phone number in a vendor's dashboard is a data breach:
 *   1. The SDK is told to collect NOTHING beyond the error itself (`dataCollection` all off; v11's
 *      defaults would collect bodies, cookies, headers and local variables).
 *   2. No automatic instrumentation or breadcrumbs: only errors we explicitly report are sent.
 *   3. `scrubEvent` runs on every event and removes request/user/breadcrumb/extra data, then masks
 *      anything shaped like an email address, UK phone number or postcode inside the text that remains.
 *   4. What we report from logs is a whitelisted set of ids and codes (see src/lib/logger.ts).
 *
 * Disabled (a no-op) when SENTRY_DSN is unset; the SDK is only loaded when it is set.
 * NOT verified against a live Sentry project (no DSN was available): the event content is verified
 * with a capturing transport (src/lib/error-reporting.test.ts).
 */
export interface ReportContext {
  tags?: Record<string, string>;
}

export interface ErrorReporter {
  readonly enabled: boolean;
  captureException(error: unknown, context?: ReportContext): void;
  captureMessage(message: string, context?: ReportContext): void;
  flush(timeoutMs?: number): Promise<boolean>;
}

const NOOP: ErrorReporter = {
  enabled: false,
  captureException() {},
  captureMessage() {},
  async flush() {
    return true;
  },
};

let current: ErrorReporter = NOOP;

export function getErrorReporter(): ErrorReporter {
  return current;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// UK numbers in the common written forms: +44 7xxx xxxxxx, 07xxx xxxxxx, 020 xxxx xxxx, 01xxx xxxxxx
const PHONE = /(?:\+44\s?\(?0?\)?|\b0)\s?\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g;
const POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/gi;

/** Masks anything that looks like personal data. A seat belt: the real protection is not sending it. */
export function scrubText(text: string): string {
  return text.replace(EMAIL, "[email]").replace(PHONE, "[phone]").replace(POSTCODE, "[postcode]");
}

/** Applied to every outgoing event. Exported for tests. */
export function scrubEvent<T extends ErrorEvent>(event: T): T {
  delete event.request;
  delete event.user;
  delete event.breadcrumbs;
  delete event.extra;
  if (typeof event.message === "string") event.message = scrubText(event.message);
  for (const exception of event.exception?.values ?? []) {
    if (typeof exception.value === "string") exception.value = scrubText(exception.value);
    for (const frame of exception.stacktrace?.frames ?? []) delete frame.vars;
  }
  if (event.tags) {
    for (const [key, value] of Object.entries(event.tags)) {
      if (typeof value === "string") event.tags[key] = scrubText(value);
    }
  }
  return event;
}

export interface InitErrorReportingOptions {
  dsn: string | undefined;
  environment: string;
  /** "leadgen-web" or "leadgen-worker". */
  service: string;
  release?: string | undefined;
  /** Tests only: capture envelopes instead of sending them. */
  transport?: (request: { body: string | Uint8Array }) => Promise<void>;
}

export async function initErrorReporting(options: InitErrorReportingOptions): Promise<ErrorReporter> {
  if (!options.dsn) {
    current = NOOP;
    setLogErrorSink(undefined);
    return current;
  }
  const Sentry = await import("@sentry/node");

  Sentry.init({
    dsn: options.dsn,
    environment: options.environment,
    ...(options.release && { release: options.release }),
    // Only our own explicit captures: no auto-instrumentation, no console/http/pg breadcrumbs.
    defaultIntegrations: false,
    integrations: [Sentry.linkedErrorsIntegration(), Sentry.dedupeIntegration(), Sentry.eventFiltersIntegration()],
    enableOpenTelemetrySetup: false,
    tracesSampleRate: 0,
    maxBreadcrumbs: 0,
    sendClientReports: false,
    includeServerName: false,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    beforeBreadcrumb: () => null,
    beforeSend: (event: ErrorEvent) => scrubEvent(event),
    ...(options.transport && {
      transport: (transportOptions: Parameters<typeof Sentry.createTransport>[0]) =>
        Sentry.createTransport(transportOptions, async (request) => {
          await options.transport!(request);
          return { statusCode: 200 };
        }),
    }),
  });
  Sentry.setTag("service", options.service);

  const withTags = (context?: ReportContext) => ({ tags: context?.tags ?? {} });
  current = {
    enabled: true,
    captureException: (error, context) => void Sentry.captureException(error, withTags(context)),
    captureMessage: (message, context) => void Sentry.captureMessage(scrubText(message), { level: "error", ...withTags(context) }),
    flush: (timeoutMs = 2_000) => Sentry.flush(timeoutMs),
  };

  // Every logger.error(...) in the codebase now also reaches Sentry, with only whitelisted tags.
  setLogErrorSink(({ message, error, tags }) => {
    if (error) current.captureException(error, { tags: { ...tags, log_message: scrubText(message).slice(0, 200) } });
    else current.captureMessage(message, { tags });
  });
  return current;
}
