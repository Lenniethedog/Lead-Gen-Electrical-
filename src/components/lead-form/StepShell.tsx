import type { ReactNode, Ref } from "react";
import { Button } from "@/components/ui/Button";

interface StepShellProps {
  headingId: string;
  headingRef: Ref<HTMLHeadingElement>;
  title: string;
  intro?: ReactNode;
  children: ReactNode;
  onContinue: () => void;
  onBack?: (() => void) | undefined;
  continueLabel?: string;
  /** Disables Continue while something asynchronous (a coverage check) is in flight. */
  busy?: boolean;
  busyLabel?: string;
  footer?: ReactNode;
}

/**
 * One step = one <form>, so Enter submits and "Continue" is a real submit button. The heading is
 * programmatically focusable: when the step changes, focus moves to it, so screen-reader and
 * keyboard users land at the start of the new question instead of on a vanished button.
 */
export function StepShell({
  headingId,
  headingRef,
  title,
  intro,
  children,
  onContinue,
  onBack,
  continueLabel = "Continue",
  busy = false,
  busyLabel = "Please wait…",
  footer,
}: StepShellProps) {
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onContinue();
      }}
    >
      <h2 id={headingId} ref={headingRef} tabIndex={-1} className="text-2xl font-bold leading-tight text-ink outline-none">
        {title}
      </h2>
      {intro ? <p className="mt-1.5 text-base text-muted">{intro}</p> : null}
      <div className="mt-5">{children}</div>
      <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        {onBack ? (
          <Button variant="secondary" onClick={onBack}>
            Back
          </Button>
        ) : (
          <span />
        )}
        <Button type="submit" disabled={busy}>
          {busy ? busyLabel : continueLabel}
        </Button>
      </div>
      {footer}
    </form>
  );
}
