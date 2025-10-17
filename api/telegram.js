// api/telegram.js — Telegram webhook on Vercel Edge (долгий таймаут, без Telegraf).
// Env vars (Vercel → Project → Settings → Environment Variables):
//   BOT_TOKEN        - Telegram BotFather token
//   OPENAI_API_KEY   - OpenAI API key (billing enabled in the same org/project)
//   MODEL_ID         - e.g. "gpt-4o-mini" (стартовый вариант; позже можно "gpt-5" / "gpt-5-mini")
//   SYSTEM_PROMPT    - optional, global style/instructions (English-only по умолчанию)

export const runtime = 'edge';

const MODEL_ID = process.env.MODEL_ID || 'gpt-4o-mini';
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  'You are an assistant. Always reply in concise, natural English. Do not switch languages.';

// --- helpers ---
const log = (...a) => { try { console.log(...a); } catch {} };

function buildPrompt(userText) {
  const englishRule =
    'Always respond in English. Do not switch languages, even if the user writes in another language.';
  return `System: ${SYSTEM_PROMPT}\n${englishRule}\nUser: ${userText}\nAssistant:`;
}

async function askLLM(userText, signal) {
  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: MODEL_ID, input: buildPrompt(userText) }),
    signal
  });
  if (!r.ok) {
    let msg = `LLM error ${r.status}`;
    try { const j = await r.json(); if (j?.error?.message) msg += `: ${j.error.message}`; } catch {}
    throw new Error(msg);
  }
  const data = await r.json().catch(() => ({}));
  return data.output_text ?? data.output?.[0]?.content?.[0]?.text ?? 'I could not produce a response.';
}

async function tg(method, payload) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const t = await res.text().catch(()=>'');
      log('TG error', method, res.status, t);
    }
  } catch (e) {
    log('TG fetch error', method, String(e?.message || e));
  }
}

// --- handler ---
export default async function handler(req) {
  // healthcheck
  if (req.method === 'GET') return new Response('ok', { status: 200 });
  if (req.method !== 'POST') return new Response('ok', { status: 200 });

  let update = {};
  try { update = await req.json(); } catch {}

  // поддерживаем разные типы апдейтов (личные сообщения, редактирования, посты в канале)
  const msg = update.message || update.edited_message || update.channel_post || update.edited_channel_post || null;
  const chatId = msg?.chat?.id;
  const text   = msg?.text ?? msg?.caption ?? '';

  if (!chatId) return new Response('ok', { status: 200 });

  // быстрый пинг без модели — удобно для диагностики
  if (text && text.trim().toLowerCase() === '!ping') {
    await tg('sendMessage', { chat_id: chatId, text: 'pong' });
    return new Response('ok', { status: 200 });
  }

  // проверка env заранее, чтобы не падать 500
  if (!process.env.BOT_TOKEN || !process.env.OPENAI_API_KEY) {
    await tg('sendMessage', { chat_id: chatId, text: 'Oops: missing BOT_TOKEN or OPENAI_API_KEY on server.' });
    return new Response('ok', { status: 200 });
  }

  // показываем "typing" (fire-and-forget)
  tg('sendChatAction', { chat_id: chatId, action: 'typing' });

  try {
    // даём модели до ~25s (Edge держит ~30s)
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 25000);
    let reply;
    try { reply = await askLLM(text || '', ctrl.signal); }
    finally { clearTimeout(to); }

    await tg('sendMessage', { chat_id: chatId, text: reply });
  } catch (e) {
    const m = String(e?.message || e || 'unknown error');
    const friendly =
      m.includes('429') ? 'Oops: API quota exceeded. Check Billing.' :
      m.includes('model_not_found') ? 'Oops: model not found. Set MODEL_ID (e.g., gpt-4o-mini).' :
      m.toLowerCase().includes('abort') ? 'Oops: model timed out. Please try again.' :
      `Oops: ${m}`;
    await tg('sendMessage', { chat_id: chatId, text: friendly });
  }

  // Telegram должен получить 200 в любом случае, иначе он будет ретраить
  return new Response('ok', { status: 200 });
}
