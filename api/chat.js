export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const key = process.env.API_KEY;
    if (!key) {
      return res.status(500).json({ error: 'API_KEY не настроен' });
    }

    const body = typeof req.body === 'string'
      ? JSON.parse(req.body)
      : req.body;

    const messages = body?.messages;
    const mode = body?.mode || 'normal';

    const models = {
      normal: 'am/nemotron-3-ultra-550b-a55b',
      flash: 'ag/gemini-3.1-flash-lite-preview',
      high: 'cc/claude-sonnet-5-5'
    };

    if (!Object.prototype.hasOwnProperty.call(models, mode)) {
      return res.status(400).json({ error: 'Неизвестный режим модели' });
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Нет сообщений' });
    }

    // Keep text and OpenAI-compatible image_url parts. The previous handler
    // accepted only string content, silently dropping every message with photos.
    function sanitizeContent(content) {
      if (typeof content === 'string') {
        return content.slice(0, 150_000);
      }

      if (!Array.isArray(content)) return null;

      const parts = [];
      for (const part of content) {
        if (!part || typeof part !== 'object') continue;

        if (part.type === 'text' && typeof part.text === 'string') {
          parts.push({ type: 'text', text: part.text.slice(0, 150_000) });
          continue;
        }

        if (part.type === 'image_url' && part.image_url &&
            typeof part.image_url.url === 'string') {
          const url = part.image_url.url;
          const isDataImage = /^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(url);
          const isHttpsImage = /^https:\/\//i.test(url);
          if ((isDataImage || isHttpsImage) && url.length <= 3_800_000) {
            parts.push({
              type: 'image_url',
              image_url: { url, detail: 'auto' }
            });
          }
        }
      }

      return parts.length ? parts : null;
    }

    const systemMessage = messages
      .filter(m => m?.role === 'system')
      .map(m => ({ role: 'system', content: sanitizeContent(m.content) }))
      .filter(m => m.content !== null)
      .slice(-1);

    const conversation = messages
      .filter(m => m && ['user', 'assistant'].includes(m.role))
      .map(m => ({ role: m.role, content: sanitizeContent(m.content) }))
      .filter(m => m.content !== null)
      .slice(-40);

    const safeMessages = [...systemMessage, ...conversation];
    if (!conversation.length) {
      return res.status(400).json({ error: 'Нет корректных сообщений пользователя' });
    }

    const response = await fetch('https://anymodel.org/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream'
      },
      body: JSON.stringify({
        model: models[mode],
        messages: safeMessages,
        stream: true
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('API ERROR:', response.status, error);
      return res.status(502).json({
        error: `API ${response.status}: ${error.slice(0, 350)}`
      });
    }

    if (!response.body) {
      return res.status(502).json({ error: 'Пустой ответ API' });
    }

    const type = response.headers.get('content-type') || '';
    if (!type.includes('text/event-stream')) {
      const error = await response.text();
      return res.status(502).json({
        error: 'Неправильный формат ответа: ' + error.slice(0, 300)
      });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');

    for await (const chunk of response.body) {
      if (res.destroyed) break;
      res.write(chunk);
    }
    res.end();
  } catch (error) {
    console.error('SERVER ERROR:', error);
    if (!res.headersSent) {
      return res.status(500).json({
        error: error.message || 'Ошибка сервера'
      });
    }
    res.end();
  }
}
