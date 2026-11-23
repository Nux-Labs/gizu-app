import { DomainError } from "../domain/errors/domain-error.ts";

/** Opaque pagination cursors: clients pass back exactly what a page returned as `next`. */
export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeCursor(cursor: string): unknown {
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
}

export function invalidCursor() {
  return new DomainError("CURSOR_INVALID", "The cursor is invalid.");
}
