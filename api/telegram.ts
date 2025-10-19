// /api/telegram.ts
// Comments: English only. Vercel Edge Function style.

export const config = { runtime: "edge" };

const TG_TOKEN  = process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN || "";
const TG_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";

async function tg(method: string, payload: unknown) {
  if (!TG_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

export default async function handler(req: Request): Promise<Response> {
  // GET → healthcheck
  if (req.method === "GET") return new Response("ok");

  // Secret header check (must match setWebhook secret_token)
  if (TG_SECRET) {
    const sec = req.headers.get("x-telegram-bot-api-secret-token");
    if (sec !== TG_SECRET) return new Response("forbidden", { status: 403 });
  }

  let update: any = {};
  try { update = await req.json(); } catch { return new Response("ok"); }

  const msg = update.message || update.edited_message || update.channel_post || null;
  const chatId = msg?.chat?.id;
  const text = (msg?.text ?? msg?.caption ?? "").trim();

  // quick smoke-reply so you see it works
  if (chatId && text) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: `Jarvis online: "${text.slice(0, 200)}"`,
      reply_to_message_id: msg?.message_id,
      message_thread_id: msg?.message_thread_id ?? undefined, // forum threads support
    });
  }

  return new Response("ok");
}
