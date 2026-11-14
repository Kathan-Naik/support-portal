# Deployment Engineer: hands-on exercise

**Time: 25 minutes.** Share your screen and think out loud. Use any language, tools, libraries and AI assistants you like; AI is encouraged. We care more about how you work and reason than how polished the result is. No domain knowledge is needed.

All data here is synthetic.

## The situation

You're the Deployment Engineer for three customers: a dental clinic, an auto repair shop and a hair salon. Each uses an **AI phone agent** that answers their inbound calls and books, moves and cancels appointments. The agent writes those changes into the customer's own third-party **booking system** through an API.

It's **Monday morning**. **Customer A (Sunrise Dental)** messages you:

> "The AI stopped booking appointments sometime last week. What's going on??"

## Your task

1. **Build a quick way to explore the calls:** filters by customer, date, intent and outcome, plus any categorisation you find useful. A script, a notebook, a small web page or a SQL view all count. Spend about 10 minutes here, not more.
2. **Find out what happened.** Then tell us:
   - the message you'd send Customer A, and
   - what you'd hand to Engineering.

You won't necessarily find everything in 25 minutes, and that's fine. Tell us what you'd check next.

## Data (`data/`)

### `customers.json`
One entry per customer: `customer_id`, `name`, `business_type`, `timezone`, `booking_system`, `integration`, `business_hours`, `staff`, `go_live`.

### `calls.json`
Two weeks of inbound calls, one object per call record.

| Field | Description |
|---|---|
| `call_id` | Our ID for the call record, assigned at ingestion |
| `telephony_sid` | The phone provider's ID for the call |
| `customer_id` | Joins to `customers.json` |
| `direction` | Always `inbound` here |
| `started_at` | ISO 8601 timestamp when the call started |
| `duration_sec` | Call length in seconds |
| `caller_name`, `caller_phone_last4` | Caller details (synthetic) |
| `intent_tag` | Set automatically by the intent classifier after the call |
| `outcome` | What the agent recorded at the end of the call: `booked`, `rescheduled`, `cancelled`, `resolved`, `transferred` or `abandoned` |
| `transferred` | Whether the call was handed to a human |
| `appointment_id` | Our appointment ID, set when the call booked, moved or cancelled an appointment |
| `transcript` | Agent and caller turns |
| `ingested_at` | When the record reached our pipeline |

### `integration.log`
Logs from the integration services: booking-system writes (`booking-sync`), booking-system authentication (`booking-auth`), the nightly availability sync (`avail-sync`) and call ingestion (`call-ingest`). One line per event: timestamp, level, service, then `key=value` pairs.
