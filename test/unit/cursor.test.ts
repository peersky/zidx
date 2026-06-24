import { describe, it, expect } from "vitest";
import { encodeCursor, decodeCursor } from "../../src/api/cursor.js";

describe("cursor", () => {
  it("round-trips a typical (block, logIndex, txHash) triple", () => {
    const c = { block: 12345, logIndex: 3, txHash: "0x" + "ab".repeat(32) };
    const enc = encodeCursor(c);
    expect(decodeCursor(enc)).toEqual(c);
  });

  it("encodes deterministically (same input → same opaque string)", () => {
    const c = { block: 1, logIndex: 0, txHash: "0x" + "cd".repeat(32) };
    expect(encodeCursor(c)).toBe(encodeCursor(c));
  });

  it("normalizes mixed-case txHash to lowercase on encode", () => {
    const mixed = { block: 1, logIndex: 0, txHash: "0x" + "AB".repeat(32) };
    const lower = { block: 1, logIndex: 0, txHash: "0x" + "ab".repeat(32) };
    expect(encodeCursor(mixed)).toBe(encodeCursor(lower));
  });

  it("strips a stray 0x prefix duplication safely", () => {
    const c = encodeCursor({ block: 7, logIndex: 1, txHash: "0x" + "00".repeat(32) });
    const decoded = decodeCursor(c);
    expect(decoded?.txHash.startsWith("0x")).toBe(true);
    expect(decoded?.txHash.length).toBe(66);
  });

  it("returns null on malformed cursors instead of throwing", () => {
    expect(decodeCursor("not-base64!!!")).toBeNull();
    expect(decodeCursor(Buffer.from("nope").toString("base64url"))).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor(null)).toBeNull();
  });

  it("rejects non-numeric block/logIndex", () => {
    const bad = Buffer.from("bABC.l0.t" + "00".repeat(32), "utf8").toString("base64url");
    expect(decodeCursor(bad)).toBeNull();
  });

  it("rejects short tx hashes", () => {
    const bad = Buffer.from("b1.l0.tabc", "utf8").toString("base64url");
    expect(decodeCursor(bad)).toBeNull();
  });
});
