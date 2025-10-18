// Telegram webhook on Vercel Edge (no Express, no app.listen)
export const runtime = 'edge';

const TG_TOKEN = process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN; // поддержим оба названия
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const MODEL_ID = process.env.MODEL_ID || 'gpt-4o-mini';
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  'You are an assistant. Always reply in concise, natural English. Do not switch languages.';

// --- helpers ---
const log = (...a) => { try { console.log(...a); } catch {} };

async function tg(method, payload) {
  // Telegram API запрос, не кидаем ошибку наружу, чтобы не ронять webhook
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
  } catch (e) {
    log('TG fetch error', method, String(e?.message || e));
  }
}

function buildPrompt(userText) {
  const rule = 'Always respond in English. Do not switch languages, even if the user writes in another language.';
  return `System: ${SYSTEM_PROMPT}\n${rule}\nUser: ${userText}\nAssistant:`;
}

async function askLLM(userText, signal) {
  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_KEY}`,
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

export default async function handler(req) {
  // healthcheck
  if (req.method === 'GET') return new Response('ok', { status: 200 });
  if (req.method !== 'POST') return new Response('ok', { status: 200 });

  // читаем апдейт
  let update = {};
  try { update = await req.json(); } catch {}

  const msg = update.message || update.edited_message || update.channel_post || update.edited_channel_post || null;
  const chatId = msg?.chat?.id;
  const text   = msg?.text ?? msg?.caption ?? '';

  // всегда отвечаем 200, чтобы TG не ретраил
  const done = new Response('ok', { status: 200 });

  if (!chatId) return done;

  // быстрый ping без модели (диагностика)
  if ((text || '').trim().toLowerCase() === '!ping') {
    tg('sendMessage', { chat_id: chatId, text: 'pong' });
    return done;
  }

  // проверка конфигурации
  if (!TG_TOKEN || !OPENAI_KEY) {
    tg('sendMessage', { chat_id: chatId, text: 'Oops: missing TELEGRAM_TOKEN or OPENAI_API_KEY on server.' });
    return done;
  }

  // показываем typing (fire-and-forget)
  tg('sendChatAction', { chat_id: chatId, action: 'typing' });

  // не игнорируй обновления по времени — Telegram может прислать их с задержкой;
  // если хочешь фильтр, делай мягче (напр., >5 минут)

  // до ~25с на модель (Edge держит около 30с)
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 25000);
    let reply;
    try { reply = await askLLM(text || '', ctrl.signal); }
    finally { clearTimeout(to); }

    // ⚠️ Без parse_mode, чтобы Markdown не ломал ответы с подчёркиваниями и т.п.
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

  return done;
}
