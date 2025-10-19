// /api/tg-worker.ts
// Comments: English only. Node worker with GET healthcheck and explicit env checks.

import type { VercelRequest, VercelResponse } from "@vercel/node";

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
  return `
You are “Jarvis”, a concise, friendly assistant and a resident of the Woolly Eggs universe (NFT collection).
Always reply in ENGLISH only.
- Be brief (1–3 sentences or up to 5 short bullets).
- No made-up lore. If unknown, say "I'm not sure".
- Whitelist: 5 Woolly Eggs NFTs (contract: ${CONTRACT_ADDR}).
- WE Telegram role: 10 Syndicate NFTs.
- For a bit of WOOL: https://wooligotchi.vercel.app/
`.trim();
}
function buildPrompt(userText: string) {
  return `System: ${systemPrompt()}\nAlways respond in English.\nUser: ${userText}\nAssistant:`;
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Healthcheck via GET in browser
  if (req.method === "GET") {
    const ready = Boolean(INTERNAL_BEARER) && Boolean(OPENAI_KEY);
    return res.status(ready ? 200 : 500).send(ready ? "ok" : "missing env");
  }

  if (req.method !== "POST") return res.status(200).send("ok");

  // internal auth from Edge route
  const auth = req.headers.authorization || "";
  if (!INTERNAL_BEARER || auth !== `Bearer ${INTERNAL_BEARER}`) {
    return res.status(403).send("forbidden");
  }
  if (!TG_TOKEN) return res.status(500).send("missing TELEGRAM_TOKEN");
  if (!OPENAI_KEY) return res.status(500).send("missing OPENAI_API_KEY");

  const { chatId, text, replyTo, threadId } =
    (typeof req.body === "string" ? JSON.parse(req.body) : req.body) || {};
  if (!chatId || !text) return res.status(200).send("ok");

  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 20000);
    let reply: string;
    try { reply = await askLLM(text, ctrl.signal); } finally { clearTimeout(to); }

    await tg("sendMessage", {
      chat_id: chatId,
      text: reply,
      reply_to_message_id: replyTo ?? undefined,
      message_thread_id: threadId ?? undefined,
    });
  } catch (e: any) {
    const m = String(e?.message || e || "unknown error");
    try {
      await tg("sendMessage", {
        chat_id: chatId,
        text: m.startsWith("LLM error") ? m : `Oops: ${m}`,
        reply_to_message_id: replyTo ?? undefined,
        message_thread_id: threadId ?? undefined,
      });
    } catch {}
    return res.status(500).send(m);
  }

  return res.status(200).send("ok");
}
