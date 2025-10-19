// app/api/tg-worker/route.ts
// Runtime: Node.js — performs LLM request and posts back to Telegram.
// Env: TELEGRAM_TOKEN (or BOT_TOKEN), OPENAI_API_KEY, MODEL_ID (e.g., gpt-4o-mini), INTERNAL_BEARER
// Optional: SYSTEM_PROMPT

export const runtime = "nodejs";

const TG_TOKEN = process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN || "";
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const MODEL_ID = process.env.MODEL_ID || "gpt-4o-mini";
const INTERNAL_BEARER = process.env.INTERNAL_BEARER || "";
const CONTRACT_ADDR = "0x72b6f0b8018ed4153b4201a55bb902a0f152b5c7";

async function tg(method: string, payload: unknown) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`TG ${method} ${r.status} ${await r.text()}`);
}

function systemPrompt() {
  const base = process.env.SYSTEM_PROMPT || `
You are “Jarvis”, a concise, friendly assistant and a resident of the Woolly Eggs universe (NFT collection).
Always reply in ENGLISH only.
Style: calm, neutral, laconic. No small talk unless the user clearly wants it.
Rules:
- Be brief: 1–3 sentences or up to 5 short bullets (<= ~90 words).
- Do NOT proactively continue the conversation or ask follow-ups unless necessary.
- If user says thanks/ok/bye, reply with one short closing line and stop.
- If something about Woolly Eggs is unknown, say “I’m not sure” (do NOT invent lore).
- If asked about whitelist: guaranteed whitelist requires 5 Woolly Eggs NFTs (contract: ${CONTRACT_ADDR}).
- If asked about the Telegram WE role: it requires 10 Syndicate NFTs.
- If user asks about earning a bit of WOOL, suggest the mini-game: https://wooligotchi.vercel.app/
`;
  return base.trim();
}
function buildPrompt(userText: string) {
  const enforceEN = "Always respond in English. Do not switch languages, even if the user writes in another language.";
  return `System: ${systemPrompt()}\n${enforceEN}\nUser: ${userText}\nAssistant:`;
}

async function askLLM(text: string, signal?: AbortSignal) {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL_ID, input: buildPrompt(text) }),
    signal,
  });
  if (!r.ok) {
    let msg = `LLM error ${r.status}`;
    try { const j = await r.json(); if (j?.error?.message) msg += `: ${j.error.message}`; } catch {}
    throw new Error(msg);
  }
  const data = await r.json().catch(() => ({} as any));
  return data.output_text ?? data.output?.[0]?.content?.[0]?.text ?? "I couldn't produce a response.";
}

export async function POST(req: Request) {
  // Authorization from edge route
  const auth = req.headers.get("authorization") || "";
  if (!INTERNAL_BEARER || auth !== `Bearer ${INTERNAL_BEARER}`)
    return new Response("forbidden", { status: 403 });

  if (!TG_TOKEN || !OPENAI_KEY)
    return new Response("missing env", { status: 500 });

  let payload: any = {};
  try { payload = await req.json(); } catch { return new Response("bad json", { status: 400 }); }

  const chatId: number = payload.chatId;
  const text: string = payload.text || "";
  const replyTo: number | null = payload.replyTo ?? null;
  const threadId: number | null = payload.threadId ?? null;

  if (!chatId || !text) return new Response("ok");

  // Optional: send typing
  tg("sendChatAction", { chat_id: chatId, action: "typing", message_thread_id: threadId ?? undefined }).catch(()=>{});

  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 20000); // safer, Node route can run longer
    let reply: string;
    try { reply = await askLLM(text, ctrl.signal); }
    finally { clearTimeout(to); }

    await tg("sendMessage", {
      chat_id: chatId,
      text: reply,
      reply_to_message_id: replyTo ?? undefined,
      message_thread_id: threadId ?? undefined,
    });
  } catch (e: any) {
    const m = String(e?.message || e || "unknown error");
    const friendly =
      m.includes("429") ? "Oops: API quota exceeded. Check Billing." :
      m.includes("model_not_found") ? "Oops: model not found. Set MODEL_ID (e.g., gpt-4o-mini)." :
      m.toLowerCase().includes("abort") ? "Oops: model timed out. Please try again." :
      `Oops: ${m}`;

    await tg("sendMessage", {
      chat_id: chatId,
      text: friendly,
      reply_to_message_id: replyTo ?? undefined,
      message_thread_id: threadId ?? undefined,
    }).catch(()=>{});
  }

  return new Response("ok");
}
