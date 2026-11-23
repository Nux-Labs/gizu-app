import { DomainError } from "./domain-error.ts";

/** A rule violation the HTTP layer answers with its own status instead of 400. */
export class StatusDomainError extends DomainError {
  constructor(
    readonly statusCode: 401 | 403 | 409 | 429,
    code: string,
    message: string,
  ) {
    super(code, message);
  }
}
