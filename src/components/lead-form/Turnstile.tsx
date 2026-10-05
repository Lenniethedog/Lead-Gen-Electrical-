"use client";

import { useEffect, useRef } from "react";

/**
 * Cloudflare Turnstile wrapper. Reports one of three states through `onState`:
 *   { token }         challenge solved
 *   { token: null }   not solved (yet, or the token expired)
 *   { failed: true }  the script/widget could not run (blocker, network): the form degrades
 *                     gracefully instead of blocking a real customer; the server holds such
 *                     leads for review rather than discarding them (see modules/fraud/challenge.ts)
 */
export type TurnstileState = { token: string } | { token: null } | { failed: true };

interface TurnstileApi {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let scriptPromise: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptPromise ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile missing")));
    script.onerror = () => {
      scriptPromise = null; // allow a later retry
      reject(new Error("turnstile script blocked or offline"));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

interface TurnstileProps {
  siteKey: string;
  onState: (state: TurnstileState) => void;
}

export function Turnstile({ siteKey, onState }: TurnstileProps) {
  const container = useRef<HTMLDivElement>(null);
  const onStateRef = useRef(onState);

  useEffect(() => {
    onStateRef.current = onState;
  });

  useEffect(() => {
    let widgetId: string | undefined;
    let cancelled = false;
    // If nothing happens in 10s (blocked silently, captive portal) stop making the user wait.
    const patience = setTimeout(() => {
      if (!cancelled) onStateRef.current({ failed: true });
    }, 10_000);

    loadTurnstile()
      .then((turnstile) => {
        if (cancelled || !container.current) return;
        widgetId = turnstile.render(container.current, {
          sitekey: siteKey,
          // Invisible unless Cloudflare decides it needs the visitor to interact.
          appearance: "interaction-only",
          theme: "light",
          callback: (token: string) => {
            clearTimeout(patience);
            onStateRef.current({ token });
          },
          "expired-callback": () => onStateRef.current({ token: null }),
          "timeout-callback": () => onStateRef.current({ token: null }),
          "error-callback": () => {
            clearTimeout(patience);
            onStateRef.current({ failed: true });
          },
        });
      })
      .catch(() => {
        clearTimeout(patience);
        if (!cancelled) onStateRef.current({ failed: true });
      });

    return () => {
      cancelled = true;
      clearTimeout(patience);
      if (widgetId) window.turnstile?.remove(widgetId);
    };
  }, [siteKey]);

  return <div ref={container} className="empty:hidden" />;
}
