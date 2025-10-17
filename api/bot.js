const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WEBHOOK_URL = `${process.env.VERCEL_URL}/api/bot`;

// Используем polling для разработки или вебхук для продакшена
const bot = process.env.NODE_ENV === 'production' 
  ? new TelegramBot(TELEGRAM_TOKEN, { webHook: true })
  : new TelegramBot(TELEGRAM_TOKEN, { polling: false });

if (process.env.NODE_ENV === 'production') {
  bot.setWebHook(WEBHOOK_URL);
}

// Хранилище контекста диалогов
const chatContexts = new Map();

// Функция для очистки старых контекстов
setInterval(() => {
  const now = Date.now();
  for (const [chatId, data] of chatContexts.entries()) {
    if (now - data.lastActivity > 30 * 60 * 1000) { // 30 минут
      chatContexts.delete(chatId);
    }
  }
}, 10 * 60 * 1000); // Каждые 10 минут

app.post('/api/bot', async (req, res) => {
  console.log('Received update:', JSON.stringify(req.body, null, 2));
  
  try {
    const update = req.body;
    
    if (update.message) {
      await handleMessage(update.message);
    } else if (update.edited_message) {
      await handleMessage(update.edited_message);
    }
    
    res.sendStatus(200);
  } catch (error) {
    console.error('Error processing update:', error);
    res.sendStatus(500);
  }
});

async function handleMessage(msg) {
  // Игнорируем старые сообщения
  if (Date.now() / 1000 - msg.date > 60) {
    return;
  }

  const chatId = msg.chat.id;
  const text = msg.text || '';
  const username = (await bot.getMe()).username;
  
  console.log(`Processing message from ${msg.from.username}: ${text}`);

  // Проверяем, нужно ли отвечать
  const isGroup = ['group', 'supergroup'].includes(msg.chat.type);
  const isPrivate = msg.chat.type === 'private';
  const isMentioned = isGroup && text.includes(`@${username}`);
  const isReplyToBot = msg.reply_to_message && 
                      msg.reply_to_message.from && 
                      msg.reply_to_message.from.username === username;

  // Отвечаем только если:
  // - Личный чат ИЛИ
  // - Упоминание бота ИЛИ 
  // - Ответ на сообщение бота
  if (!isPrivate && !isMentioned && !isReplyToBot) {
    console.log('Ignoring message - not addressed to bot');
    return;
  }

  try {
    // Очищаем сообщение от упоминаний
    const cleanText = text.replace(new RegExp(`@${username}`, 'g'), '').trim();
    
    if (!cleanText) {
      await bot.sendMessage(chatId, 'Чем могу помочь?', {
        reply_to_message_id: msg.message_id
      });
      return;
    }

    // Получаем или инициализируем контекст
    if (!chatContexts.has(chatId)) {
      chatContexts.set(chatId, {
        messages: [
          { 
            role: 'system', 
            content: `Ты полезный ассистент в Telegram чате. Отвечай кратко и естественно. 
                     Текущее время: ${new Date().toLocaleString('ru-RU')}`
          }
        ],
        lastActivity: Date.now()
      });
    }

    const contextData = chatContexts.get(chatId);
    contextData.lastActivity = Date.now();
    
    const context = contextData.messages;
    
    // Добавляем сообщение пользователя
    context.push({ role: 'user', content: cleanText });

    // Получаем ответ от OpenAI (GPT-4o-mini)
    console.log('Sending request to OpenAI...');
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini', // Можно заменить на 'gpt-4', 'gpt-4o'
        messages: context,
        max_tokens: 500,
        temperature: 0.7,
        presence_penalty: 0.3,
        frequency_penalty: 0.3
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    const aiResponse = response.data.choices[0].message.content.trim();
    console.log('OpenAI response:', aiResponse);
    
    // Обновляем контекст
    context.push({ role: 'assistant', content: aiResponse });
    
    // Ограничиваем размер контекста (последние 12 сообщений)
    if (context.length > 12) {
      context.splice(1, context.length - 12);
    }

    // Отправляем ответ
    await bot.sendMessage(chatId, aiResponse, {
      reply_to_message_id: msg.message_id,
      parse_mode: 'Markdown'
    });

  } catch (error) {
    console.error('Error details:', {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status
    });

    let errorMessage = 'Произошла ошибка при обработке запроса';
    
    if (error.response?.status === 429) {
      errorMessage = 'Превышен лимит запросов. Попробуйте позже.';
    } else if (error.code === 'ECONNABORTED') {
      errorMessage = 'Таймаут запроса. Попробуйте еще раз.';
    } else if (error.response?.status === 401) {
      errorMessage = 'Ошибка аутентификации API. Проверьте ключ OpenAI.';
    }

    await bot.sendMessage(chatId, errorMessage, {
      reply_to_message_id: msg.message_id
    });
  }
}

// Эндпоинты для управления
app.get('/api/bot', (req, res) => {
  const memoryUsage = process.memoryUsage();
  res.json({
    status: 'Bot is running!',
    timestamp: new Date().toISOString(),
    activeChats: chatContexts.size,
    memory: {
      used: Math.round(memoryUsage.heapUsed / 1024 / 1024) + 'MB',
      total: Math.round(memoryUsage.heapTotal / 1024 / 1024) + 'MB'
    }
  });
});

// Очистка контекста
app.delete('/api/bot/context/:chatId', (req, res) => {
  const chatId = parseInt(req.params.chatId);
  chatContexts.delete(chatId);
  res.json({ success: true, message: 'Context cleared' });
});

// Установка вебхука
app.post('/api/bot/set-webhook', async (req, res) => {
  try {
    const result = await bot.setWebHook(WEBHOOK_URL);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Удаление вебхука
app.post('/api/bot/delete-webhook', async (req, res) => {
  try {
    const result = await bot.deleteWebHook();
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot server running on port ${PORT}`);
  console.log(`Webhook URL: ${WEBHOOK_URL}`);
});

module.exports = app;
