// /api/tg-worker.ts
// Node worker: robust Responses API request + parsing, clearer errors.

import type { VercelRequest, VercelResponse } from "@vercel/node";

const TG_TOKEN = process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN || "";
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const MODEL_ID = process.env.MODEL_ID || "gpt-4o-mini";
const INTERNAL_BEARER = process.env.INTERNAL_BEARER || "";
const CONTRACT_ADDR = "0x72b6f0b8018ed4153b4201a55bb902a0f152b5c7";
const DEBUG_OPENAI = (process.env.DEBUG_OPENAI || "false").toLowerCase() === "true";

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

// Build modern Responses API payload (messages-style)
function buildInput(userText: string) {
  return [
    {
      role: "system",
      content: [{ type: "text", text: systemPrompt() }],
    },
    {
      role: "user",
      content: [{ type: "text", text: userText }],
    },
  ];
}

// Robust extractor for many possible shapes of Responses API
function extractText(data: any): string {
  // 1) direct output_text (most common)
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  // 2) data.output[].content[].text
  const fromOutput =
    Array.isArray(data?.output)
      ? data.output
          .flatMap((blk: any) =>
            Array.isArray(blk?.content) ? blk.content : []
          )
          .map((c: any) => c?.text)
          .filter((t: any) => typeof t === "string" && t.trim())
          .join("\n")
          .trim()
      : "";
  if (fromOutput) return fromOutput;

  // 3) data.message.content[].text (some server variants)
  const fromMessage =
    Array.isArray(data?.message?.content)
      ? data.message.content
          .map((c: any) => c?.text)
          .filter((t: any) => typeof t === "string" && t.trim())
          .join("\n")
          .trim()
      : "";
  if (fromMessage) return fromMessage;

  // 4) legacy-ish: choices[0].message.content (chat-completions-like)
  const ch = data?.choices?.[0]?.message?.content;
  if (typeof ch === "string" && ch.trim()) return ch.trim();
  if (Array.isArray(ch)) {
    const joined = ch
      .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    if (joined) return joined;
  }

  return "";
}

async function askLLM(userText: string, signal?: AbortSignal) {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL_ID,
      input: buildInput(userText), // messages array
      // temperature: 0.2, // optional
    }),
    signal,
  });

  if (!r.ok) {
    let msg = `LLM error ${r.status}`;
    try {
      const j = await r.json();
      if (j?.error?.message) msg += `: ${j.error.message}`;
    } catch {}
    throw new Error(msg);
  }

  const data = await r.json().catch(() => ({} as any));
  const text = extractText(data);

  if (!text) {
    if (DEBUG_OPENAI) {
      // Send short debug snippet back to the caller (trimmed)
      const raw = JSON.stringify(data).slice(0, 800);
      return `Debug: empty text from model.\n(model=${MODEL_ID})\n${raw}`;
    }
    return "I'm not sure."; // graceful fallback
  }
  return text;
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
    const to = setTimeout(() => ctrl.abort(), 30000); // give it a bit more time
    let reply: string;
    try {
      reply = await askLLM(text, ctrl.signal);
    } finally {
      clearTimeout(to);
    }

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
