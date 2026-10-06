// Strict hex decoding. Buffer.from(hex, 'hex') silently stops at the first
// invalid character, which turns malformed input into a truncated value.
export function parseHex(hex: string, label: string, expectedBytes?: number): Uint8Array {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`${label} is not a valid hex string`);
  }
  if (expectedBytes !== undefined && hex.length !== expectedBytes * 2) {
    throw new Error(`${label} must be ${expectedBytes} bytes (got ${hex.length / 2})`);
  }
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

export function isHex32(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
