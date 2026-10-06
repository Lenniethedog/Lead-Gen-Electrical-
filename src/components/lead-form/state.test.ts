import { describe, expect, it } from "vitest";
import { EMPTY_VALUES, firstIncompleteStep, initialState, LAST_STEP, reducer, routeServerErrors, STEPS, stepForField, type FormState, type FormValues } from "./state";

const fresh = () => initialState("key-1", 1_000);

function apply(state: FormState, ...actions: Parameters<typeof reducer>[1][]): FormState {
  return actions.reduce(reducer, state);
}

describe("step navigation", () => {
  it("has the six steps in the intended order", () => {
    expect(STEPS).toEqual(["service", "postcode", "property", "scope", "urgency", "contact"]);
  });

  it("moves forward and back but never outside the range", () => {
    expect(apply(fresh(), { type: "back" }).step).toBe(0);
    let state = fresh();
    for (let i = 0; i < 20; i += 1) state = reducer(state, { type: "next" });
    expect(state.step).toBe(LAST_STEP);
    expect(reducer(state, { type: "back" }).step).toBe(LAST_STEP - 1);
    expect(reducer(state, { type: "goto", step: -4 }).step).toBe(0);
    expect(reducer(state, { type: "goto", step: 99 }).step).toBe(LAST_STEP);
  });
});

describe("patching values", () => {
  it("resets the scope when the service changes, but not when it is re-selected", () => {
    let state = apply(fresh(), { type: "patch", patch: { service: "fault_repair" } }, { type: "patch", patch: { scope: "no_power" } });
    expect(state.values.scope).toBe("no_power");
    state = reducer(state, { type: "patch", patch: { service: "fault_repair" } });
    expect(state.values.scope).toBe("no_power");
    state = reducer(state, { type: "patch", patch: { service: "rewire" } });
    expect(state.values.scope).toBeNull();
  });

  it("drops a coverage confirmation as soon as the postcode no longer matches it", () => {
    const covered = { postcode: "BR6 0AA", areaName: "Orpington" };
    let state = apply(fresh(), { type: "patch", patch: { postcode: "br6 0aa", coverage: covered } });
    state = reducer(state, { type: "patch", patch: { postcode: "BR60AA" } }); // same postcode, different spacing
    expect(state.values.coverage).toEqual(covered);
    state = reducer(state, { type: "patch", patch: { postcode: "BR6 0AB" } });
    expect(state.values.coverage).toBeNull();
  });

  it("clears a field's server error when the user edits that field, and the form-level error on any edit", () => {
    let state = reducer(fresh(), {
      type: "submit_failed",
      formError: "Something went wrong",
      fieldErrors: { phone: "Bad phone", email: "Bad email" },
      goToStep: null,
    });
    state = reducer(state, { type: "patch", patch: { phone: "07123 456789" } });
    expect(state.fieldErrors).toEqual({ email: "Bad email" });
    expect(state.formError).toBeNull();
  });
});

describe("submission lifecycle", () => {
  it("marks submitting, then done with the reference", () => {
    let state = reducer(fresh(), { type: "submit_started" });
    expect(state.status).toBe("submitting");
    state = reducer(state, { type: "submit_succeeded", reference: "L-AAAAA-BBBBB" });
    expect(state).toMatchObject({ status: "done", reference: "L-AAAAA-BBBBB" });
  });

  it("returns to editing on failure, keeps all answers and the idempotency key", () => {
    let state = apply(fresh(), { type: "patch", patch: { name: "Alex" } }, { type: "submit_started" });
    state = reducer(state, { type: "submit_failed", formError: "Network down", fieldErrors: {}, goToStep: null });
    expect(state).toMatchObject({ status: "editing", formError: "Network down", idempotencyKey: "key-1" });
    expect(state.values.name).toBe("Alex");
  });

  it("starts a brand-new enquiry with a NEW key after reset", () => {
    const state = reducer(reducer(fresh(), { type: "submit_succeeded", reference: "R" }), { type: "reset", idempotencyKey: "key-2", now: 5 });
    expect(state).toMatchObject({ status: "editing", idempotencyKey: "key-2", startedAt: 5, step: 0, reference: null });
  });
});

describe("routing server validation errors to the right step", () => {
  it("maps wire paths to form fields", () => {
    const { fieldErrors } = routeServerErrors({ "contact.phone": "p", "contact.email": "e", "consent.accepted": "c", postcode: "x" });
    expect(fieldErrors).toEqual({ phone: "p", email: "e", consent: "c", postcode: "x" });
  });

  it("jumps to the EARLIEST step containing an error", () => {
    expect(routeServerErrors({ "contact.phone": "p", urgency: "u" }).goToStep).toBe(4);
    expect(routeServerErrors({ "contact.phone": "p", postcode: "x", scope: "s" }).goToStep).toBe(1);
    expect(routeServerErrors({ "contact.phone": "p" }).goToStep).toBe(5);
  });

  it("ignores unknown paths and reports no step when nothing maps", () => {
    expect(routeServerErrors({ _root: "bad body", "context.elapsedMs": "x" })).toEqual({ fieldErrors: {}, goToStep: null });
  });

  it("places every field on a step", () => {
    expect(stepForField("service")).toBe(0);
    expect(stepForField("ownership")).toBe(2);
    expect(stepForField("consent")).toBe(5);
  });
});

describe("firstIncompleteStep", () => {
  const complete: FormValues = {
    ...EMPTY_VALUES,
    service: "fault_repair",
    postcode: "br6 0aa",
    propertyType: "house",
    ownership: "owner",
    scope: "no_power",
    urgency: "emergency",
  };

  it("returns null when every earlier answer is present and consistent", () => {
    expect(firstIncompleteStep(complete)).toBeNull();
  });

  it.each([
    [{ service: null }, 0],
    [{ postcode: "nope" }, 1],
    [{ propertyType: null }, 2],
    [{ ownership: null }, 2],
    [{ scope: null }, 3],
    [{ scope: "full_rewire" }, 3], // belongs to a different service
    [{ urgency: null }, 4],
  ] as const)("finds the step for %j", (patch, step) => {
    expect(firstIncompleteStep({ ...complete, ...patch })).toBe(step);
  });

  it("reports the earliest gap when several are missing", () => {
    expect(firstIncompleteStep({ ...complete, urgency: null, postcode: "" })).toBe(1);
  });
});

describe("rekey", () => {
  it("replaces only the idempotency key", () => {
    const state = reducer(fresh(), { type: "rekey", idempotencyKey: "key-9" });
    expect(state.idempotencyKey).toBe("key-9");
    expect(state.step).toBe(0);
  });
});
