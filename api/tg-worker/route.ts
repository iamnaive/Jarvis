// Comments: English only.
export const runtime = "edge";

const TG_TOKEN  = process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN || "";
const TG_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";

async function tg(method: string, payload: unknown) {
  if (!TG_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(()=>{});
}

export async function GET() {
  return new Response("ok");
}

export async function POST(req: Request) {
  // Optional secret check (включится, когда задашь переменную)
  if (TG_SECRET) {
    const sec = req.headers.get("x-telegram-bot-api-secret-token");
    if (sec !== TG_SECRET) return new Response("forbidden", { status: 403 });
  }

  let update: any = {};
  try { update = await req.json(); } catch { return new Response("ok"); }

  const msg = update.message || update.edited_message || update.channel_post || null;
  const chatId = msg?.chat?.id;
  const text = (msg?.text ?? msg?.caption ?? "").trim();
  if (!chatId) return new Response("ok");

  // Quick sanity reply — чтобы проверить, что вебхук жив
  if (text) {
    await tg("sendMessage", { chat_id: chatId, text: `Jarvis online: "${text.slice(0,200)}"` , reply_to_message_id: msg?.message_id });
  }

  return new Response("ok");
}
