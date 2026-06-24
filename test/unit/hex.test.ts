import { describe, it, expect } from "vitest";
import {
  normAddr,
  normHandle,
  isHandle,
  isAddr,
  tryNormAddr,
  tryNormHandle,
  ZERO_ADDR,
  ZERO_HANDLE,
  isZeroAddr,
  isZeroHandle,
} from "../../src/util/hex.js";

describe("normAddr", () => {
  it("returns EIP-55 checksum form for valid lowercase hex", () => {
    const addr = normAddr("0x52908400098527886e0f7030069857d2e4169ee7");
    expect(addr).toBe("0x52908400098527886E0F7030069857D2E4169EE7");
  });

  it("accepts already-checksummed input", () => {
    const addr = normAddr("0x52908400098527886E0F7030069857D2E4169EE7");
    expect(addr).toBe("0x52908400098527886E0F7030069857D2E4169EE7");
  });

  it("throws on invalid length", () => {
    expect(() => normAddr("0x123")).toThrow();
  });

  it("throws on non-hex chars", () => {
    expect(() => normAddr("0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG")).toThrow();
  });
});

describe("normHandle", () => {
  it("lowercases a mixed-case bytes32 handle", () => {
    const h = normHandle("0xABCD1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890AB");
    expect(h).toBe("0xabcd1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab");
  });

  it("throws on wrong length", () => {
    expect(() => normHandle("0xabcd")).toThrow(/invalid hex32/);
  });

  it("throws on non-hex chars", () => {
    expect(() => normHandle("0x" + "g".repeat(64))).toThrow(/invalid hex32/);
  });
});

describe("type guards", () => {
  it("isHandle matches valid hex32", () => {
    expect(isHandle("0x" + "a".repeat(64))).toBe(true);
    expect(isHandle("0x" + "a".repeat(63))).toBe(false);
    expect(isHandle("0xZZZZ")).toBe(false);
  });

  it("isAddr matches valid address", () => {
    expect(isAddr("0x52908400098527886E0F7030069857D2E4169EE7")).toBe(true);
    expect(isAddr("0x52908400098527886E0F7030069857D2E4169EE")).toBe(false);
  });
});

describe("try* variants don't throw", () => {
  it("tryNormAddr returns null on bad input", () => {
    expect(tryNormAddr("0xnope")).toBeNull();
  });
  it("tryNormHandle returns null on bad input", () => {
    expect(tryNormHandle("0xnope")).toBeNull();
  });
});

describe("zero constants", () => {
  it("ZERO_ADDR and ZERO_HANDLE are correct lengths", () => {
    expect(ZERO_ADDR.length).toBe(42);
    expect(ZERO_HANDLE.length).toBe(66);
  });
  it("isZeroAddr / isZeroHandle detect zero values", () => {
    expect(isZeroAddr(ZERO_ADDR)).toBe(true);
    expect(isZeroAddr("0x0000000000000000000000000000000000000000")).toBe(true);
    expect(isZeroHandle(ZERO_HANDLE)).toBe(true);
  });
});
