# GHL Workflow Setup

Create this workflow separately in each location after Railway deployment. Do not modify the old SLA workflow or reuse its bot service.

## Confirmed HighLevel capabilities

HighLevel's current Call Details trigger supports call direction and system call status filters, including incoming and completed calls. The Custom Webhook action supports POST requests, custom headers, JSON bodies, dynamic contact values, response logging, and retries for failed requests.

Official references:

- [Call Details workflow trigger](https://help.gohighlevel.com/support/solutions/articles/48001212511)
- [Custom Webhook workflow action](https://help.gohighlevel.com/support/solutions/articles/155000003305/)
- [Outbound Webhook payload behavior](https://help.gohighlevel.com/support/solutions/articles/155000003299-actions-webhook)
- [Get Contact API](https://marketplace.gohighlevel.com/docs/2023-02-21/ghl/contacts/get-contact/index.html)

The public HighLevel documentation does not currently define a dedicated Voice AI Completed trigger or publish the exact Call Details dynamic-value token for the call ID. Verify both in the location's Workflow Builder before publishing. The backend contract requires a stable call or event ID for reliable deduplication.

## Workflow trigger

Use **Call Details** with:

- Call Direction: **Incoming**
- Call Status: **Completed**
- In Phone Number: select only the number or numbers handled by the Voice AI agent
- Allow Re-entry: enabled, because one contact may call more than once

If the Workflow Builder provides a dedicated Voice AI call-completed trigger, prefer it only after a test confirms it fires once per completed call and exposes the same contact and stable call identifier.

The phone-number filter is important: Incoming plus Completed alone also matches ordinary human-handled calls.

## Custom Webhook action

Add **Custom Webhook** after the trigger.

- Event: **CUSTOM**
- Method: **POST**
- URL: `https://wp-voice-ping-production.up.railway.app/webhooks/ghl/voice-ai-call-completed`
- Authorization: **No auth**
- Header: `Content-Type: application/json`
- Header: `X-WP-Voice-Ping-Secret: VALUE_FROM_RAILWAY_GHL_WEBHOOK_SECRET`

Keep the secret in the workflow header. Do not put it in the URL.

## JSON body

Create one workflow per location and use the fixed confirmed Location ID shown below. Insert contact fields through HighLevel's dynamic-value picker.

WallPanels:

```json
{
  "eventId": "CALL_ID_FROM_CALL_DETAILS_DYNAMIC_VALUE_PICKER",
  "eventType": "voice_ai_call.completed",
  "locationId": "Iwpfx8zGzpsZszcnGovT",
  "contactId": "{{contact.id}}",
  "callId": "CALL_ID_FROM_CALL_DETAILS_DYNAMIC_VALUE_PICKER",
  "callStatus": "completed",
  "direction": "incoming",
  "clientName": "{{contact.name}}",
  "clientPhone": "{{contact.phone}}"
}
```

Verona Home:

```json
{
  "eventId": "CALL_ID_FROM_CALL_DETAILS_DYNAMIC_VALUE_PICKER",
  "eventType": "voice_ai_call.completed",
  "locationId": "pSsHdL8pyBsLeIci1Py0",
  "contactId": "{{contact.id}}",
  "callId": "CALL_ID_FROM_CALL_DETAILS_DYNAMIC_VALUE_PICKER",
  "callStatus": "completed",
  "direction": "incoming",
  "clientName": "{{contact.name}}",
  "clientPhone": "{{contact.phone}}"
}
```

`CALL_ID_FROM_CALL_DETAILS_DYNAMIC_VALUE_PICKER` is an explicit setup placeholder, not a verified HighLevel merge tag. Replace both occurrences with the stable trigger-specific call ID offered by the Workflow Builder. Do not publish the workflow with the placeholder.

Do not send Assigned User in the body as an authority. The backend always reads the current contact through the matching location's read-only GHL API token and routes by `contact.assignedTo`.

## Optional fields

Add `occurredAt` only if the trigger exposes an ISO timestamp. Add `callSummary` only when HighLevel exposes a confirmed Voice AI summary value. Notification delivery does not depend on either field.

## Test procedure

1. Keep the workflow in Draft.
2. Use a controlled test contact with a known Assigned User.
3. Confirm that the sales user has completed `/start CODE` in `@WPVoicePingBot`.
4. Replace the call-ID placeholders using the Dynamic Value picker.
5. Run the Workflow test and inspect Execution Logs.
6. A delivered notification returns HTTP 200. A valid event waiting for an assignment or Telegram binding returns HTTP 202. Temporary GHL or Telegram failure returns HTTP 503 so the workflow can retry.
7. Send the same webhook twice and confirm the second response is `duplicate` and no second Telegram message appears.
8. Test one controlled completed Voice AI call before publishing.

Do not report the live Voice AI path as verified until step 8 succeeds.

## Duplicate prevention

Use the stable call ID as both `eventId` and `callId`. Neon enforces a unique constraint on `location_id + external_event_id`, and Telegram delivery has one database row per call event. Workflow re-entry is therefore safe for different calls while repeated delivery of the same call is suppressed.
