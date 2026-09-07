import { randomBytes } from "node:crypto";

/** RFC 9562 UUIDv7: 48-bit unix millisecond timestamp + random. MSP command ids must be v7. */
export function uuid7(): string {
  const ms = Date.now();
  const b = Buffer.alloc(16);
  b.writeUIntBE(ms, 0, 6);
  randomBytes(10).copy(b, 6);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
