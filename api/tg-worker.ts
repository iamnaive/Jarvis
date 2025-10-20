// /api/tg-worker.ts
// Node worker: creative-by-default persona (except project triggers),
// resilient Telegram sending with smart fallbacks, correct Responses API payload,
// robust parsing, small retry on 429/5xx, and clear error messages.

import type { VercelRequest, VercelResponse } from "@vercel/node";

const TG_TOKEN        = process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN || "";
const OPENAI_KEY      = process.env.OPENAI_API_KEY || "";
const MODEL_ID        = process.env.MODEL_ID || "gpt-4o-mini";
const INTERNAL_BEARER = process.env.INTERNAL_BEARER || "";

// Creative tuning
const CREATIVE_TEMP   = Number(process.env.CREATIVE_TEMP || "0.9");
const BASE_TEMP       = Number(process.env.BASE_TEMP || "0.2");

// Optional debug
const DEBUG_OPENAI    = (process.env.DEBUG_OPENAI || "false").toLowerCase() === "true";

// Project constants
const CONTRACT_ADDR   = "0x72b6f0b8018ed4153b4201a55bb902a0f152b5c7";

/* -------------------------------- Telegram send helpers -------------------------------- */

// Send with fallbacks:
// - If "message thread not found" -> retry without message_thread_id
// - If "reply message not found"  -> retry without reply_to_message_id
async function tgSendMessage(payload: any): Promise<void> {
  const doSend = async (p: any) => {
    return fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(p),
    });
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
      return;
    }

    // Retry without reply_to if reply error
    if (r.status === 400 && (desc.includes("reply message not found") || desc.includes("replied message not found"))) {
      const { reply_to_message_id, ...rest } = payload || {};
      const r2 = await doSend(rest);
      if (r2.ok) return;
      const b2 = await r2.text().catch(() => "");
      console.error(`[tg] sendMessage retry(no reply) ${r2.status} ${b2.slice(0,300)}`);
      return;
    }

    console.error(`[tg] sendMessage ${r.status} ${body.slice(0,300)}`);
  } catch (e: any) {
    console.error(`[tg] sendMessage fetch error: ${String(e?.message || e)}`);
  }
}

/* -------------------------------- Personas & prompts -------------------------------- */

function isProjectTrigger(text: string): boolean {
  const s = (text || "").toLowerCase();
  // Mirrors telegram.ts canned triggers
  return (
    /\b(whitelist|allowlist)\b/.test(s) ||
    /\b(we\s*role|we-?role|telegram\s*we\s*role)\b/.test(s) ||
    /\b(syndicate)\b/.test(s) ||
    /\b(wooligotchi|wooli?gotchi|mini-?game|game|wool)\b/.test(s) ||
    /\b(twitter|x\.com|x\s*\/?\s*woollyeggs|woolly\s*eggs\s*(twitter|x))\b/.test(s) ||
    /\b(snapshot)\b/.test(s)
  );
}

// Creative persona (default)
function systemPromptCreative() {
  return `
You are “Jarvis”, a witty, imaginative assistant from the Woolly Eggs universe.
You may invent lore, speculate, and answer approximately without disclaimers.
Tone: playful, concise, sometimes cinematic. Keep answers short (1–3 sentences or up to 5 bullets).
Avoid unsafe or harmful content; if the topic is sensitive or dangerous, refuse.
`.trim();
}

// Factual persona (used when project triggers are present)
function systemPromptFactual(contractAddr: string) {
  return `
You are “Jarvis”, a concise, friendly assistant from the Woolly Eggs universe.
Always reply in ENGLISH only. Be brief (1–3 sentences or up to 5 short bullets).
Prefer clear, factual answers for project topics. Do not invent real-world facts.
Project facts:
- Guaranteed whitelist requires 5 Woolly Eggs NFTs (contract: ${contractAddr}).
- WE Telegram role requires 10 Syndicate NFTs.
- For a bit of WOOL: https://wooligotchi.vercel.app/
`.trim();
}

// Build Responses API "messages" input with input_text
function buildInput(userText: string, creative: boolean) {
  const sys = creative ? systemPromptCreative() : systemPromptFactual(CONTRACT_ADDR);
  return [
    { role: "system", content: [{ type: "input_text", text: sys }] },
    { role: "user",   content: [{ type: "input_text", text: userText }] },
  ];
}

/* -------------------------------- OpenAI call & parsing -------------------------------- */

function extractText(data: any): string {
  // 1) top-level output_text
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text.trim();

  // 2) output[].content[].type === 'output_text'
  if (Array.isArray(data?.output)) {
    const parts = data.output.flatMap((blk: any) => Array.isArray(blk?.content) ? blk.content : []);
    const texts = parts
      .filter((c: any) => c?.type === "output_text" && typeof c?.text === "string")
      .map((c: any) => c.text.trim())
      .filter(Boolean);
    if (texts.length) return texts.join("\n");
  }

  // 3) greedy fallback
  const greedy = Array.isArray(data?.output)
    ? data.output
        .flatMap((blk: any) => Array.isArray(blk?.content) ? blk.content : [])
        .map((c: any) => (typeof c?.text === "string" ? c.text.trim() : ""))
        .filter(Boolean)
        .join("\n")
        .trim()
    : "";
  if (greedy) return greedy;

  // 4) legacy chat-completions-like
  const ch = data?.choices?.[0]?.message?.content;
  if (typeof ch === "string" && ch.trim()) return ch.trim();

  return "";
}

async function askLLM(userText: string, signal?: AbortSignal) {
  // Force factual on project triggers; otherwise creative by default
  const creative = !isProjectTrigger(userText);
  const temperature = creative ? CREATIVE_TEMP : BASE_TEMP;

  const payload = {
    model: MODEL_ID,
    input: buildInput(userText, creative),
    temperature,
  };

  // Small retry on 429/5xx
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

/* -------------------------------- HTTP handler -------------------------------- */

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Simple healthcheck
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

    const payload: any = { chat_id: chatId, text: reply };
    if (typeof replyTo === "number")  payload.reply_to_message_id = replyTo;
    if (typeof threadId === "number") payload.message_thread_id   = threadId;

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
