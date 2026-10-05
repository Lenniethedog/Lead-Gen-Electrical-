"use client";

import { useActionState } from "react";
import { dangerButton, hintClass, secondaryButton } from "../../_components/styles";
import { rotateSecretAction } from "../actions";
import type { SecretState } from "./secret-state";

/** Generates a webhook signing secret and shows it ONCE. It is stored encrypted and nothing can read it back: copy it now, or generate a new one. */
export function WebhookSecret({ clientId, hint, available }: { clientId: string; hint: string | null; available: boolean }) {
  const [state, action, pending] = useActionState<SecretState, FormData>(rotateSecretAction, {});

  if (!available) {
    return <p className={hintClass}>Webhooks need the delivery encryption key (DELIVERY_SECRETS_KEY) to be set on the server before a signing secret can be created.</p>;
  }
  return (
    <div className="space-y-2">
      <form action={action}>
        <input type="hidden" name="clientId" value={clientId} />
        <button type="submit" disabled={pending} className={hint ? dangerButton : secondaryButton}>
          {hint ? "Generate a new secret (the old one stops working)" : "Generate a signing secret"}
        </button>
      </form>
      {hint && !state.secret && <p className={hintClass}>A secret is set (ending {hint}). It cannot be shown again.</p>}
      {state.error && <p role="alert" className="font-semibold text-error">Could not create a secret ({state.error}).</p>}
      {state.secret && (
        <div role="status" className="rounded-lg border-2 border-amber-400 bg-amber-50 p-3">
          <p className="font-semibold text-ink">Copy this now and give it to the business. It will not be shown again.</p>
          <input readOnly aria-label="New webhook signing secret" value={state.secret} onFocus={(event) => event.currentTarget.select()} className="mt-2 w-full rounded border-2 border-stone-400 bg-white px-3 py-2 font-mono text-sm" />
          <p className={`mt-2 ${hintClass}`}>They check each delivery with it: the header <code>X-Leadgen-Signature</code> is <code>sha256=</code> and the HMAC-SHA256 of <code>timestamp.body</code>, and they should reject a timestamp more than five minutes old.</p>
        </div>
      )}
    </div>
  );
}
