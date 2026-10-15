// Telegram boss chat.
// Out: the boss sends check-ins to Jawad's Telegram (send_message MCP tool, used by scheduled check-ins).
// In:  Jawad replies in Telegram -> Telegram calls POST /telegram/webhook -> we ask Claude (Anthropic API),
//      giving it the same Task Manager tools as the /mcp connector -> the boss replies in Telegram.
//
// Env vars (all set in Render):
//   TELEGRAM_BOT_TOKEN       from @BotFather
//   TELEGRAM_CHAT_ID         Jawad's chat id (the bot tells you it if you message it before this is set)
//   TELEGRAM_WEBHOOK_SECRET  any long random string; protects the webhook and the setup link
//   ANTHROPIC_API_KEY        from console.anthropic.com (needed for replies only)
//   ANTHROPIC_MODEL          optional, default claude-sonnet-4-5
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { pool } = require('./db');
const boss = require('./boss');
const svc = require('./service');

const env = (k) => process.env[k] || '';
const configured = () => !!(env('TELEGRAM_BOT_TOKEN') && env('TELEGRAM_CHAT_ID'));

// ---------- Telegram API ----------
async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env('TELEGRAM_BOT_TOKEN')}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description}`);
  return j.result;
}

// Telegram caps a message at 4096 characters.
async function sendRaw(chatId, text) {
  for (let i = 0; i < text.length; i += 4000) await tg('sendMessage', { chat_id: chatId, text: text.slice(i, i + 4000) });
}

const save = (role, content) => pool.query('INSERT INTO chat_messages (role, content) VALUES ($1, $2)', [role, content]);

// Boss -> Jawad. Saved to history so the boss knows what it said when he replies.
async function sendMessage(text) {
  if (!configured()) throw new Error('Telegram is not set up (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing)');
  await sendRaw(env('TELEGRAM_CHAT_ID'), text);
  await save('assistant', text);
  return { sent: true };
}

// ---------- Claude (the boss brain for replies) ----------
// Last 24 hours of chat, shaped the way the Anthropic API wants (alternating roles, user first).
async function history() {
  const { rows } = await pool.query(
    `SELECT role, content FROM chat_messages WHERE created_at > now() - interval '24 hours' ORDER BY id DESC LIMIT 40`);
  const msgs = [];
  for (const m of rows.reverse()) {
    const last = msgs[msgs.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else msgs.push({ role: m.role, content: m.content });
  }
  if (msgs[0]?.role === 'assistant') msgs.unshift({ role: 'user', content: '(Boss check-in follows.)' });
  return msgs;
}

async function claude(body) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Anthropic API: ${j.error?.message || r.status}`);
  return j;
}

// Run one boss reply: Claude may call Task Manager tools several times, then answers in text.
async function bossReply() {
  const { buildServer } = require('./mcp');   // required here to avoid a circular import
  const server = buildServer();
  const client = new Client({ name: 'telegram-boss', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const tools = (await client.listTools()).tools
      .filter((t) => t.name !== 'send_message')   // the reply goes back automatically
      .map((t) => ({ name: t.name, description: t.description || t.title || t.name, input_schema: (({ $schema, ...rest }) => rest)(t.inputSchema) }));
    const system = `${boss.persona(svc.WORK_START, svc.WORK_END)}

You are talking to Jawad in Telegram. Call get_today before judging him if you haven't this turn.
Store everything he tells you with the tools (complete_task, update_task with "reason" for every slip, record_ceremony, etc.). Never invent his answers or reasons.
Write plain text only (no markdown, no tables): Telegram shows it raw. Keep it short and ask one question at a time.`;
    const messages = await history();
    for (let step = 0; step < 12; step++) {
      const res = await claude({ model: env('ANTHROPIC_MODEL') || 'claude-sonnet-4-5', max_tokens: 1500, system, tools, messages });
      messages.push({ role: 'assistant', content: res.content });
      const calls = res.content.filter((c) => c.type === 'tool_use');
      if (res.stop_reason !== 'tool_use' || !calls.length) {
        return res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
      }
      const results = [];
      for (const c of calls) {
        const out = await client.callTool({ name: c.name, arguments: c.input }).catch((e) => ({ isError: true, content: [{ type: 'text', text: e.message }] }));
        results.push({ type: 'tool_result', tool_use_id: c.id, is_error: !!out.isError,
          content: (out.content || []).map((x) => x.text || '').join('\n') || '(no output)' });
      }
      messages.push({ role: 'user', content: results });
    }
    return 'I ran out of steps working that out. Say it again, shorter.';
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

// ---------- webhook ----------
// One message at a time, in order, so replies never overlap.
let queue = Promise.resolve();
const seen = new Set();

async function handleUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg?.text) return;
  const chatId = String(msg.chat.id);
  if (!env('TELEGRAM_CHAT_ID')) {   // first-time setup helper
    return sendRaw(chatId, `Your chat id is ${chatId}. Put it in Render as TELEGRAM_CHAT_ID, then message me again.`);
  }
  if (chatId !== env('TELEGRAM_CHAT_ID')) return;   // ignore strangers
  if (msg.text === '/start') return sendRaw(chatId, 'Boss line open. Check-ins will come here. Reply any time.');
  await save('user', msg.text);
  if (!env('ANTHROPIC_API_KEY')) return sendRaw(chatId, 'Replies are not switched on yet (ANTHROPIC_API_KEY missing in Render).');
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  try {
    const text = await bossReply();
    if (text) await sendMessage(text);
  } catch (e) {
    console.error('Telegram boss error', e);
    await sendRaw(chatId, `Boss is offline: ${e.message}`).catch(() => {});
  }
}

function webhook(req, res) {
  if (!env('TELEGRAM_WEBHOOK_SECRET') || req.get('X-Telegram-Bot-Api-Secret-Token') !== env('TELEGRAM_WEBHOOK_SECRET')) {
    return res.status(401).end();
  }
  res.status(200).end();   // answer Telegram at once; work happens after
  const u = req.body || {};
  if (seen.has(u.update_id)) return;   // Telegram resends if we were slow
  seen.add(u.update_id); if (seen.size > 500) seen.delete(seen.values().next().value);
  queue = queue.then(() => handleUpdate(u)).catch((e) => console.error('Telegram update failed', e));
}

// Open https://<app>/telegram/setup?key=<TELEGRAM_WEBHOOK_SECRET> once to connect the bot to this app.
async function setup(req, res) {
  if (!env('TELEGRAM_WEBHOOK_SECRET') || req.query.key !== env('TELEGRAM_WEBHOOK_SECRET')) return res.status(401).send('Wrong or missing key');
  if (!env('TELEGRAM_BOT_TOKEN')) return res.status(400).send('TELEGRAM_BOT_TOKEN is not set in Render');
  try {
    const url = `https://${req.get('host')}/telegram/webhook`;
    await tg('setWebhook', { url, secret_token: env('TELEGRAM_WEBHOOK_SECRET'), allowed_updates: ['message', 'edited_message'] });
    res.send(`Webhook set to ${url}. Now message your bot in Telegram.`);
  } catch (e) { res.status(500).send(e.message); }
}

module.exports = { sendMessage, webhook, setup, configured };
