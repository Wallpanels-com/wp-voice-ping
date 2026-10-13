import type { AppConfig } from "./config.js";
import type { ProcessOutcome, VoiceCallWebhook } from "./domain.js";
import { ExternalServiceError } from "./external-error.js";
import type { HighLevelClient } from "./highlevel.js";
import type { NotificationRecipient, Store } from "./store.js";
import type { TelegramClient } from "./telegram.js";

export interface ProcessorLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

function routingWarning(reason: string, salesName?: string): string {
  const person = salesName ? ` (${salesName})` : "";
  const messages: Record<string, string> = {
    contact_has_no_assigned_user: "Contact has no Assigned User.",
    mapping_not_found: "Assigned GHL user is not mapped to a sales profile.",
    sales_disabled: `Assigned sales profile is disabled${person}.`,
    telegram_not_connected: `Assigned sales has not connected Telegram${person}.`,
  };
  return messages[reason] ?? "Assigned sales notification could not be routed.";
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
      return { kind: "duplicate", eventId: claim.eventId, status: claim.existingStatus ?? "processing" };
    }

    try {
      const contact = await this.highLevel.getContact(location, webhook.contactId);
      if (contact.id !== webhook.contactId || contact.locationId !== webhook.locationId) {
        await this.store.markEvent(claim.eventId, "failed_permanent", "contact_location_mismatch");
        return { kind: "permanent_failure", eventId: claim.eventId, reason: "contact_location_mismatch" };
      }

      const conversation = await this.highLevel.findConversation(location, webhook.contactId);
      const assignedGhlUserId = contact.assignedTo?.trim();
      const admins = await this.store.listActiveAdminRecipients();
      const recipients = new Map<string, NotificationRecipient>();
      let assignedName = "Unassigned";
      let issue: string | undefined;
      let routingReason: string | undefined;

      if (!assignedGhlUserId) {
        routingReason = "contact_has_no_assigned_user";
        issue = routingWarning("contact_has_no_assigned_user");
      } else {
        const route = await this.store.resolveRoute(webhook.locationId, assignedGhlUserId);
        if (route.kind === "ready") {
          assignedName = route.salesName;
          recipients.set(route.salesUserId, { ...route, isAdmin: false });
        } else {
          assignedName = route.salesName ?? "Unknown GHL user";
          routingReason = route.reason;
          issue = routingWarning(route.reason, route.salesName);
        }
      }

      for (const admin of admins) recipients.set(admin.salesUserId, admin);
      if (recipients.size === 0) {
        const reason = routingReason ?? "no_active_recipients";
        const status = assignedGhlUserId ? "waiting_binding" : "waiting_assignee";
        await this.store.markEvent(claim.eventId, status, reason, assignedGhlUserId);
        return { kind: "waiting", eventId: claim.eventId, reason };
      }

      let sent = 0;
      let retryableFailure: string | undefined;
      let permanentFailure: string | undefined;
      for (const recipient of recipients.values()) {
        const delivery = await this.store.prepareDelivery(claim.eventId, recipient.salesUserId, recipient.chatId);
        if (delivery.alreadySent) {
          sent += 1;
          continue;
        }
        try {
          const messageId = await this.telegram.sendCallNotification({
            chatId: recipient.chatId,
            salesName: assignedName,
            location,
            webhook,
            contact,
            conversationId: conversation.id,
            ...(recipient.isAdmin && issue ? { routingIssue: issue } : {}),
          });
          await this.store.markDelivery(delivery.id, "sent", { telegramMessageId: messageId });
          sent += 1;
        } catch (error) {
          if (!(error instanceof ExternalServiceError) || error.service !== "telegram") throw error;
          await this.store.markDelivery(
            delivery.id,
            error.retryable ? "retryable_failure" : "permanent_failure",
            { errorCode: error.code },
          );
          if (error.retryable) retryableFailure = `telegram_${error.code}`;
          else permanentFailure = `telegram_${error.code}`;
        }
      }

      if (retryableFailure) {
        await this.store.markEvent(claim.eventId, "failed_retryable", retryableFailure, assignedGhlUserId);
        return { kind: "retryable_failure", eventId: claim.eventId, reason: retryableFailure };
      }
      if (sent > 0) {
        await this.store.markEvent(claim.eventId, "delivered", issue ?? permanentFailure, assignedGhlUserId);
        this.logger.info(
          { eventId: claim.eventId, locationId: webhook.locationId, recipients: sent },
          "Call notifications delivered",
        );
        return { kind: "delivered", eventId: claim.eventId };
      }

      const reason = permanentFailure ?? issue ?? "no_active_recipients";
      await this.store.markEvent(claim.eventId, "waiting_binding", reason, assignedGhlUserId);
      return { kind: "waiting", eventId: claim.eventId, reason };
    } catch (error) {
      if (error instanceof ExternalServiceError && error.service === "ghl") {
        const status = error.retryable ? "failed_retryable" : "failed_permanent";
        await this.store.markEvent(claim.eventId, status, `ghl_${error.code}`);
        this.logger.warn(
          { eventId: claim.eventId, locationId: webhook.locationId, code: error.code, retryable: error.retryable },
          "GHL lookup failed",
        );
        return error.retryable
          ? { kind: "retryable_failure", eventId: claim.eventId, reason: `ghl_${error.code}` }
          : { kind: "permanent_failure", eventId: claim.eventId, reason: `ghl_${error.code}` };
      }
      await this.store.markEvent(claim.eventId, "failed_retryable", "internal_processing_error");
      this.logger.error(
        { eventId: claim.eventId, locationId: webhook.locationId },
        "Unexpected call processing failure",
      );
      return { kind: "retryable_failure", eventId: claim.eventId, reason: "internal_processing_error" };
    }
  }
}
