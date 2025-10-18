async function askLLM(text) {
  const model = process.env.MODEL_ID || 'gpt-4o-mini';
  const system = process.env.SYSTEM_PROMPT ||
    'You are an assistant. Always reply in concise, natural English. Do not switch languages.';
  const rule = 'Always respond in English. Do not switch languages, even if the user writes in another language.';
  const prompt = `System: ${system}\n${rule}\nUser: ${text}\nAssistant:`;

  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: prompt })
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
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
}

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).send('ok');
  if (req.method !== 'POST') return res.status(200).send('ok');

  // читаем raw body (в serverless JSON может не быть спарсен)
  let body = '';
  await new Promise(resolve => { req.on('data', c => body += c); req.on('end', resolve); });
  let update = {};
  try { update = body ? JSON.parse(body) : {}; } catch {}

  const msg = update.message || update.edited_message || update.channel_post || update.edited_channel_post || null;
  const chatId = msg?.chat?.id;
  const text = msg?.text ?? msg?.caption ?? '';

  if (!chatId) return res.status(200).send('ok');

  if ((text || '').trim().toLowerCase() === '!ping') {
    await tg('sendMessage', { chat_id: chatId, text: 'pong' });
    return res.status(200).send('ok');
  }

  const TOKEN = process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN;
  if (!TOKEN || !process.env.OPENAI_API_KEY) {
    await tg('sendMessage', { chat_id: chatId, text: 'Oops: missing TELEGRAM_TOKEN/BOT_TOKEN or OPENAI_API_KEY.' });
    return res.status(200).send('ok');
  }

  // показываем typing (fire-and-forget)
  tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(()=>{});

  try {
    // держим ≤9s, чтобы не упереться в таймаут Hobby
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 9000);
    let reply;
    try { reply = await askLLM(text || '', ctrl.signal); }
    finally { clearTimeout(t); }

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

  return res.status(200).send('ok');
}
