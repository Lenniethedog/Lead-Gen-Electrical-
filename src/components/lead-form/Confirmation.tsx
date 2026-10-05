"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/Button";

interface ConfirmationProps {
  reference: string;
  brandName: string;
  privacyEmail: string;
  onStartAnother: () => void;
}

export function Confirmation({ reference, brandName, privacyEmail, onStartAnother }: ConfirmationProps) {
  const heading = useRef<HTMLHeadingElement>(null);

  // Move focus to the result so screen-reader users hear that the enquiry went through.
  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <div role="status">
      <div aria-hidden="true" className="grid size-12 place-items-center rounded-full bg-green-100 text-success">
        <svg viewBox="0 0 24 24" className="size-7" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M5 12.5l4.5 4.5L19 7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <h2 ref={heading} tabIndex={-1} className="mt-4 text-2xl font-bold text-ink outline-none">
        Thanks, your enquiry has been sent
      </h2>
      <p className="mt-2 text-base text-ink">
        {brandName} is passing your details to a local roofing business that covers your area. They will contact you
        directly to talk about the work and give you a quote.
      </p>
      <p className="mt-4 rounded-lg bg-stone-100 px-4 py-3 text-base">
        Your reference: <strong className="font-mono text-lg tracking-wide">{reference}</strong>
        <span className="mt-1 block text-sm text-muted">Quote this if you ever need to ask us about your enquiry.</span>
      </p>
      <p className="mt-4 text-sm text-muted">
        You can withdraw your consent or ask us to delete your details at any time: email{" "}
        <a className="font-semibold text-brand-800 underline" href={`mailto:${privacyEmail}`}>
          {privacyEmail}
        </a>{" "}
        or read our{" "}
        <Link className="font-semibold text-brand-800 underline" href="/privacy">
          Privacy Notice
        </Link>
        .
      </p>
      <div className="mt-6">
        <Button variant="secondary" onClick={onStartAnother}>
          Send another enquiry
        </Button>
      </div>
    </div>
  );
}
