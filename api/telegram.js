// Telegram AI bot on Vercel with System Prompt + English-only + optional chat memory via Upstash Redis.
// Env (Vercel → Project → Settings → Environment Variables):
//   BOT_TOKEN                - Telegram bot token (from @BotFather)
//   OPENAI_API_KEY           - OpenAI API key (sk-...)
//   MODEL_ID                 - e.g. "gpt-4o-mini" or "gpt-5" (if available)
//   SYSTEM_PROMPT            - global role, e.g. "Always reply in concise, natural English..."
//   UPSTASH_REDIS_REST_URL   - optional, for chat memory
//   UPSTASH_REDIS_REST_TOKEN - optional, for chat memory
//
// Route: /api/telegram  (webhook target)
// Notes:
// - Replies are always in English (hard rule inside prompt).
// - Commands: /start, /help, /id, /context, /clear
// - If Upstash vars are unset, the bot will work without memory.

import { Telegraf } from "telegraf";

const bot = new Telegraf(process.env.BOT_TOKEN);
const MODEL_ID = process.env.MODEL_ID || "gpt-4o-mini";
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  "You are an assistant. Always reply in concise, natural English. Do not switch languages.";

// ---- Upstash Redis (optional) ----
const UPS_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const UPS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

async function redisCmd(cmd, ...args) {
  if (!UPS_URL || !UPS_TOKEN) return null;
  const body = { command: [cmd, ...args] };
  const r = await fetch(UPS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.error("Upstash error:", r.status, t);
    return null;
  }
  const data = await r.json().catch(() => ({}));
  return data?.result ?? null;
}

const MAX_TURNS = 8; // number of user/assistant pairs to keep
const memKey = (chatId) => `tg:ctx:v1:${chatId}`;

async function memPush(chatId, role, text) {
  if (!UPS_URL || !UPS_TOKEN) return;
  const key = memKey(chatId);
  await redisCmd("RPUSH", key, JSON.stringify({ role, text }));
  await redisCmd("LTRIM", key, String(-MAX_TURNS * 2), "-1");
}

async function memGet(chatId) {
  if (!UPS_URL || !UPS_TOKEN) return [];
  const key = memKey(chatId);
  const arr = (await redisCmd("LRANGE", key, "0", "-1")) || [];
  return arr
    .map((s) => {
      try { return JSON.parse(s); } catch { return null; }
    })
    .filter(Boolean);
}

async function memClear(chatId) {
  if (!UPS_URL || !UPS_TOKEN) return;
  await redisCmd("DEL", memKey(chatId));
}

// ---- Prompt building ----
// We enforce English-only and include global/system + per-chat context + recent turns.
function buildPrompt({ systemGlobal, systemPerChat, history, userText }) {
  const englishRule =
    "Always respond in English. Do not switch languages, even if the user writes in another language.";
  const histTxt = (history || [])
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
    .join("\n");
  return [
    `System: ${systemGlobal}\n${englishRule}`.trim(),
    systemPerChat ? `System: [CHAT-CONTEXT] ${systemPerChat}` : null,
    histTxt || null,
    `User: ${userText}`,
    `Assistant:`
  ].filter(Boolean).join("\n");
}

// ---- OpenAI Responses API ----
async function askLLM({ prompt }) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL_ID,
      input: prompt
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("LLM error:", res.status, text);
    let msg = `LLM error ${res.status}`;
    try {
      const j = JSON.parse(text);
      if (j?.error?.message) msg += `: ${j.error.message}`;
    } catch {}
    throw new Error(msg);
  }

  const data = await res.json().catch(() => ({}));
  const out =
    data.output_text ??
    data.output?.[0]?.content?.[0]?.text ??
    "";
  return out || "I couldn't produce a response.";
}

// ---- Commands ----
bot.start(async (ctx) => {
  await ctx.reply(
    "Ready. Send a message — I’ll reply in English using the configured context.\nCommands: /context, /clear, /id, /help"
  );
});

bot.help(async (ctx) => {
  await ctx.reply(
    "I answer in English.\n/context — show or set per-chat context\n/context set <text> — set chat context (overrides global)\n/clear — clear chat history\n/id — show your user/chat IDs"
  );
});

bot.command("id", async (ctx) => {
  await ctx.reply(`Your user_id: ${ctx.from?.id}\nChat_id: ${ctx.chat?.id}`);
});

bot.command("clear", async (ctx) => {
  await memClear(ctx.chat.id);
  await ctx.reply("Context cleared.");
});

bot.command("context", async (ctx) => {
  const text = ctx.message?.text || "";
  const [, ...rest] = text.split(" ");
  const sub = (rest[0] || "").toLowerCase();

  if (sub === "set") {
    const custom = rest.slice(1).join(" ").trim();
    if (!custom) {
      await ctx.reply("Usage: /context set <system prompt text>");
      return;
    }
    await memClear(ctx.chat.id);
    // Store per-chat "system" as first memory entry (marker role "system")
    await memPush(ctx.chat.id, "system", custom);
    await ctx.reply("Okay, chat context updated.");
  } else {
    const h = await memGet(ctx.chat.id);
    const sys = h.find((m) => m.role === "system")?.text;
    await ctx.reply(`Current context:\n${sys || SYSTEM_PROMPT}`);
  }
});

// ---- Main text handler ----
bot.on("text", async (ctx) => {
  const userText = ctx.message?.text ?? "";
  if (!userText) return;
  try {
    const raw = await memGet(ctx.chat.id);
    const perChatSystem = raw.find((m) => m.role === "system")?.text || null;
    const turns = raw.filter((m) => m.role !== "system");

    await ctx.sendChatAction("typing");

    const prompt = buildPrompt({
      systemGlobal: SYSTEM_PROMPT,
      systemPerChat: perChatSystem,
      history: turns,
      userText
    });

    const answer = await askLLM({ prompt });

    await memPush(ctx.chat.id, "user", userText);
    await memPush(ctx.chat.id, "assistant", answer);

    await ctx.reply(answer, { reply_to_message_id: ctx.message.message_id });
  } catch (e) {
    console.error("Handler error:", e);
    const t = typeof e?.message === "string" ? e.message : "Unknown error";
    await ctx.reply(`Oops: ${t}`);
  }
});

// ---- Vercel webhook entry ----
export default async function handler(req, res) {
  if (req.method === "GET") {
    res.status(200).send("ok");
    return;
  }
  const h = bot.webhookCallback("/api/telegram");
  return h(req, res);
}
