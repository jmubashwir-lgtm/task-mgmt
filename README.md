# Task Manager

Personal task manager planned in 2-week sprints (start/due sprint, hour estimates) with Board / List-by / Gantt / Scrum / Boss views and drag & drop, styled to the Polygon Technology brand guideline. Claude manages tasks through the MCP endpoint at `/mcp` and books time on Google Calendar.

## Structure
```
db/schema.sql      tables + trigger (last-updated, sprint-moved count)
src/sprint.js      Mon–Fri 2-week sprints anchored on 14 Sep 2026, shared with the browser
src/service.js     all task/category rules (used by API and MCP)
src/server.js      Express: REST API, static UI, /mcp
src/mcp.js         Claude connector tools
src/telegram.js    Boss chat in Telegram (check-ins out, replies answered by Claude)
public/            UI (vanilla JS + SortableJS)
docs/              Claude Project instructions
```

## Run locally
```
npm install
DATABASE_URL=postgres://... DATABASE_SSL=false npm run dev
```

## Deploy
1. Supabase: new project → Connect → **Session pooler** connection string.
2. Render: New → Blueprint → this repo → set `DATABASE_URL`.
3. Claude: Settings → Connectors → Add custom connector → `https://<app>.onrender.com/mcp`.

## Boss in Telegram (optional)
1. Telegram: message **@BotFather** → `/newbot` → copy the bot token.
2. Render → Environment: add `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` (any long random string) and `ANTHROPIC_API_KEY` (console.anthropic.com; pays for replies). Optional: `ANTHROPIC_MODEL`.
3. Open `https://<app>.onrender.com/telegram/setup?key=<TELEGRAM_WEBHOOK_SECRET>` once.
4. Message your bot. It replies with your chat id → add it as `TELEGRAM_CHAT_ID` in Render.
5. Scheduled check-ins call the `send_message` tool; your replies in Telegram are answered by the boss, who updates tasks.
