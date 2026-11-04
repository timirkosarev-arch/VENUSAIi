
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
      flash: 'gemini-3-flash'
    };

    if (!models[mode]) {
      return res.status(400).json({ error: 'Неизвестный режим' });
    }

    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: 'Нет сообщений' });
    }

    const safeMessages = messages
      .filter(m =>
        ['user', 'assistant'].includes(m.role) &&
        typeof m.content === 'string'
      )
      .slice(-40);

    const response = await fetch(
      'https://anymodel.org/v1/chat/completions',
      {
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
      }
    );

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
