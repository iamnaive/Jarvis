// Vercel Node Serverless Telegram webhook (no Express)
// Path: /api/bot
// Env: TELEGRAM_TOKEN (or BOT_TOKEN), OPENAI_API_KEY, MODEL_ID (e.g., gpt-4o-mini), optional SYSTEM_PROMPT

// ---------- utilities ----------
const TG_TOKEN = process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const MODEL_ID   = process.env.MODEL_ID || 'gpt-4o-mini';

function log(...a) { try { console.log(...a); } catch {} }
const rnd = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function tg(method, payload) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      log('TG error', method, r.status, t);
    }
  } catch (e) { log('TG fetch error', method, String(e?.message || e)); }
}

// ---------- canned answers (instant, no-LLM) ----------
const WL_LINES = [
  "Guaranteed whitelist = **5** Woolly Eggs NFTs.",
  "Own **5** Woolly Eggs → you’re guaranteed on the whitelist.",
  "Whitelist is guaranteed when you hold **5** Woolly Eggs NFTs.",
  "With **5** Woolly Eggs you’re auto-whitelisted."
];
const WE_ROLE_LINES = [
  "Telegram **WE** role requires **10** Syndicate NFTs.",
  "To get the **WE** role in Telegram, hold **10** Syndicate NFTs.",
  "**WE** role → hold **10** Syndicate NFTs (Telegram).",
  "You’ll receive the **WE** Telegram role once you hold **10** Syndicate NFTs."
];
const GAME_LINES = [
  "Want to earn some WOOL? Try the mini-game: https://wooligotchi.vercel.app/",
  "You can grind a bit of WOOL here: https://wooligotchi.vercel.app/",
  "Small WOOL boost: play https://wooligotchi.vercel.app/",
  "For a little WOOL, check: https://wooligotchi.vercel.app/"
];

// Keywords (both EN/RU)
const RE_WL  = /\b(whitelist|allowlist|вайт|вайтлист|аллоулист)\b/i;
const RE_WE  = /\b(we\s*role|роль\s*we|роль|we-?роль|ролька)\b/i;
const RE_SYN = /\b(syndicate|синдикат)\b/i;      // pair with RE_WE
const RE_GAME = /\b(wooligotchi|wooli?gotchi|игра|game|wool)\b/i;
const RE_BYE  = /^(thanks|thank you|ok|okay|got it|all good|bye|goodbye)$/i;

// ---------- LLM ----------
function buildSystemPrompt() {
  const base = process.env.SYSTEM_PROMPT || `
You are “Jarvis”, a concise, friendly assistant and a resident of the Woolly Eggs universe (NFT collection).
Always reply in ENGLISH only.
Style: calm, neutral, laconic. No small talk unless the user clearly wants it.
Rules:
- Be brief: 1–3 sentences or up to 5 short bullets max (<= ~90 words).
- Do NOT proactively continue the conversation or ask follow-ups unless necessary.
- If user says thanks/ok/bye, reply with one short closing line and stop.
- If something about Woolly Eggs is unknown, say “I’m not sure” (do NOT invent lore).
- If asked about whitelist: guaranteed whitelist requires **5 Woolly Eggs NFTs**.
- If asked about the Telegram WE role: it requires **10 Syndicate NFTs**.
- If user asks about earning a bit of WOOL, suggest the mini-game: https://wooligotchi.vercel.app/
`;
  return base.trim();
}

function buildPrompt(userText) {
  const englishRule =
    "Always respond in English. Don’t switch languages, even if the user writes in another language.";
  return `System: ${buildSystemPrompt()}\n${englishRule}\nUser: ${userText}\nAssistant:`;
}

async function askLLM(text, signal) {
  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: MODEL_ID, input: buildPrompt(text) }),
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

// ---------- webhook handler ----------
export default async function handler(req, res) {
  // healthcheck and method guard
  if (req.method === 'GET') return res.status(200).send('ok');
  if (req.method !== 'POST') return res.status(200).send('ok');

  if (!TG_TOKEN) { return res.status(200).send('ok'); } // nothing we can do

  // read raw body (no Express)
  let body = '';
  await new Promise(resolve => { req.on('data', c => body += c); req.on('end', resolve); });
  let update = {};
  try { update = body ? JSON.parse(body) : {}; } catch {}

  const msg    = update.message || update.edited_message || update.channel_post || update.edited_channel_post || null;
  const chatId = msg?.chat?.id;
  const text   = (msg?.text ?? msg?.caption ?? '').trim();

  const ACK = () => res.status(200).send('ok'); // always ack TG
  if (!chatId) return ACK();

  // graceful short-close
  if (RE_BYE.test(text.toLowerCase())) {
    await tg('sendMessage', { chat_id: chatId, text: rnd([
      "Anytime. Take care!",
      "You're welcome. Have a good one!",
      "Glad to help. See you!"
    ]), reply_to_message_id: msg.message_id });
    return ACK();
  }

  // canned routes (instant)
  const lower = text.toLowerCase();
  if (RE_WL.test(lower)) {
    const line = rnd(WL_LINES);
    await tg('sendMessage', { chat_id: chatId, text: line, reply_to_message_id: msg.message_id });
    if (RE_GAME.test(lower)) {
      await tg('sendMessage', { chat_id: chatId, text: rnd(GAME_LINES), reply_to_message_id: msg.message_id });
    }
    return ACK();
  }

  if (RE_WE.test(lower) || (RE_WE.test(lower) && RE_SYN.test(lower))) {
    const line = rnd(WE_ROLE_LINES);
    await tg('sendMessage', { chat_id: chatId, text: line, reply_to_message_id: msg.message_id });
    return ACK();
  }

  if (RE_GAME.test(lower)) {
    await tg('sendMessage', { chat_id: chatId, text: rnd(GAME_LINES), reply_to_message_id: msg.message_id });
    return ACK();
  }

  // empty/too vague → don't drag conversation
  if (!text) {
    await tg('sendMessage', { chat_id: chatId, text: "What do you need?", reply_to_message_id: msg.message_id });
    return ACK();
  }

  // typing (fire-and-forget)
  tg('sendChatAction', { chat_id: chatId, action: 'typing' });

  if (!OPENAI_KEY) {
    await tg('sendMessage', { chat_id: chatId, text: "OpenAI API key is missing on the server." });
    return ACK();
  }

  // LLM path (keep it short on Hobby: ~9s timeout)
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 9000);
    let reply;
    try { reply = await askLLM(text, ctrl.signal); }
    finally { clearTimeout(to); }
    await tg('sendMessage', { chat_id: chatId, text: reply, reply_to_message_id: msg.message_id });
  } catch (e) {
    const m = String(e?.message || e || 'unknown error');
    const friendly =
      m.includes('429') ? 'Oops: API quota exceeded. Check Billing.' :
      m.includes('model_not_found') ? 'Oops: model not found. Set MODEL_ID (e.g., gpt-4o-mini).' :
      m.toLowerCase().includes('abort') ? 'Oops: model timed out. Please try again.' :
      `Oops: ${m}`;
    await tg('sendMessage', { chat_id: chatId, text: friendly, reply_to_message_id: msg.message_id });
  }

  return ACK();
}
