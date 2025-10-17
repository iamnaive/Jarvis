// api/telegram.js — Telegram bot on Vercel with diagnostics & 9s timeout.
// Env: BOT_TOKEN, OPENAI_API_KEY, MODEL_ID (e.g. gpt-4o-mini or gpt-5), SYSTEM_PROMPT (optional)

import { Telegraf } from "telegraf";

const bot = new Telegraf(process.env.BOT_TOKEN);
const MODEL_ID = process.env.MODEL_ID || "gpt-4o-mini";
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  "You are an assistant. Always reply in concise, natural English. Do not switch languages.";

// ---- fetch with 9s timeout (fits Vercel Hobby limit)
async function fetchWithTimeout(url, options = {}, ms = 9000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

function buildPrompt(userText) {
  const englishRule =
    "Always respond in English. Do not switch languages, even if the user writes in another language.";
  return [
    `System: ${SYSTEM_PROMPT}\n${englishRule}`,
    `User: ${userText}`,
    "Assistant:"
  ].join("\n");
}

async function askLLM(userText) {
  const prompt = buildPrompt(userText);

  const res = await fetchWithTimeout(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: MODEL_ID, input: prompt }),
    },
    9000
  );

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
  const out = data.output_text ?? data.output?.[0]?.content?.[0]?.text ?? "";
  return out || "I couldn't produce a response.";
}

// Log updates (see Vercel → Deployments → Logs)
bot.use(async (ctx, next) => {
  console.log("update kind:", ctx.updateType);
  return next();
});

bot.start((ctx) =>
  ctx.reply("Ready. I answer in English. Try: !diag, !test, or send a message.")
);

bot.help((ctx) =>
  ctx.reply("Commands: /start, /help, /id, !diag, !test, !echo <text>")
);

bot.command("id", (ctx) =>
  ctx.reply(`Your user_id: ${ctx.from?.id}\nChat_id: ${ctx.chat?.id}`)
);

// Diagnostics & echo
bot.on("text", async (ctx) => {
  const msg = ctx.message?.text ?? "";
  if (!msg) return;

  if (msg === "!diag") {
    const hasKey = Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.startsWith("sk-"));
    const tail = hasKey ? process.env.OPENAI_API_KEY.slice(-6) : "none";
    const info =
      `Model: ${MODEL_ID}\n` +
      `OPENAI_API_KEY: ${hasKey ? `present (…${tail})` : "missing/invalid"}\n` +
      `System prompt: ${SYSTEM_PROMPT.slice(0, 60)}${SYSTEM_PROMPT.length > 60 ? "..." : ""}`;
    return ctx.reply(info, { reply_to_message_id: ctx.message.message_id });
  }

  if (msg === "!test") {
    try {
      const out = await askLLM("Say 'OK' if you received this.");
      return ctx.reply(out, { reply_to_message_id: ctx.message.message_id });
    } catch (e) {
      const t = typeof e?.message === "string" ? e.message : "Unknown error";
      return ctx.reply(`TEST FAIL: ${t}`, { reply_to_message_id: ctx.message.message_id });
    }
  }

  if (msg.startsWith("!echo ")) {
    return ctx.reply(msg.slice(6), { reply_to_message_id: ctx.message.message_id });
  }

  // Normal AI flow
  try {
    await ctx.sendChatAction("typing");
    const answer = await askLLM(msg);
    await ctx.reply(answer, { reply_to_message_id: ctx.message.message_id });
  } catch (e) {
    console.error("Handler error:", e);
    const t = typeof e?.message === "string" ? e.message : "Unknown error";
    if (t.includes("429")) {
      await ctx.reply("Oops: API quota exceeded. Check Billing (platform.openai.com → Billing).");
    } else if (t.includes("model_not_found")) {
      await ctx.reply("Oops: model not found. Set MODEL_ID to a model you have access to (e.g. gpt-4o-mini).");
    } else if (t.toLowerCase().includes("abort") || t.toLowerCase().includes("signal")) {
      await ctx.reply("Oops: model timed out (<9s). Please try again or shorten the message.");
    } else if (t.includes("401")) {
      await ctx.reply("Oops: invalid API key. Update OPENAI_API_KEY in Vercel env and redeploy.");
    } else {
      await ctx.reply(`Oops: ${t}`);
    }
  }
});

export default async function handler(req, res) {
  if (req.method === "GET") return res.status(200).send("ok");
  const h = bot.webhookCallback("/api/telegram");
  return h(req, res);
}
