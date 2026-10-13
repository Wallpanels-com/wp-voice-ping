import type { AppConfig } from "./config.js";
import type { ProcessOutcome, VoiceCallWebhook } from "./domain.js";
import { ExternalServiceError } from "./external-error.js";
import type { HighLevelClient } from "./highlevel.js";
import type { Store } from "./store.js";
import type { TelegramClient } from "./telegram.js";

export interface ProcessorLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

export class CallProcessor {
  constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    private readonly highLevel: HighLevelClient,
    private readonly telegram: TelegramClient,
    private readonly logger: ProcessorLogger,
  ) {}

  async process(webhook: VoiceCallWebhook): Promise<ProcessOutcome> {
    const location = this.config.locations.get(webhook.locationId);
    if (!location) {
      return { kind: "permanent_failure", eventId: "unclaimed", reason: "invalid_location" };
    }

    const claim = await this.store.claimCallEvent(webhook);
    if (!claim.claimed) {
      return {
        kind: "duplicate",
        eventId: claim.eventId,
        status: claim.existingStatus ?? "processing",
      };
    }

    try {
      const contact = await this.highLevel.getContact(location, webhook.contactId);
      if (contact.id !== webhook.contactId || contact.locationId !== webhook.locationId) {
        await this.store.markEvent(claim.eventId, "failed_permanent", "contact_location_mismatch");
        this.logger.warn(
          { eventId: claim.eventId, locationId: webhook.locationId, reason: "contact_location_mismatch" },
          "Call event rejected after GHL contact validation",
        );
        return { kind: "permanent_failure", eventId: claim.eventId, reason: "contact_location_mismatch" };
      }

      const assignedGhlUserId = contact.assignedTo?.trim();
      if (!assignedGhlUserId) {
        await this.store.markEvent(claim.eventId, "waiting_assignee", "contact_has_no_assigned_user");
        this.logger.info(
          { eventId: claim.eventId, locationId: webhook.locationId, status: "waiting_assignee" },
          "Call event is waiting for a contact assignment",
        );
        return { kind: "waiting", eventId: claim.eventId, reason: "contact_has_no_assigned_user" };
      }

      const route = await this.store.resolveRoute(webhook.locationId, assignedGhlUserId);
      if (route.kind === "unavailable") {
        await this.store.markEvent(claim.eventId, "waiting_binding", route.reason, assignedGhlUserId);
        this.logger.info(
          { eventId: claim.eventId, locationId: webhook.locationId, status: "waiting_binding", reason: route.reason },
          "Call event has no active exact Telegram route",
        );
        return { kind: "waiting", eventId: claim.eventId, reason: route.reason };
      }

      const deliveryId = await this.store.prepareDelivery(claim.eventId, route.salesUserId, route.chatId);
      try {
        const messageId = await this.telegram.sendCallNotification({
          chatId: route.chatId,
          salesName: route.salesName,
          location,
          webhook,
          contact,
        });
        await this.store.markDelivery(deliveryId, "sent", { telegramMessageId: messageId });
        await this.store.markEvent(claim.eventId, "delivered", undefined, assignedGhlUserId);
        this.logger.info(
          { eventId: claim.eventId, locationId: webhook.locationId, status: "delivered" },
          "Call notification delivered",
        );
        return { kind: "delivered", eventId: claim.eventId };
      } catch (error) {
        if (error instanceof ExternalServiceError) {
          const deliveryStatus = error.retryable ? "retryable_failure" : "permanent_failure";
          const eventStatus = error.retryable ? "failed_retryable" : "waiting_binding";
          await this.store.markDelivery(deliveryId, deliveryStatus, { errorCode: error.code });
          await this.store.markEvent(claim.eventId, eventStatus, `telegram_${error.code}`, assignedGhlUserId);
          this.logger.warn(
            {
              eventId: claim.eventId,
              locationId: webhook.locationId,
              service: "telegram",
              code: error.code,
              retryable: error.retryable,
            },
            "Telegram delivery failed",
          );
          return error.retryable
            ? { kind: "retryable_failure", eventId: claim.eventId, reason: `telegram_${error.code}` }
            : { kind: "waiting", eventId: claim.eventId, reason: `telegram_${error.code}` };
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof ExternalServiceError && error.service === "ghl") {
        const status = error.retryable ? "failed_retryable" : "failed_permanent";
        await this.store.markEvent(claim.eventId, status, `ghl_${error.code}`);
        this.logger.warn(
          {
            eventId: claim.eventId,
            locationId: webhook.locationId,
            service: "ghl",
            code: error.code,
            retryable: error.retryable,
          },
          "GHL contact lookup failed",
        );
        return error.retryable
          ? { kind: "retryable_failure", eventId: claim.eventId, reason: `ghl_${error.code}` }
          : { kind: "permanent_failure", eventId: claim.eventId, reason: `ghl_${error.code}` };
      }
      await this.store.markEvent(claim.eventId, "failed_retryable", "internal_processing_error");
      this.logger.error(
        { eventId: claim.eventId, locationId: webhook.locationId, reason: "internal_processing_error" },
        "Unexpected call processing failure",
      );
      return { kind: "retryable_failure", eventId: claim.eventId, reason: "internal_processing_error" };
    }
  }
}
