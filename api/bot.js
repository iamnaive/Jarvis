const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VERCEL_URL = process.env.VERCEL_URL || 'https://jarvis-drab-three.vercel.app';

// Хранилище контекста
const chatContexts = new Map();

// Функция для отправки сообщений через Telegram API
async function sendTelegramMessage(chatId, text, replyToMessageId = null) {
  try {
    const payload = {
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown'
    };
    
    if (replyToMessageId) {
      payload.reply_to_message_id = replyToMessageId;
    }

    const response = await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      payload,
      { timeout: 10000 }
    );
    
    console.log('Message sent successfully:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error sending message:', error.response?.data || error.message);
    throw error;
  }
}

// Функция для получения информации о боте
async function getBotInfo() {
  try {
    const response = await axios.get(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getMe`,
      { timeout: 5000 }
    );
    return response.data;
  } catch (error) {
    console.error('Error getting bot info:', error.response?.data || error.message);
    throw error;
  }
}

// Установка вебхука
async function setWebhook() {
  try {
    const webhookUrl = `${VERCEL_URL}/api/bot`;
    const response = await axios.get(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=${webhookUrl}&drop_pending_updates=true`,
      { timeout: 10000 }
    );
    
    console.log('Webhook set:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error setting webhook:', error.response?.data || error.message);
    throw error;
  }
}

// Основной обработчик сообщений
app.post('/api/bot', async (req, res) => {
  console.log('📨 Received Telegram update:', JSON.stringify(req.body, null, 2));
  
  try {
    const update = req.body;
    
    if (update.message) {
      await handleMessage(update.message);
    }
    
    res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('❌ Error processing update:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function handleMessage(msg) {
  console.log('🔍 Processing message:', {
    message_id: msg.message_id,
    chat_id: msg.chat.id,
    chat_type: msg.chat.type,
    text: msg.text,
    from: msg.from.username
  });

  const chatId = msg.chat.id;
  const text = msg.text || '';
  
  // Получаем информацию о боте для username
  let botUsername;
  try {
    const botInfo = await getBotInfo();
    botUsername = botInfo.result.username;
    console.log('🤖 Bot username:', botUsername);
  } catch (error) {
    console.error('Error getting bot username:', error);
    return;
  }

  const isGroup = ['group', 'supergroup'].includes(msg.chat.type);
  const isPrivate = msg.chat.type === 'private';
  const isMentioned = isGroup && text.includes(`@${botUsername}`);
  const isReplyToBot = msg.reply_to_message && 
                      msg.reply_to_message.from && 
                      msg.reply_to_message.from.username === botUsername;

  console.log('🔍 Message analysis:', {
    isGroup,
    isPrivate,
    isMentioned,
    isReplyToBot,
    botUsername
  });

  // Определяем, нужно ли отвечать
  const shouldRespond = isPrivate || isMentioned || isReplyToBot;
  
  if (!shouldRespond) {
    console.log('⏭️ Skipping message - not addressed to bot');
    return;
  }

  try {
    // Очищаем текст от упоминаний
    const cleanText = text.replace(new RegExp(`@${botUsername}`, 'g'), '').trim();
    
    if (!cleanText) {
      await sendTelegramMessage(chatId, 'Привет! Чем могу помочь?', msg.message_id);
      return;
    }

    console.log('🧠 Processing with OpenAI, text:', cleanText);

    // Инициализируем контекст если нужно
    if (!chatContexts.has(chatId)) {
      chatContexts.set(chatId, [
        { 
          role: 'system', 
          content: `Ты полезный AI ассистент в Telegram. Будь дружелюбным и отвечай естественно. 
                   Текущая дата: ${new Date().toLocaleString('ru-RU')}`
        }
      ]);
    }

    const context = chatContexts.get(chatId);
    context.push({ role: 'user', content: cleanText });

    // Запрос к OpenAI
    const openaiResponse = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: context,
        max_tokens: 500,
        temperature: 0.7
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    const aiResponse = openaiResponse.data.choices[0].message.content.trim();
    console.log('✅ OpenAI response:', aiResponse);

    // Обновляем контекст
    context.push({ role: 'assistant', content: aiResponse });
    
    // Ограничиваем контекст
    if (context.length > 10) {
      context.splice(1, context.length - 10);
    }

    // Отправляем ответ
    await sendTelegramMessage(chatId, aiResponse, msg.message_id);

  } catch (error) {
    console.error('❌ Error in handleMessage:', {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status
    });

    let errorMessage = 'Извините, произошла ошибка. Попробуйте еще раз.';
    
    if (error.response?.status === 429) {
      errorMessage = 'Слишком много запросов. Подождите немного.';
    } else if (error.code === 'ECONNABORTED') {
      errorMessage = 'Время ожидания истекло. Попробуйте еще раз.';
    } else if (error.response?.status === 401) {
      errorMessage = 'Ошибка аутентификации с OpenAI. Проверьте API ключ.';
    }

    await sendTelegramMessage(chatId, errorMessage, msg.message_id);
  }
}

// Диагностические эндпоинты
app.get('/api/bot', async (req, res) => {
  try {
    const botInfo = await getBotInfo();
    const webhookInfo = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getWebhookInfo`);
    
    res.json({
      status: 'Bot is running!',
      timestamp: new Date().toISOString(),
      bot_info: botInfo.result,
      webhook_info: webhookInfo.data.result,
      active_chats: chatContexts.size,
      environment: {
        node_version: process.version,
        vercel_url: VERCEL_URL
      }
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Diagnostic failed', 
      details: error.message 
    });
  }
});

// Установка вебхука
app.post('/api/bot/set-webhook', async (req, res) => {
  try {
    const result = await setWebhook();
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Проверка переменных окружения (без раскрытия секретов)
app.get('/api/bot/debug', (req, res) => {
  res.json({
    has_telegram_token: !!TELEGRAM_TOKEN,
    has_openai_key: !!OPENAI_API_KEY,
    telegram_token_length: TELEGRAM_TOKEN ? TELEGRAM_TOKEN.length : 0,
    openai_key_starts_with: OPENAI_API_KEY ? OPENAI_API_KEY.substring(0, 7) + '...' : 'none',
    vercel_url: VERCEL_URL
  });
});

// Инициализация при старте
async function initializeBot() {
  console.log('🚀 Initializing Telegram Bot...');
  
  try {
    const botInfo = await getBotInfo();
    console.log('✅ Bot info:', botInfo.result);
    
    await setWebhook();
    console.log('✅ Webhook set successfully');
  } catch (error) {
    console.error('❌ Initialization failed:', error.message);
  }
}

// Запускаем инициализацию
initializeBot();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🤖 Bot server running on port ${PORT}`);
  console.log(`🌐 Webhook URL: ${VERCEL_URL}/api/bot`);
});

module.exports = app;
