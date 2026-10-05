import type { EmailMessage, EmailSender } from "@/modules/alerts/ports";

/**
 * Development/test sender: prints the message instead of sending it, so the whole pipeline can be
 * exercised on a laptop with no account. Never wired in staging or production (the environment
 * validation and the factory both refuse it): a deployed system that "sends" to a terminal is
 * indistinguishable from a working one until the first missed lead.
 */
export function createConsoleSender(write: (text: string) => void = (text) => console.log(text)): EmailSender {
  return {
    async send(message: EmailMessage) {
      write(`[email:console] to=${message.to.join(",")}\nsubject: ${message.subject}\n\n${message.text}`);
      return { outcome: "accepted", providerMessageId: `console-${message.idempotencyKey}` };
    },
  };
}
