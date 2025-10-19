// /api/tg-worker.ts
// Comments: English only. Node worker with per-user/global daily limits and cooldown via Upstash REST.

import type { VercelRequest, VercelResponse } from "@vercel/node";

const TG_TOKEN = process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN || "";
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const MODEL_ID = process.env.MODEL_ID || "gpt-4o-mini";
const INTERNAL_BEARER = process.env.INTERNAL_BEARER || "";
const CONTRACT_ADDR = "0x72b6f0b8018ed4153b4201a55bb902a0f152b5c7";

// Limits
const USER_DAILY_LIMIT = parseInt(process.env.USER_DAILY_LIMIT || "20", 10);
const GLOBAL_DAILY_LIMIT = parseInt(process.env.GLOBAL_DAILY_LIMIT || "200", 10);
const USER_COOLDOWN_SEC = parseInt(process.env.USER_COOLDOWN_SEC || "20", 10);

// Upstash REST
const RURL = process.env.UPSTASH_REDIS_REST_URL || "";
const RTOK = process.env.UPSTASH_REDIS_REST_TOKEN || "";

async function tg(method: string, payload: unknown) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`TG ${method} ${r.status} ${await r.text()}`);
}

// Minimal Upstash helpers (works on free plan)
async function redisCmd<T = any>(cmd: string[]): Promise<T | null> {
  if (!RURL || !RTOK) return null;
  const r = await fetch(`${RURL}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${RTOK}`, "content-type": "application/json" },
    body: JSON.stringify({ cmd }),
  });
  if (!r.ok) throw new Error(`Redis ${cmd[0]} ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.result as T;
}
async function incrDaily(key: string, ttlSec = 86400): Promise<number | null> {
  if (!RURL || !RTOK) return null;
  const v = await redisCmd<number>(["INCR", key]);
  if (v === 1) await redisCmd(["EXPIRE", key, String(ttlSec)]);
  return v ?? null;
}
async function getTTL(key: string): Promise<number | null> {
  if (!RURL || !RTOK) return null;
  return await redisCmd<number>(["TTL", key]);
}
async function setCooldown(key: string, sec: number): Promise<boolean> {
  if (!RURL || !RTOK) return false;
  const res = await redisCmd<number>(["SETNX", key, "1"]);
  if (res === 1) {
    await redisCmd(["EXPIRE", key, String(sec)]);
    return true;
  }
  return false;
}

function systemPrompt() {
  const base = process.env.SYSTEM_PROMPT || `
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
`;
  return base.trim();
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
  if (req.method !== "POST") return res.status(200).send("ok");

  // internal auth from Edge route
  const auth = req.headers.authorization || "";
  if (!INTERNAL_BEARER || auth !== `Bearer ${INTERNAL_BEARER}`) {
    return res.status(403).send("forbidden");
  }
  if (!TG_TOKEN || !OPENAI_KEY) return res.status(500).send("missing env");

  const { chatId, text, replyTo, threadId, fromId } =
    (typeof req.body === "string" ? JSON.parse(req.body) : req.body) || {};
  if (!chatId || !text) return res.status(200).send("ok");

  // If Redis not configured: still protect by being conservative
  const noRedis = !(RURL && RTOK);

  // Cooldown + Limits
  try {
    const uid = String(fromId || "anon");
    const dayKeyUser = `u:${uid}:d`;
    const dayKeyGlobal = `g:d`;
    const cdKey = `u:${uid}:cd`;

    // Cooldown (skip if no redis)
    if (!noRedis && USER_COOLDOWN_SEC > 0) {
      const first = await setCooldown(cdKey, USER_COOLDOWN_SEC);
      if (!first) {
        const ttl = await getTTL(cdKey);
        const left = typeof ttl === "number" && ttl > 0 ? ttl : USER_COOLDOWN_SEC;
        await tg("sendMessage", {
          chat_id: chatId,
          text: `Slow down. Cooldown ~${left}s.`,
          reply_to_message_id: replyTo ?? undefined,
          message_thread_id: threadId ?? undefined,
        });
        return res.status(200).send("ok");
      }
    }

    // Daily per-user and global counters (skip if no redis)
    if (!noRedis) {
      const userCount = await incrDaily(dayKeyUser);
      if (userCount && userCount > USER_DAILY_LIMIT) {
        await tg("sendMessage", {
          chat_id: chatId,
          text: `Daily limit reached for your account.`,
          reply_to_message_id: replyTo ?? undefined,
          message_thread_id: threadId ?? undefined,
        });
        return res.status(200).send("ok");
      }
      const globalCount = await incrDaily(dayKeyGlobal);
      if (globalCount && globalCount > GLOBAL_DAILY_LIMIT) {
        await tg("sendMessage", {
          chat_id: chatId,
          text: `Global daily limit reached. Try tomorrow.`,
          reply_to_message_id: replyTo ?? undefined,
          message_thread_id: threadId ?? undefined,
        });
        return res.status(200).send("ok");
      }
    }
  } catch (e) {
    // If Redis errors, fail closed: we still answer but avoid crashing
  }

  // LLM
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
    const friendly =
      m.includes("429") ? "Oops: API quota exceeded. Check Billing." :
      m.includes("model_not_found") ? "Oops: model not found. Set MODEL_ID (e.g., gpt-4o-mini)." :
      m.toLowerCase().includes("abort") ? "Oops: model timed out. Please try again." :
      `Oops: ${m}`;

    try {
      await tg("sendMessage", {
        chat_id: chatId,
        text: friendly,
        reply_to_message_id: replyTo ?? undefined,
        message_thread_id: threadId ?? undefined,
      });
    } catch {}
  }

  return res.status(200).send("ok");
}
