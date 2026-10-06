import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SafetyNote } from "./SafetyNote";

describe("SafetyNote", () => {
  it("tells someone with sparks or a shock to ring 999, and someone with a power cut to ring 105, with numbers a phone can dial", () => {
    render(<SafetyNote />);
    const note = screen.getByRole("complementary", { name: "Electrical safety" });
    expect(note).toHaveTextContent("Sparks, a burning smell or an electric shock?");
    expect(note).toHaveTextContent("switch the power off at the consumer unit");
    expect(screen.getByRole("link", { name: "Call 999" })).toHaveAttribute("href", "tel:999");
    expect(note).toHaveTextContent("Power cut or a fallen cable?");
    expect(screen.getByRole("link", { name: "Call 105" })).toHaveAttribute("href", "tel:105");
  });

  it("has a one-line version for above the form that still says what to do and gives both numbers", () => {
    render(<SafetyNote compact />);
    const note = screen.getByRole("complementary", { name: "Electrical safety" });
    expect(note).toHaveTextContent("Sparks, a burning smell or an electric shock? Don't wait for a quote: call 999 for a fire or an injury, or 105 for a power cut (free).");
    expect(screen.getByRole("link", { name: "999" })).toHaveAttribute("href", "tel:999");
    expect(screen.getByRole("link", { name: "105" })).toHaveAttribute("href", "tel:105");
  });
});
