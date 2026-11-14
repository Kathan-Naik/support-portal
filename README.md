# Support portal for the AI phone agent

A web app with two roles: support staff (Admin) and clients (User).

- **Admins** have four sections: **Overview**, **Tickets** (every conversation with a client, including draft replies and internal notes), **Logs & Alerts** (alerts from the detectors, integration logs, calls) and **Debug bot** (a Pi agent on Fireworks that can investigate the data).
- **Clients** have two: **Home** (status and their open tickets) and **Tickets**, where they open a ticket with evidence (example calls, when it started, screenshots) and read our replies. Clients never see calls or logs.

All messages between support and a client live on tickets. To write to a client first, an admin opens a ticket for them.

The app ships with seed data built from the exercise files, including the Sunrise Dental booking failure.

```
app/            the portal (Node + SQLite API, React client)
design/         design-system.html and high-level-design.html (open in a browser)
requirements/   the original exercise brief and data
```

## Requirements

- **Node.js 22.18 or later.** Check with `node -v`. The server runs TypeScript directly and uses the built-in `node:sqlite`, so older versions will not start it.
- **npm** (comes with Node).
- Internet access for `npm install`.
- Optional: a **Fireworks API key** for the debug bot. Everything else works without it.

No database server, Docker or native build tools are needed.

## Quick start

```sh
cd app
npm install
npm run seed
npm run build
npm start
```

Open **http://localhost:8787** and sign in. The login page has one-click buttons for both accounts.

| Account | Email | Password |
| --- | --- | --- |
| Support admin | `admin@support.example` | `demo1234` |
| Client: Sunrise Dental, whose bookings stopped saving | `frontdesk@sunrisedental.example` | `demo1234` |

Sign in as the Sunrise Dental client to see the outage from the client's side, and as the admin to see the alerts and ticket behind it. On a ticket, **Investigate with debug bot** starts an investigation tied to it; **Add findings to SUP-xxxx** has the bot write an internal note and a draft reply there.

## Turn on the debug bot

1. Copy the example config in `app/`:

   ```sh
   cp .env.example .env          # macOS, Linux, Git Bash
   Copy-Item .env.example .env   # Windows PowerShell
   ```

2. Put your key in `app/.env`:

   ```
   FIREWORKS_API_KEY=fw_your_key_here
   ```

3. Restart the server (`npm start`, or `npm run dev`).

The server prints `Debug bot: ready (fireworks ...)` when it has the key. In the app, go to **Debug bot** as an admin. The model picker lists the chat models your Fireworks key can use; the default is Kimi K3. Set `PI_MODEL` in `.env` to change the default.

The bot can read all portal data, link and update alerts, open tickets, add internal ticket notes, and save draft replies on tickets. When it has enough evidence it proposes a ticket; the **Create ticket** button asks it to open it, and **Open SUP-xxxx** takes you there. It cannot send anything to a client; drafts wait on the ticket until an admin sends them.

## Develop

```sh
cd app
npm run dev
```

This starts the API on port 8787 (restarts on server changes) and Vite on port 5173 (hot reload). Open **http://localhost:5173**; Vite forwards `/api` to the API.

## Configuration

All settings live in `app/.env` (copy from `app/.env.example`). None are required.

| Variable | Default | What it does |
| --- | --- | --- |
| `FIREWORKS_API_KEY` | not set | Enables the debug bot |
| `PI_MODEL` | `accounts/fireworks/models/kimi-k3` | Default model for the bot. Any Fireworks chat model id; the bot page lists the ones your key can use |
| `PORT` | `8787` | API port (and the app's port after `npm run build`) |
| `DB_PATH` | `data/portal.db` | Where the SQLite file lives |
| `SEED_DATA_DIR` | `seed/data` | Where `npm run seed` reads the exercise files |
| `SEED_PASSWORD` | `demo1234` | Password given to every seeded account |

## Commands

Run from `app/`.

| Command | What it does |
| --- | --- |
| `npm run seed` | Rebuild `data/portal.db` from scratch: load the data, run the detectors, create users and two tickets (one with a draft reply), and link alerts to them |
| `npm run build` | Build the React client into `dist/` |
| `npm start` | Run the app on `PORT`, serving `dist/` and the API |
| `npm run dev` | API with auto-restart plus Vite with hot reload |
| `npm run typecheck` | Type-check server and client |

To reset everything you changed in the app, stop the server and run `npm run seed` again.

## Troubleshooting

| You see | Do this |
| --- | --- |
| `No database at ... Run "npm run seed" first.` | Run `npm run seed` in `app/`. |
| A syntax error on a `.ts` file, or `node:sqlite` not found | Node is too old. Install Node 22.18 or later. |
| `EADDRINUSE` on 8787 or 5173 | Something else is using the port. Stop it, or set `PORT` in `app/.env`. |
| The page at :8787 shows `404 Not Found` | The client is not built. Run `npm run build`, then `npm start`. |
| The bot replies `404 ... Model not found, inaccessible, and/or not deployed` | The key is wrong, or that model is not on your account. Check the key, then try another model in the picker. |
| The bot page says `Needs FIREWORKS_API_KEY` | Add the key to `app/.env` and restart the server. |
| `npm install` warns about `allow-scripts` for esbuild or protobufjs | Safe to ignore; the build works without those install scripts. |
| `database is locked` or sync conflicts | The repo is in a synced folder (OneDrive, Dropbox). Set `DB_PATH` to a folder outside it, for example `DB_PATH=C:/temp/portal.db`, then run `npm run seed`. |

## More

- `app/README.md`: code layout, access rules and how the bot is wired.
- `design/high-level-design.html`: the portal in eleven diagrams, including how the bot uses Pi and its 13 tools.
- `design/design-system.html`: the Dusk design system the app uses.

Both docs are also linked inside the app, under **About this build** next to Sign out (served at `/docs/...`).
