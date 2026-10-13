export class ExternalServiceError extends Error {
  readonly service: "ghl" | "telegram";
  readonly code: string;
  readonly retryable: boolean;
  readonly statusCode?: number;

  constructor(options: {
    service: "ghl" | "telegram";
    code: string;
    retryable: boolean;
    message: string;
    statusCode?: number;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "ExternalServiceError";
    this.service = options.service;
    this.code = options.code;
    this.retryable = options.retryable;
    if (options.statusCode !== undefined) this.statusCode = options.statusCode;
  }
}
