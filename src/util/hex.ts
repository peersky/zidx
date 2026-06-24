import { getAddress, isAddress, isHex } from "viem";

export type Address = `0x${string}`;
export type Hex32 = `0x${string}`;

export function normAddr(s: string): Address {
  return getAddress(s);
}

const HEX32_RE = /^0x[0-9a-fA-F]{64}$/;

export function normHandle(s: string): Hex32 {
  if (!HEX32_RE.test(s)) {
    throw new Error(`invalid hex32: ${s}`);
  }
  return s.toLowerCase() as Hex32;
}

export function isHandle(s: string): s is Hex32 {
  return HEX32_RE.test(s);
}

export function isAddr(s: string): s is Address {
  return isAddress(s);
}

export function tryNormAddr(s: string): Address | null {
  try {
    return getAddress(s);
  } catch {
    return null;
  }
}

export function tryNormHandle(s: string): Hex32 | null {
  return HEX32_RE.test(s) ? (s.toLowerCase() as Hex32) : null;
}

export const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const;
export const ZERO_HANDLE = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

export function isZeroAddr(a: string): boolean {
  return a.toLowerCase() === ZERO_ADDR;
}

export function isZeroHandle(h: string): boolean {
  return h.toLowerCase() === ZERO_HANDLE;
}

export { isHex };
