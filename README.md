# Task Manager

Personal task manager planned in 2-week sprints (start/due sprint, hour estimates) with Board / List-by / Gantt / Scrum / Boss views and drag & drop, styled to the Polygon Technology brand guideline. Claude manages tasks through the MCP endpoint at `/mcp` and books time on Google Calendar.

## Structure
```
db/schema.sql      tables + trigger (last-updated, sprint-moved count)
src/sprint.js      2-week Gregorian sprints (S01 = 1–14 Jan), shared with the browser
src/service.js     all task/category rules (used by API and MCP)
src/server.js      Express: REST API, static UI, /mcp
src/mcp.js         Claude connector tools
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
