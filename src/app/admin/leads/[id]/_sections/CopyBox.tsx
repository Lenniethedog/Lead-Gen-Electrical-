"use client";

import { useState } from "react";
import { secondaryButton } from "../../../_components/styles";

/** The message to send to a business, with a button that copies it (so it can be pasted into WhatsApp or an email on a phone). */
export function CopyBox({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <label htmlFor="handover-text" className="block font-semibold text-ink">{label}</label>
      <textarea id="handover-text" readOnly value={text} rows={Math.min(18, text.split("\n").length + 1)} className="mt-1 w-full rounded-lg border-2 border-stone-400 bg-stone-50 p-3 font-mono text-base" onFocus={(event) => event.currentTarget.select()} />
      <button
        type="button"
        className={`${secondaryButton} mt-2`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 2500);
          } catch {
            /* clipboard blocked: the text is still selectable above */
          }
        }}
      >
        {copied ? "Copied" : "Copy message"}
      </button>
      <span role="status" className="sr-only">{copied ? "Message copied" : ""}</span>
    </div>
  );
}
