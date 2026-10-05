"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { ConsentSegment } from "@/config/consent";
import { ApiError, submitLead } from "./api";
import { captureAttribution } from "./attribution";
import { Confirmation } from "./Confirmation";
import { describeFailure } from "./failure";
import { buildPayload } from "./payload";
import { clearPersisted, getSessionStorage, loadPersisted, savePersisted } from "./persistence";
import { Progress } from "./Progress";
import {
  firstIncompleteStep,
  initialState,
  LAST_STEP,
  reducer,
  STEPS,
  type FormValues,
} from "./state";
import { PostcodeStep } from "./steps/PostcodeStep";
import { PropertyStep } from "./steps/PropertyStep";
import { ScopeStep } from "./steps/ScopeStep";
import { ServiceStep } from "./steps/ServiceStep";
import type { ContactSubmission } from "./steps/ContactStep";
import { UrgencyStep } from "./steps/UrgencyStep";
import { uuidv4 } from "./uuid";

// The contact step carries the phone-number metadata (large). It is loaded on demand, and
// prefetched below as soon as the visitor gets close, so the landing page itself stays light.
const loadContactStep = () => import("./steps/ContactStep").then((module) => module.ContactStep);
const ContactStep = dynamic(loadContactStep, {
  loading: () => <p className="py-10 text-center text-muted">Loading…</p>,
});

export interface LeadFormProps {
  brandName: string;
  privacyEmail: string;
  launchRegion: string;
  turnstileSiteKey: string;
  consent: { version: string; segments: readonly ConsentSegment[] };
}

/** Pause after a tile is chosen so the selection is visible before the next question appears. */
const ADVANCE_DELAY_MS = 200;

export function LeadForm({ brandName, privacyEmail, launchRegion, turnstileSiteKey, consent }: LeadFormProps) {
  // A placeholder key/time until the mount effect runs: generating them during render would differ
  // between the server-rendered HTML and the browser.
  const [state, dispatch] = useReducer(reducer, undefined, () => initialState("", 0));
  const [challengeEpoch, setChallengeEpoch] = useState(0);
  const [needsReload, setNeedsReload] = useState(false);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousStep = useRef(0);
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Synchronous guard: React state updates are async, a double tap can fire twice before it flips. */
  const submitLock = useRef(false);
  // "restore" and "reset" both install a real key, so a non-empty key means the browser-side setup ran.
  const hydrated = state.idempotencyKey !== "";

  // Restore progress (or start fresh) once, in the browser.
  useEffect(() => {
    const saved = loadPersisted(getSessionStorage(), Date.now());
    if (saved) {
      previousStep.current = saved.step; // restoring must not steal focus
      dispatch({ type: "restore", ...saved });
    } else {
      dispatch({ type: "reset", idempotencyKey: uuidv4(), now: Date.now() });
    }
  }, []);

  // Save progress (debounced); finishing clears it so personal data does not linger in the tab.
  useEffect(() => {
    if (!hydrated) return;
    const storage = getSessionStorage();
    if (state.status === "done") {
      clearPersisted(storage);
      return;
    }
    const timer = setTimeout(
      () =>
        savePersisted(
          storage,
          { step: state.step, values: state.values, idempotencyKey: state.idempotencyKey, startedAt: state.startedAt },
          Date.now(),
        ),
      250,
    );
    return () => clearTimeout(timer);
  }, [hydrated, state.step, state.values, state.idempotencyKey, state.startedAt, state.status]);

  // Move focus to the new question's heading when the step changes.
  useEffect(() => {
    if (previousStep.current !== state.step) {
      previousStep.current = state.step;
      headingRef.current?.focus();
    }
  }, [state.step]);

  // Warm the contact chunk before it is needed.
  useEffect(() => {
    if (state.step >= 2) void loadContactStep();
  }, [state.step]);

  useEffect(() => () => clearTimeout(advanceTimer.current), []);

  const patch = useCallback((values: Partial<FormValues>) => dispatch({ type: "patch", patch: values }), []);

  const chooseAndAdvance = useCallback((values: Partial<FormValues>) => {
    dispatch({ type: "patch", patch: values });
    clearTimeout(advanceTimer.current);
    advanceTimer.current = setTimeout(() => dispatch({ type: "next" }), ADVANCE_DELAY_MS);
  }, []);

  const goNext = useCallback(() => {
    clearTimeout(advanceTimer.current);
    dispatch({ type: "next" });
  }, []);

  const goBack = useCallback(() => {
    clearTimeout(advanceTimer.current);
    dispatch({ type: "back" });
  }, []);

  async function submit({ turnstileToken, honeypot }: ContactSubmission) {
    if (submitLock.current || state.status === "submitting") return;

    const gap = firstIncompleteStep(state.values);
    if (gap !== null) {
      dispatch({ type: "goto", step: gap });
      return;
    }

    submitLock.current = true;
    dispatch({ type: "submit_started" });
    try {
      let key = state.idempotencyKey;
      for (let attempt = 0; ; attempt += 1) {
        try {
          const payload = buildPayload(state.values, {
            turnstileToken,
            honeypot,
            consentVersion: consent.version,
            elapsedMs: Date.now() - state.startedAt,
            pagePath: window.location.pathname,
            attribution: captureAttribution(window.location, document.referrer),
          });
          const { reference } = await submitLead(payload, key);
          dispatch({ type: "submit_succeeded", reference });
          return;
        } catch (error) {
          // The key was already used for DIFFERENT content (e.g. the visitor edited an answer after an
          // attempt that actually reached the server). The old submission is, by definition, not what
          // they are sending now, so send this one under a fresh key. The server's duplicate
          // detection still protects against it becoming a second live lead.
          if (error instanceof ApiError && error.code === "idempotency_key_reuse" && attempt === 0) {
            key = uuidv4();
            dispatch({ type: "rekey", idempotencyKey: key });
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      const failure = describeFailure(error);
      if (failure.resetChallenge) setChallengeEpoch((epoch) => epoch + 1);
      setNeedsReload(failure.needsReload);
      dispatch({
        type: "submit_failed",
        formError: failure.formError,
        fieldErrors: failure.fieldErrors,
        goToStep: failure.goToStep,
      });
    } finally {
      submitLock.current = false;
    }
  }

  if (state.status === "done" && state.reference !== null) {
    return (
      <Confirmation
        reference={state.reference}
        brandName={brandName}
        privacyEmail={privacyEmail}
        onStartAnother={() => {
          setChallengeEpoch((epoch) => epoch + 1);
          dispatch({ type: "reset", idempotencyKey: uuidv4(), now: Date.now() });
        }}
      />
    );
  }

  const common = {
    values: state.values,
    fieldErrors: state.fieldErrors,
    headingRef,
    onPatch: patch,
    onChooseAndAdvance: chooseAndAdvance,
    onContinue: goNext,
    onBack: state.step > 0 ? goBack : undefined,
  };

  return (
    <div aria-busy={state.status === "submitting"}>
      <Progress current={state.step + 1} total={STEPS.length} />
      <div className="mt-5">
        {state.step === 0 && <ServiceStep {...common} />}
        {state.step === 1 && <PostcodeStep {...common} launchRegion={launchRegion} />}
        {state.step === 2 && <PropertyStep {...common} />}
        {state.step === 3 && <ScopeStep {...common} />}
        {state.step === 4 && <UrgencyStep {...common} />}
        {state.step === LAST_STEP && (
          <ContactStep
            values={state.values}
            fieldErrors={state.fieldErrors}
            headingRef={headingRef}
            onPatch={patch}
            onBack={goBack}
            turnstileSiteKey={turnstileSiteKey}
            challengeEpoch={challengeEpoch}
            consentSegments={consent.segments}
            submitting={state.status === "submitting"}
            formError={state.formError}
            needsReload={needsReload}
            onSubmit={submit}
          />
        )}
      </div>
    </div>
  );
}
