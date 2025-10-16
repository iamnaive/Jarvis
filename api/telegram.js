import { Telegraf } from "telegraf";

const bot = new Telegraf(process.env.BOT_TOKEN);

async function askLLM(prompt) {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5-instant", 
      input: prompt,
    }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`LLM error: ${r.status} ${text}`);
  }
  const data = await r.json();
  const out =
    data.output_text ??
    data.output?.[0]?.content?.[0]?.text ??
    "";
  return out || "Извини, я не смог сформировать ответ.";
}

bot.on("text", async (ctx) => {
  const msg = ctx.message?.text ?? "";
  if (!msg) return;
  await ctx.sendChatAction("typing");
  try {
    const answer = await askLLM(msg);
    await ctx.reply(answer, { reply_to_message_id: ctx.message.message_id });
  } catch (e) {
    console.error(e);
    await ctx.reply("Oops");
  }
});

// Vercel serverless webhook endpoint
export default async function handler(req, res) {
  if (req.method === "GET") {
    
    res.status(200).send("ok");
    return;
  }
  
  const h = bot.webhookCallback("/api/telegram");
  return h(req, res);
}
