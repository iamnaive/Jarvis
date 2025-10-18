// /api/bot.js — Telegram webhook on Vercel (Node serverless, NO Express)
// Env: TELEGRAM_TOKEN (or BOT_TOKEN), OPENAI_API_KEY, MODEL_ID (e.g., gpt-4o-mini), BOT_USERNAME, optional SYSTEM_PROMPT
// Comments: English only.

const TG_TOKEN     = process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN;
const OPENAI_KEY   = process.env.OPENAI_API_KEY || '';
const MODEL_ID     = process.env.MODEL_ID || 'gpt-4o-mini'; // <-- Default LLM model
const BOT_USERNAME = (process.env.BOT_USERNAME || '').toLowerCase(); // e.g. "jarviseggsbot"

// Feature flags
const USE_LLM_ON_MENTION = true;    // LLM only when mentioned / name called / replying to bot
const LLM_TIMEOUT_MS      = 7000;   // tighter than serverless 10s
const LLM_COOLDOWN_MS     = 2500;   // anti-flood per chat

// Project constants
const CONTRACT_ADDR = '0x72b6f0b8018ed4153b4201a55bb902a0f152b5c7';

// Utils
const rnd = (arr) => arr[Math.floor(Math.random() * arr.length)];
const log = (...a) => { try { console.log(...a); } catch {} };

// Thread helper: keep replies inside forum topics (supergroup threads)
function withThread(payload, msg) {
  return msg?.message_thread_id
    ? { message_thread_id: msg.message_thread_id, ...payload }
    : payload;
}

// Telegram helpers — fire-and-forget by default (don't await in triggers)
async function tg(method, payload) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!r.ok) {
      const t = await r.text().catch(()=> '');
      log('TG error', method, r.status, t);
    }
  } catch (e) { log('TG fetch error', method, String(e?.message || e)); }
}
async function tgJson(method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const txt = await r.text();
  if (!r.ok) {
    log('TG json error', method, r.status, txt);
    throw new Error(`TG ${method} ${r.status}`);
  }
  try { return JSON.parse(txt); } catch { return { ok:false, raw: txt }; }
}
function sendMessageFast(msg, text, extra = {}) {
  // do not await (fire-and-forget) for speed on triggers
  void tg('sendMessage', withThread({
    chat_id: msg.chat.id, text, reply_to_message_id: msg.message_id, ...extra
  }, msg));
}
function sendTypingFast(msg) {
  void tg('sendChatAction', withThread({
    chat_id: msg.chat.id, action: 'typing'
  }, msg));
}
async function editMessageInThread(msg, message_id, text) {
  return tg('editMessageText', withThread({
    chat_id: msg.chat.id, message_id, text
  }, msg));
}

// Canned replies (EN only)
const WL_LINES = [
  `Guaranteed whitelist = 5 Woolly Eggs NFTs. Contract: ${CONTRACT_ADDR}`,
  `Hold 5 Woolly Eggs — you’re guaranteed on the whitelist. Contract: ${CONTRACT_ADDR}`,
  `Whitelist is guaranteed when you hold 5 Woolly Eggs NFTs. Contract: ${CONTRACT_ADDR}`,
  `With 5 Woolly Eggs you’re auto-whitelisted. Contract: ${CONTRACT_ADDR}`
];
const WE_ROLE_LINES = [
  "The Telegram WE role requires 10 Syndicate NFTs.",
  "To get the WE role in Telegram, hold 10 Syndicate NFTs.",
  "WE role → hold 10 Syndicate NFTs (Telegram).",
  "You’ll receive the WE Telegram role once you hold 10 Syndicate NFTs."
];
const GAME_LINES = [
  "Want to earn some WOOL? Try the mini-game: https://wooligotchi.vercel.app/",
  "You can grind a bit of WOOL here: https://wooligotchi.vercel.app/",
  "Small WOOL boost: play https://wooligotchi.vercel.app/",
  "For a little WOOL, check: https://wooligotchi.vercel.app/"
];
const GWOOLLY_LINES = [
  "Gwoolly",
  "Gwoolly 🧶",
  "Gwoolly 🥚",
  "Gwoolly 🥚 🧶"
];
const TWITTER_LINES = [
  "Official X (Twitter): https://x.com/WoollyEggs",
  "You can follow us on X here: https://x.com/WoollyEggs",
  "Our X (Twitter) page: https://x.com/WoollyEggs",
  "X link: https://x.com/WoollyEggs"
];
const SNAPSHOT_LINES = [
  "The snapshot will occur one day before the mainnet launch.",
  "Snapshot is planned for 24 hours prior to mainnet going live.",
  "Expect the snapshot a day ahead of the mainnet launch.",
  "Snapshot happens one day before mainnet."
];
const GREET_LINES = [
  "Hey — Jarvis here. How can I help?",
  "Hi there, I’m Jarvis. What do you need?",
  "Hello! Jarvis on the line — how can I assist?",
  "Hey! Jarvis here. Ask away."
];

// Regex triggers (EN only)
const RE_WL       = /\b(whitelist|allowlist)\b/i;
const RE_WE       = /\b(we\s*role|we-?role|telegram\s*we\s*role)\b/i;
const RE_SYN      = /\b(syndicate)\b/i;
const RE_GAME     = /\b(wooligotchi|wooli?gotchi|mini-?game|game|wool)\b/i;
const RE_BYE      = /^(thanks|thank you|ok|okay|got it|all good|bye|goodbye)$/i;
const RE_GWOOLLY  = /\bgwoolly\b/i;
const RE_TWITTER  = /\b(twitter|x\.com|x\s*\/?\s*woollyeggs|woolly\s*eggs\s*(twitter|x))\b/i;
const RE_SNAPSHOT = /\b(snapshot)\b/i;
const RE_JARVIS   = /\bjarvis\b/i;
const RE_GREET    = /\b(hi|hello|hey|yo|hiya|howdy|gm|good\s*morning|good\s*evening|good\s*night|sup|what'?s\s*up)\b/i;

// Mention helpers
function isDirectMention(msg) {
  const text = (msg?.text ?? msg?.caption ?? '') + '';
  const lower = text.toLowerCase();
  const envUser = BOT_USERNAME;
  if (!envUser) return false;

  const ents = Array.isArray(msg?.entities) ? msg.entities
             : Array.isArray(msg?.caption_entities) ? msg.caption_entities : [];
  for (const e of ents) {
    if (e?.type === 'mention') {
      const mention = text.slice(e.offset, e.offset + e.length).toLowerCase(); // "@jarviseggsbot"
      if (mention === '@' + envUser) return true;
    }
  }
  if (lower.includes('@' + envUser)) return true;
  return false;
}
function stripMentionsAndName(text, botUser='') {
  let out = text || '';
  if (botUser) out = out.replace(new RegExp(`@${botUser}`, 'ig'), '');
  out = out.replace(/jarvis/ig, '');
  return out.trim();
}

// LLM
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
`.trim();
  return base;
}
function buildPrompt(userText) {
  const enforceEN = "Always respond in English. Do not switch languages, even if the user writes in another language.";
  return `System: ${systemPrompt()}\n${enforceEN}\nUser: ${userText}\nAssistant:`;
}
async function askLLM(text, signal, maxTokens=220) {
  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL_ID, input: buildPrompt(text), max_output_tokens: maxTokens }),
    signal
  });
  if (!r.ok) {
    let msg = `LLM error ${r.status}`;
    try { const j = await r.json(); if (j?.error?.message) msg += `: ${j.error.message}`; } catch {}
    throw new Error(msg);
  }
  const data = await r.json().catch(() => ({}));
  return data.output_text ?? data.output?.[0]?.content?.[0]?.text ?? "I couldn't produce a response.";
}

// Anti-flood per chat for LLM
const lastLLMAt = new Map(); // chatId -> timestamp

// Heuristics (passive)
function looksLikeQuestion(txt) {
  if (!txt) return false;
  const s = txt.toLowerCase();
  if (s.includes('?')) return true;
  const Q = /\b(how|what|why|when|where|who|which|can|could|should|help|guide|idea|price|cost|how much)\b/;
  return Q.test(s);
}
function containsProjectKeywords(txt) {
  if (!txt) return false;
  const s = txt.toLowerCase();
  return /\b(woolly\s*eggs|woolly|eggs|syndicate|wooligotchi|whitelist|allowlist|we\s*role|we-?role|mini-?game|wool|snapshot)\b/.test(s);
}
function isCommandy(txt) {
  if (!txt) return false;
  const s = txt.trim().toLowerCase();
  const RE = /\b(tell|show|give|make|start|run|explain|calculate|calc|share|provide|list)\b/;
  return RE.test(s);
}
function shouldReplyPassive(text) {
  let score = 0;
  if (looksLikeQuestion(text)) score++;
  if (containsProjectKeywords(text)) score++;
  if (isCommandy(text)) score++;
  return score >= 2;
}

// Background processor — triggers only (no LLM)
function processNonMention(update) {
  const msg      = update.message || update.edited_message || update.channel_post || update.edited_channel_post || null;
  const chatId   = msg?.chat?.id;
  const textRaw  = (msg?.text ?? msg?.caption ?? '');
  const text     = (textRaw || '').trim();
  const chatType = msg?.chat?.type;
  const isGroup  = chatType === 'group' || chatType === 'supergroup';
  const isPrivate= chatType === 'private';

  if (!chatId || isPrivate || msg?.from?.is_bot) return;

  const lower = (text || '').toLowerCase();

  if (RE_BYE.test(lower)) {
    sendMessageFast(msg, rnd([
      "Anytime. Take care!",
      "You're welcome. Have a good one!",
      "Glad to help. See you!"
    ]));
    return;
  }

  // Must-reply triggers (no tag)
  if (RE_GWOOLLY.test(lower))  return void sendMessageFast(msg, rnd(GWOOLLY_LINES));
  if (RE_TWITTER.test(lower))  return void sendMessageFast(msg, rnd(TWITTER_LINES));
  if (RE_SNAPSHOT.test(lower)) return void sendMessageFast(msg, rnd(SNAPSHOT_LINES));

  // Passive heuristics gate
  let pass = true;
  if (isGroup) {
    const replyToBot = msg?.reply_to_message?.from?.is_bot &&
      (!msg?.reply_to_message?.from?.username ||
       msg.reply_to_message.from.username.toLowerCase() === BOT_USERNAME);
    if (!replyToBot) pass = shouldReplyPassive(text);
  }
  if (!pass) return;

  // Canned knowledge
  if (RE_WL.test(lower)) {
    sendMessageFast(msg, rnd(WL_LINES));
    if (RE_GAME.test(lower)) sendMessageFast(msg, rnd(GAME_LINES));
    return;
  }
  if (RE_WE.test(lower) || (RE_WE.test(lower) && RE_SYN.test(lower))) {
    sendMessageFast(msg, rnd(WE_ROLE_LINES));
    return;
  }
  if (RE_GAME.test(lower)) {
    sendMessageFast(msg, rnd(GAME_LINES));
    return;
  }

  if (!text) return void sendMessageFast(msg, "What do you need?");
}

// Webhook handler
export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).send('ok');
  if (req.method !== 'POST') return res.status(200).send('ok');
  if (!TG_TOKEN) return res.status(200).send('ok');

  // Prefer Next/Vercel parsed body
  let update = {};
  if (req.body && typeof req.body === 'object') {
    update = req.body;
  } else {
    let body = '';
    await new Promise(resolve => { req.on('data', c => body += c); req.on('end', resolve); });
    try { update = body ? JSON.parse(body) : {}; } catch {}
  }

  // Early ACK
  res.status(200).end('ok');

  // Commands (fast)
  try {
    const msg = update.message || update.edited_message || update.channel_post || update.edited_channel_post || null;
    if (!msg || msg?.from?.is_bot) return;

    const chatId   = msg.chat?.id;
    const text     = ((msg.text ?? msg.caption) || '').trim();
    const lower    = text.toLowerCase();
    const isPrivate= msg.chat?.type === 'private';

    if (!chatId || isPrivate) return;

    if (lower === '/ping' || lower.startsWith('/ping ')) {
      return void sendMessageFast(msg, 'pong');
    }
    if (lower === '/diag' || lower.startsWith('/diag ')) {
      const diag =
        `ok\n` +
        `model=${MODEL_ID}\n` +
        `bot=@${BOT_USERNAME || 'UNKNOWN'}\n` +
        `llm_on_mention=${USE_LLM_ON_MENTION}\n` +
        `openai_key=${OPENAI_KEY ? 'SET' : 'MISSING'}\n` +
        `thread=${msg.message_thread_id ? 'yes' : 'no'}\n`;
      return void sendMessageFast(msg, '```txt\n' + diag + '```', { parse_mode: 'Markdown' });
    }
  } catch (e) {
    log('cmd error', String(e?.message || e));
  }

  // Process
  try {
    const msg      = update.message || update.edited_message || update.channel_post || update.edited_channel_post || null;
    const chatId   = msg?.chat?.id;
    const textRaw  = (msg?.text ?? msg?.caption ?? '');
    const text     = (textRaw || '').trim();
    const isPrivate= msg?.chat?.type === 'private';
    if (!chatId || isPrivate || msg?.from?.is_bot) return;

    const lower = (text || '').toLowerCase();
    const mentioned   = isDirectMention(msg);
    const nameCalled  = RE_JARVIS.test(lower);
    const replyToBot  = msg?.reply_to_message?.from?.is_bot &&
                        (!msg?.reply_to_message?.from?.username ||
                         msg.reply_to_message.from.username.toLowerCase() === BOT_USERNAME);

    // Quick greet on mention/name + greet word (no LLM yet)
    if ((mentioned || nameCalled) && RE_GREET.test(lower)) {
      return void sendMessageFast(msg, rnd(GREET_LINES));
    }

    // LLM path ONLY when directly addressed
    if (USE_LLM_ON_MENTION && (mentioned || nameCalled || replyToBot)) {
      // Anti-flood per chat
      const now = Date.now();
      const last = lastLLMAt.get(chatId) || 0;
      if (now - last < LLM_COOLDOWN_MS) return;
      lastLLMAt.set(chatId, now);

      if (!OPENAI_KEY) return void sendMessageFast(msg, "OpenAI API key is missing on the server.");

      const cleaned = stripMentionsAndName(text, BOT_USERNAME) || "Please answer briefly.";
      sendTypingFast(msg);

      // Placeholder → then edit
      let mid = null;
      try {
        const ph = await tgJson('sendMessage', withThread({
          chat_id: msg.chat.id,
          text: "On it…",
          reply_to_message_id: msg.message_id
        }, msg));
        mid = ph?.result?.message_id || null;
      } catch {}

      try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
        let reply;
        try { reply = await askLLM(cleaned, ctrl.signal, 180); }
        finally { clearTimeout(to); }
        reply = (reply && reply.trim()) ? reply : "Got it.";
        if (mid) await editMessageInThread(msg, mid, reply);
        else sendMessageFast(msg, reply);
      } catch (e) {
        const m = String(e?.message || e || 'unknown error');
        const friendly =
          m.includes('429') ? 'Oops: API quota exceeded. Check Billing.' :
          m.includes('model_not_found') ? `Oops: model not found. Set MODEL_ID (e.g., ${MODEL_ID}).` :
          m.toLowerCase().includes('abort') ? 'Oops: model timed out. Please try again.' :
          `Oops: ${m}`;
        if (mid) await editMessageInThread(msg, mid, friendly);
        else sendMessageFast(msg, friendly);
      }
      return;
    }

    // Otherwise — triggers only (no LLM)
    processNonMention(update);
  } catch (e) {
    log('process error', String(e?.message || e));
  }
}

export const config = { api: { bodyParser: true } };
