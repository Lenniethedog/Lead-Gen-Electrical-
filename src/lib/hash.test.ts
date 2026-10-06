import { describe, expect, it } from "vitest";
import { fingerprint, sha256Hex, stableStringify } from "./hash";

describe("stableStringify", () => {
  it("is independent of key order, at every depth", () => {
    expect(stableStringify({ b: 1, a: { d: 4, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 4 }, b: 1 }));
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("omits undefined object members but keeps array positions", () => {
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(stableStringify([1, undefined, 3])).toBe("[1,null,3]");
  });

  it("serialises primitives and null like JSON", () => {
    expect(stableStringify("x")).toBe('"x"');
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(5)).toBe("5");
    expect(stableStringify(true)).toBe("true");
  });

  it("escapes keys and values safely", () => {
    expect(stableStringify({ 'a"b': 'c\nd' })).toBe('{"a\\"b":"c\\nd"}');
  });
});

describe("fingerprint", () => {
  it("is a 64 char hex sha256 and equal for equivalent payloads", () => {
    const a = fingerprint({ service: "fault_repair", phone: "+447911100001" });
    const b = fingerprint({ phone: "+447911100001", service: "fault_repair" });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it("changes when any value changes", () => {
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });

  it("matches a known sha256 test vector", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
