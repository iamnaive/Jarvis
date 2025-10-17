// api/telegram.js — Telegram bot on Vercel with hard timeout & clear errors.
// Env: BOT_TOKEN, OPENAI_API_KEY, MODEL_ID (e.g. gpt-4o-mini or gpt-5), SYSTEM_PROMPT (optional)

import { Telegraf } from "telegraf";

const bot = new Telegraf(process.env.BOT_TOKEN);
const MODEL_ID = process.env.MODEL_ID || "gpt-4o-mini";
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  "You are an assistant. Always reply in concise, natural English. Do not switch languages.";

// --- fetch with timeout (prevents hanging “typing...”)
async function fetchWithTimeout(url, options = {}, ms = 12000) {
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
    12000 // 12s hard timeout to fit Vercel limits
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

// Log updates to see activity in Vercel logs
bot.use(async (ctx, next) => {
  console.log("update kind:", ctx.updateType);
  return next();
});

bot.start((ctx) =>
  ctx.reply("Ready. I will answer in English. Try sending: ping")
);

bot.help((ctx) =>
  ctx.reply("Commands: /start, /help, /id, or just send a text message.")
);

bot.command("id", (ctx) =>
  ctx.reply(`Your user_id: ${ctx.from?.id}\nChat_id: ${ctx.chat?.id}`)
);

// Quick echo to verify delivery path (type: !echo hello)
bot.on("text", async (ctx) => {
  const msg = ctx.message?.text ?? "";
  if (!msg) return;

  // Debug escape hatch
  if (msg.startsWith("!echo ")) {
    return ctx.reply(msg.slice(6), { reply_to_message_id: ctx.message.message_id });
  }

  try {
    await ctx.sendChatAction("typing");
    const answer = await askLLM(msg);
    await ctx.reply(answer, { reply_to_message_id: ctx.message.message_id });
  } catch (e) {
    console.error("Handler error:", e);
    const t = typeof e?.message === "string" ? e.message : "Unknown error";
    // Distinguish common cases
    if (t.includes("429")) {
      await ctx.reply(
        "Oops: API quota exceeded. Please enable/pay billing on platform.openai.com → Billing, then try again."
      );
    } else if (t.includes("The user aborted a request") || t.includes("signal")) {
      await ctx.reply(
        "Oops: model timed out. Please try again (I use a 12s timeout to avoid hanging)."
      );
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
