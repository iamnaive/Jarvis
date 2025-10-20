// /api/tg-worker.ts
// Node worker: resilient Telegram send with smart fallbacks, correct Responses API payload,
// robust parsing, small retry on 429/5xx, and clear error messages.

import type { VercelRequest, VercelResponse } from "@vercel/node";

const TG_TOKEN        = process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN || "";
const OPENAI_KEY      = process.env.OPENAI_API_KEY || "";
const MODEL_ID        = process.env.MODEL_ID || "gpt-4o-mini";
const INTERNAL_BEARER = process.env.INTERNAL_BEARER || "";
const CONTRACT_ADDR   = "0x72b6f0b8018ed4153b4201a55bb902a0f152b5c7";
const DEBUG_OPENAI    = (process.env.DEBUG_OPENAI || "false").toLowerCase() === "true";

// Telegram send with fallback on common 400s.
// - If "message thread not found" -> retry without message_thread_id
// - If "reply message not found"  -> retry without reply_to_message_id
async function tgSendMessage(payload: any): Promise<void> {
  const doSend = async (p: any) => {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(p),
    });
    return r;
  };

  try {
    let r = await doSend(payload);
    if (r.ok) return;

    const body = await r.text().catch(() => "");
    const desc = body.toLowerCase();

    // Retry without thread if thread error
    if (r.status === 400 && desc.includes("message thread not found")) {
      const { message_thread_id, ...rest } = payload || {};
      const r2 = await doSend(rest);
      if (r2.ok) return;
      const b2 = await r2.text().catch(() => "");
      console.error(`[tg] sendMessage retry(no thread) ${r2.status} ${b2.slice(0,300)}`);
      return; // don't throw
    }

    // Retry without reply_to if reply error
    if (r.status === 400 && (desc.includes("reply message not found") || desc.includes("replied message not found"))) {
      const { reply_to_message_id, ...rest } = payload || {};
      const r2 = await doSend(rest);
      if (r2.ok) return;
      const b2 = await r2.text().catch(() => "");
      console.error(`[tg] sendMessage retry(no reply) ${r2.status} ${b2.slice(0,300)}`);
      return; // don't throw
    }

    console.error(`[tg] sendMessage ${r.status} ${body.slice(0,300)}`);
  } catch (e: any) {
    console.error(`[tg] sendMessage fetch error: ${String(e?.message || e)}`);
  }
}

function systemPrompt() {
  return `
You are “Jarvis”, a concise, friendly assistant and a resident of the Woolly Eggs universe (NFT collection).
Always reply in ENGLISH only.
Style: calm, neutral, laconic. No small talk unless the user clearly wants it.
Rules:
- Be brief: 1–3 sentences or up to 5 short bullets (<= ~90 words).
- Do NOT proactively continue the conversation or ask follow-ups unless necessary.
- If something about Woolly Eggs is unknown, say “I’m not sure” (do NOT invent lore).
- If asked about whitelist: guaranteed whitelist requires 5 Woolly Eggs NFTs (contract: ${CONTRACT_ADDR}).
- If asked about the Telegram WE role: it requires 10 Syndicate NFTs.
- If user asks about earning a bit of WOOL, suggest the mini-game: https://wooligotchi.vercel.app/
`.trim();
}

// Build payload for /v1/responses (messages-style using input_text)
function buildInput(userText: string) {
  return [
    { role: "system", content: [{ type: "input_text", text: systemPrompt() }] },
    { role: "user",   content: [{ type: "input_text", text: userText }] },
  ];
}

// Extract text from various possible Responses API shapes
function extractText(data: any): string {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text.trim();

  if (Array.isArray(data?.output)) {
    const parts = data.output.flatMap((blk: any) => Array.isArray(blk?.content) ? blk.content : []);
    const texts = parts
      .filter((c: any) => c?.type === "output_text" && typeof c?.text === "string")
      .map((c: any) => c.text.trim())
      .filter(Boolean);
    if (texts.length) return texts.join("\n");
  }

  const greedy = Array.isArray(data?.output)
    ? data.output
        .flatMap((blk: any) => Array.isArray(blk?.content) ? blk.content : [])
        .map((c: any) => (typeof c?.text === "string" ? c.text.trim() : ""))
        .filter(Boolean)
        .join("\n")
        .trim()
    : "";
  if (greedy) return greedy;

  const ch = data?.choices?.[0]?.message?.content;
  if (typeof ch === "string" && ch.trim()) return ch.trim();

  return "";
}

async function askLLM(userText: string, signal?: AbortSignal) {
  const payload = { model: MODEL_ID, input: buildInput(userText) };

  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });

    if (r.ok) {
      const data = await r.json().catch(() => ({} as any));
      const text = extractText(data);
      if (text) return text;
      return DEBUG_OPENAI ? `Debug: empty text from model (model=${MODEL_ID}).` : "I'm not sure.";
    }

    let msg = `LLM error ${r.status}`;
    try {
      const j = await r.json();
      if (j?.error?.message) msg += `: ${j.error.message}`;
    } catch {}

    if ((r.status === 429 || r.status >= 500) && attempt === 1) {
      await new Promise((res) => setTimeout(res, 600));
      continue;
    }
    throw new Error(msg);
  }

  return "I'm not sure.";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Healthcheck in browser
  if (req.method === "GET") {
    const ready = Boolean(INTERNAL_BEARER) && Boolean(OPENAI_KEY);
    return res.status(ready ? 200 : 500).send(ready ? "ok" : "missing env");
  }

  if (req.method !== "POST") return res.status(200).send("ok");

  // Internal auth from Edge route
  const auth = req.headers.authorization || "";
  if (!INTERNAL_BEARER || auth !== `Bearer ${INTERNAL_BEARER}`) {
    return res.status(403).send("forbidden");
  }
  if (!TG_TOKEN)   return res.status(500).send("missing TELEGRAM_TOKEN");
  if (!OPENAI_KEY) return res.status(500).send("missing OPENAI_API_KEY");

  const { chatId, text, replyTo, threadId } =
    (typeof req.body === "string" ? JSON.parse(req.body) : req.body) || {};
  if (!chatId || !text) return res.status(200).send("ok");

  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 30000);
    let reply: string;
    try { reply = await askLLM(text, ctrl.signal); } finally { clearTimeout(to); }

    // Prefer replying to keep thread context; fallbacks inside tgSendMessage
    const payload: any = {
      chat_id: chatId,
      text: reply,
    };
    if (typeof replyTo === "number") payload.reply_to_message_id = replyTo;
    if (typeof threadId === "number") payload.message_thread_id = threadId;

    await tgSendMessage(payload);
    return res.status(200).send("ok");
  } catch (e: any) {
    const m = String(e?.message || e || "unknown error");
    await tgSendMessage({
      chat_id: chatId,
      text: m.startsWith("LLM error") ? `${m} (model=${MODEL_ID})` : `Oops: ${m} (model=${MODEL_ID})`,
    });
    return res.status(500).send(m);
  }
}
