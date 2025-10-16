// api/telegram.js
// Telegram webhook on Vercel (Node 20). Env: BOT_TOKEN, OPENAI_API_KEY, MODEL_ID (optional)
import { Telegraf } from "telegraf";

const bot = new Telegraf(process.env.BOT_TOKEN);
const MODEL_ID = process.env.MODEL_ID || "gpt-4o-mini"; // set in Vercel

async function askLLM(prompt) {
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

  // Если ошибка — считываем тело, логируем и пробрасываем наружу
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("LLM error:", res.status, text);
    // Попробуем вытащить message из JSON, чтобы отдать в чат (для дебага)
    let msg = `LLM error ${res.status}`;
    try {
      const j = JSON.parse(text);
      msg += j?.error?.message ? `: ${j.error.message}` : "";
    } catch {}
    throw new Error(msg);
  }

  const data = await res.json().catch(() => ({}));
  const out =
    data.output_text ??
    data.output?.[0]?.content?.[0]?.text ??
    "";
  return out || "Не смог сформировать ответ.";
}

bot.start(async (ctx) => {
  await ctx.reply("Я готов. Напиши сообщение — отвечу с помощью модели.");
});

bot.help(async (ctx) => {
  await ctx.reply("Просто напиши текст — я отвечу. Команды: /start, /help, /id");
});

bot.command("id", async (ctx) => {
  await ctx.reply(`Ваш Telegram user_id: ${ctx.from?.id}`);
});

bot.on("text", async (ctx) => {
  const msg = ctx.message?.text ?? "";
  if (!msg) return;
  await ctx.sendChatAction("typing");
  try {
    const answer = await askLLM(msg);
    await ctx.reply(answer, { reply_to_message_id: ctx.message.message_id });
  } catch (e) {
    console.error("Handler error:", e);
    // Покажем короткую ошибку прямо в чат, чтобы сразу было видно, что не так
    const text = typeof e?.message === "string" ? e.message : "Unknown error";
    await ctx.reply(`Oops: ${text}`);
  }
});

export default async function handler(req, res) {
  if (req.method === "GET") {
    res.status(200).send("ok");
    return;
  }
  const h = bot.webhookCallback("/api/telegram");
  return h(req, res);
}
