import { createHmac, timingSafeEqual } from "node:crypto";

export function secureEquals(received: string | undefined, expected: string): boolean {
  if (!received) return false;
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer);
}

export function hashConnectionCode(code: string, pepper: string): string {
  return createHmac("sha256", pepper).update(code.trim().toUpperCase()).digest("hex");
}
