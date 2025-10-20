// /api/tg-worker.ts
// Node worker: correct Responses API payload (input_text/output_text),
// robust parsing, small retry on 429/5xx, and clear error messages.

import type { VercelRequest, VercelResponse } from "@vercel/node";

const TG_TOKEN        = process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN || "";
const OPENAI_KEY      = process.env.OPENAI_API_KEY || "";
const MODEL_ID        = process.env.MODEL_ID || "gpt-4o-mini";
const INTERNAL_BEARER = process.env.INTERNAL_BEARER || "";
const CONTRACT_ADDR   = "0x72b6f0b8018ed4153b4201a55bb902a0f152b5c7";
const DEBUG_OPENAI    = (process.env.DEBUG_OPENAI || "false").toLowerCase() === "true";

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
    {
      role: "system",
      content: [{ type: "input_text", text: systemPrompt() }],
    },
    {
      role: "user",
      content: [{ type: "input_text", text: userText }],
    },
  ];
}

// Extract text from various possible Responses API shapes
function extractText(data: any): string {
  // 1) output_text
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }
  // 2) output[].content[].type === 'output_text'
  if (Array.isArray(data?.output)) {
    const parts = data.output.flatMap((blk: any) =>
      Array.isArray(blk?.content) ? blk.content : []
    );
    const texts = parts
      .filter((c: any) => c?.type === "output_text" && typeof c?.text === "string")
      .map((c: any) => c.text.trim())
      .filter(Boolean);
    if (texts.length) return texts.join("\n");
  }
  // 3) greedy fallback: any .text fields under output[].content[]
  const greedy =
    Array.isArray(data?.output)
      ? data.output
          .flatMap((blk: any) => (Array.isArray(blk?.content) ? blk.content : []))
          .map((c: any) => (typeof c?.text === "string" ? c.text.trim() : ""))
          .filter(Boolean)
          .join("\n")
          .trim()
      : "";
  if (greedy) return greedy;

  // 4) legacy chat-completions-like shape
  const ch = data?.choices?.[0]?.message?.content;
  if (typeof ch === "string" && ch.trim()) return ch.trim();

  return "";
}

async function askLLM(userText: string, signal?: AbortSignal) {
  const payload = {
    model: MODEL_ID,
    input: buildInput(userText),
    // temperature: 0.2, // optional
  };

  // Small retry loop on 429/5xx
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
      return DEBUG_OPENAI
        ? `Debug: empty text from model (model=${MODEL_ID}).`
        : "I'm not sure.";
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
        text: m.startsWith("LLM error") ? `${m} (model=${MODEL_ID})` : `Oops: ${m} (model=${MODEL_ID})`,
        reply_to_message_id: replyTo ?? undefined,
        message_thread_id: threadId ?? undefined,
      });
    } catch {}
    return res.status(500).send(m);
  }

  return res.status(200).send("ok");
}
