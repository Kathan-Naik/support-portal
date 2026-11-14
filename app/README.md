# Support portal

A support portal for the AI phone agent, with two roles:

- **Admin (internal), four sections:** Overview; Tickets (every client conversation: replies, draft replies, internal notes); Logs & Alerts (alerts with analysis and the ticket handling each, integration logs, the call explorer); and a **debug bot** (a Pi agent on Fireworks) with full read access.
- **Client, two sections:** Home (status, open tickets, latest reply) and Tickets (open one with evidence: example calls, when it started, attachments; read replies, unread counts). Calls and logs are admin-only.

Every message between support and a client is a `ticket_messages` row. Drafts (`status = 'draft'`) and internal notes (`internal = 1`) are never returned to a client; a sent support reply records `read_at` when the client opens the ticket. To write to a client first, an admin opens a ticket for them, optionally as a draft.

Seed data is the real exercise data (`seed/data`: 302 calls, 913 log lines, 3 customers), plus the alerts, tickets and draft reply that came out of debugging it. The design is the Dusk system from `../design/`.

## Run it

Needs Node 22.18 or later (TypeScript runs natively, SQLite is `node:sqlite`; no native modules).

```sh
npm install
cp .env.example .env      # add FIREWORKS_API_KEY to enable the debug bot
npm run seed              # builds data/portal.db from seed/data
npm run build && npm start   # http://localhost:8787
# or, while developing:
npm run dev               # API on :8787 with --watch, Vite on http://localhost:5173
```

Two seeded accounts, password `demo1234` (the login page has one-click buttons):

| Account | Email |
| --- | --- |
| Support admin | admin@support.example |
| Client: Sunrise Dental (bookings failing) | frontdesk@sunrisedental.example |

Lakeside Auto Service and Maple Hair Studio have calls and alerts but no login.

`npm run seed` rebuilds the database from scratch every time.

## Layout

```
server/
  index.ts         Hono app: auth routes, mounts the API, serves dist/
  env.ts           loads .env
  db.ts            node:sqlite connection, a read-only connection for the bot, helpers
  schema.sql       every table, with comments
  auth.ts          scrypt passwords, cookie sessions, requireUser/requireAdmin, client scoping
  detect.ts        derives write status, duplicates, local time; runs the 7 detectors that produce flags
  routes/data.ts   overview, customers, calls, logs, alerts (flags), users, audit
  routes/support.ts tickets, replies, drafts (edit, send, discard), read receipts
  routes/bot.ts    bot sessions and the streaming chat endpoint (Server-Sent Events)
  bot/agent.ts     Pi Agent setup: Fireworks model, system prompt, event streaming, persistence
  bot/tools.ts     the bot's 13 tools
scripts/seed.ts    loads seed/data, runs detectors, writes users and tickets, links alerts
  server/tickets.ts  createTicket() and evidence cleaning, shared by the API and the bot
  server/attachments.ts  evidence files: type and size checks, stored in data/uploads, served only to people who can see the message
client/src/        React app (Vite): admin and client shells, pages, Dusk styles
```

## Access rules

- Every API route checks the session. Admin-only routes use `requireAdmin`.
- For a client, every query is pinned to their own `customer_id` on the server (`scopeCustomer`), whatever the request asks for. Internal tickets, internal notes, drafts, logs and alerts are never returned to a client.
- The debug bot runs only for admins. Its SQL tool uses a separate read-only SQLite connection. Its write tools are internal only (alerts, tickets it opens, internal notes, draft replies). It cannot send anything to a client: drafts wait on the ticket for a person. Every tool call is written to `audit_log`.

## Debug bot

Built on `@mariozechner/pi-agent-core` (the agent loop, tool execution, events) and `@mariozechner/pi-ai` (the Fireworks provider, which reads `FIREWORKS_API_KEY`). Each chat turn rebuilds an `Agent` from the session's stored messages, streams text, reasoning and tool calls to the browser over SSE, and saves the new messages when the turn ends. Pick the model on the bot page or set `PI_MODEL`.

Tools: `describe_schema`, `sql_query`, `search_logs`, `get_call`, `list_flags`, `get_flag`, `get_ticket`, `rerun_detectors`, `update_flag`, `add_internal_note`, `draft_reply`, `propose_ticket`, `create_ticket`.

`propose_ticket` creates nothing: it puts a proposal card on the bot page. **Create ticket** asks the bot to call `create_ticket`, which opens the ticket (internal when no client), writes the findings as an internal note, links the alerts and can save a draft reply. The stream returns the new key, and the page shows **Open SUP-xxxx** at once.

Context is managed with Pi's own compaction from `@mariozechner/pi-coding-agent` (`calculateContextTokens`, `estimateTokens`, `shouldCompact`, `generateSummary`, the `compactionSummary` message and `convertToLlm`), in `server/bot/compaction.ts`:

- Before a turn, a saved history near the limit is summarised and saved shorter.
- During a turn, pi-agent-core's `transformContext` hook compacts what the model sees, cached so a long tool loop summarises once.
- If the provider still reports overflow (pi-ai `isContextOverflow`), the history is compacted once and the turn continues with `agent.continue()`.
- Defaults are Pi's (keep about 20k recent tokens, reserve 16k). `BOT_CONTEXT_WINDOW`, `BOT_KEEP_RECENT_TOKENS` and `BOT_RESERVE_TOKENS` override them; a small window is a quick way to watch it happen. The bot page shows a context meter and an "Earlier turns summarised" marker you can open.

Fireworks adds models faster than pi-ai's catalog, so `resolveModel()` accepts any Fireworks model id, and the picker lists the chat models your key can use.
