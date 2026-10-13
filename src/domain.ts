import { z } from "zod";

const completedStatus = z.string().trim().transform((value, context) => {
  const normalized = value.toLowerCase();
  if (normalized !== "completed") {
    context.addIssue({ code: "custom", message: "callStatus must be completed" });
    return z.NEVER;
  }
  return "completed" as const;
});

export const voiceCallWebhookSchema = z.object({
  eventId: z.string().trim().min(1).max(160),
  eventType: z.literal("voice_ai_call.completed"),
  locationId: z.string().trim().min(1).max(100),
  contactId: z.string().trim().min(1).max(160),
  callId: z.string().trim().min(1).max(160).optional(),
  callStatus: completedStatus,
  direction: z.string().trim().max(40).optional(),
  occurredAt: z.iso.datetime({ offset: true }).optional(),
  clientName: z.string().trim().max(200).optional(),
  clientPhone: z.string().trim().max(80).optional(),
  callSummary: z.string().trim().max(1000).optional(),
}).passthrough();

export type VoiceCallWebhook = z.infer<typeof voiceCallWebhookSchema>;

export interface GhlContact {
  id: string;
  locationId: string;
  assignedTo?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
}

export type CallEventStatus =
  | "processing"
  | "delivered"
  | "waiting_assignee"
  | "waiting_binding"
  | "unsupported_event"
  | "failed_retryable"
  | "failed_permanent";

export interface EventClaim {
  eventId: string;
  claimed: boolean;
  existingStatus?: CallEventStatus;
}

export interface ReadyRoute {
  kind: "ready";
  salesUserId: string;
  salesName: string;
  chatId: string;
}

export interface UnavailableRoute {
  kind: "unavailable";
  reason: "mapping_not_found" | "sales_disabled" | "telegram_not_connected";
  salesUserId?: string;
  salesName?: string;
}

export type RouteResolution = ReadyRoute | UnavailableRoute;

export type ProcessOutcome =
  | { kind: "delivered"; eventId: string }
  | { kind: "duplicate"; eventId: string; status: CallEventStatus }
  | { kind: "waiting"; eventId: string; reason: string }
  | { kind: "retryable_failure"; eventId: string; reason: string }
  | { kind: "permanent_failure"; eventId: string; reason: string };

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number; type: string };
    from?: { id: number; username?: string; first_name?: string; last_name?: string };
  };
}
