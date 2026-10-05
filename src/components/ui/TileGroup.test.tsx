import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TileGroup } from "./TileGroup";

const options = [
  { value: "a", label: "Option A", hint: "First" },
  { value: "b", label: "Option B" },
  { value: "c", label: "Option C" },
] as const;

function setup(props: Partial<React.ComponentProps<typeof TileGroup<"a" | "b" | "c">>> = {}) {
  const onChange = vi.fn();
  const onPointerChoose = vi.fn();
  render(
    <>
      <h2 id="q">Pick one</h2>
      <TileGroup name="q" labelledBy="q" options={options} value={null} onChange={onChange} onPointerChoose={onPointerChoose} {...props} />
    </>,
  );
  return { onChange, onPointerChoose, user: userEvent.setup() };
}

describe("TileGroup", () => {
  it("is a native radio group labelled by the question", () => {
    setup();
    const group = screen.getByRole("radiogroup", { name: "Pick one" });
    expect(group).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
  });

  it("reports a mouse/touch choice as BOTH a change and a pointer choice (this is what auto-advance listens to)", async () => {
    const { user, onChange, onPointerChoose } = setup();
    await user.click(screen.getByText("Option B"));
    expect(onChange).toHaveBeenCalledWith("b");
    expect(onPointerChoose).toHaveBeenCalledWith("b");
  });

  it("never reports keyboard selection as a pointer choice, so keyboard users are not moved on unexpectedly", async () => {
    const { user, onChange, onPointerChoose } = setup();
    screen.getByRole("radio", { name: /Option A/ }).focus();
    await user.keyboard(" ");
    await user.keyboard("{ArrowDown}");
    expect(onChange).toHaveBeenCalled();
    expect(onPointerChoose).not.toHaveBeenCalled();
  });

  it("marks the group invalid and exposes the error message to assistive technology", () => {
    setup({ error: "Choose one", errorId: "q-error" });
    const group = screen.getByRole("radiogroup", { name: "Pick one" });
    expect(group).toHaveAttribute("aria-invalid", "true");
    expect(group).toHaveAttribute("aria-describedby", "q-error");
    expect(screen.getByText("Choose one")).toHaveAttribute("id", "q-error");
  });

  it("reflects the selected value", () => {
    setup({ value: "c" });
    expect(screen.getByRole("radio", { name: /Option C/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Option A/ })).not.toBeChecked();
  });
});
