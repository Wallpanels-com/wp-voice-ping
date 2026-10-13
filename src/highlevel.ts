import { z } from "zod";

import type { LocationConfig } from "./config.js";
import type { GhlContact } from "./domain.js";
import { ExternalServiceError } from "./external-error.js";

const contactSchema = z.object({
  contact: z.object({
    id: z.string(),
    locationId: z.string(),
    assignedTo: z.string().nullish(),
    name: z.string().nullish(),
    firstName: z.string().nullish(),
    lastName: z.string().nullish(),
    phone: z.string().nullish(),
  }).passthrough(),
});

export interface HighLevelClient {
  getContact(location: LocationConfig, contactId: string): Promise<GhlContact>;
}

interface HighLevelHttpClientOptions {
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  maxAttempts?: number;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryDelay(response: Response | undefined, attempt: number): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  }
  return Math.min(400 * 2 ** (attempt - 1), 4_000);
}

export class HighLevelHttpClient implements HighLevelClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

  constructor(options: HighLevelHttpClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxAttempts = options.maxAttempts ?? 3;
  }

  async getContact(location: LocationConfig, contactId: string): Promise<GhlContact> {
    const endpoint = `https://services.leadconnectorhq.com/contacts/${encodeURIComponent(contactId)}`;
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      let response: Response | undefined;
      try {
        response = await this.fetchImpl(endpoint, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${location.ghlToken}`,
            Accept: "application/json",
            Version: "2021-07-28",
            "User-Agent": "wp-voice-ping/1.0",
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (response.ok) {
          const parsed = contactSchema.safeParse(await response.json());
          if (!parsed.success) {
            throw new ExternalServiceError({
              service: "ghl",
              code: "invalid_response",
              retryable: false,
              message: "GHL returned an unexpected contact response",
              statusCode: response.status,
            });
          }
          const contact = parsed.data.contact;
          const result: GhlContact = { id: contact.id, locationId: contact.locationId };
          if (contact.assignedTo) result.assignedTo = contact.assignedTo;
          if (contact.name) result.name = contact.name;
          if (contact.firstName) result.firstName = contact.firstName;
          if (contact.lastName) result.lastName = contact.lastName;
          if (contact.phone) result.phone = contact.phone;
          return result;
        }
        const retryable = response.status === 429 || response.status >= 500;
        const error = new ExternalServiceError({
          service: "ghl",
          code: response.status === 404 ? "contact_not_found" : `http_${response.status}`,
          retryable,
          message: `GHL request failed with HTTP ${response.status}`,
          statusCode: response.status,
        });
        if (!retryable || attempt === this.maxAttempts) throw error;
        lastError = error;
        await this.sleep(retryDelay(response, attempt));
      } catch (error) {
        if (error instanceof ExternalServiceError) throw error;
        lastError = error;
        if (attempt === this.maxAttempts) {
          throw new ExternalServiceError({
            service: "ghl",
            code: error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "network_error",
            retryable: true,
            message: "GHL request failed before receiving a valid response",
            cause: error,
          });
        }
        await this.sleep(retryDelay(response, attempt));
      }
    }
    throw new ExternalServiceError({
      service: "ghl",
      code: "unknown",
      retryable: true,
      message: "GHL request failed",
      cause: lastError,
    });
  }
}
