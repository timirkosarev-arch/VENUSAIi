const API_URL = "https://anymodel.org/v1/chat/completions";

const ALLOWED_MODELS = new Set([
  "ag/gemini-3.1-flash-lite-preview",
  "cc/claude-sonnet-5-5"
]);

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif"
]);

function jsonError(res, status, message) {
  return res.status(status).json({ error: message });
}

function isImgBBHost(hostname) {
  const host = String(hostname || "").toLowerCase();

  return (
    host === "i.ibb.co" ||
    host === "i.ibb.co.com" ||
    host.endsWith(".ibb.co")
  );
}

async function fetchImgBBAsDataUrl(sourceUrl) {
  let parsed;

  try {
    parsed = new URL(sourceUrl);
  } catch (_) {
    throw new Error("Некорректная ссылка на изображение.");
  }

  if (
    parsed.protocol !== "https:" ||
    !isImgBBHost(parsed.hostname)
  ) {
    throw new Error("Для фото разрешены только прямые ссылки ImgBB.");
  }

  const response = await fetch(parsed.toString(), {
    method: "GET",
    headers: {
      Accept: "image/jpeg,image/png,image/webp,image/gif"
    },
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(
      `ImgBB не отдал изображение (HTTP ${response.status}).`
    );
  }

  const finalUrl = new URL(response.url || parsed.toString());

  if (
    finalUrl.protocol !== "https:" ||
    !isImgBBHost(finalUrl.hostname)
  ) {
    throw new Error("ImgBB перенаправил запрос на неизвестный адрес.");
  }

  const contentType = (
    response.headers.get("content-type") || ""
  )
    .split(";")[0]
    .trim()
    .toLowerCase();

  if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
    throw new Error(
      `ImgBB вернул неподдерживаемый тип файла: ${contentType || "неизвестно"}.`
    );
  }

  const declaredLength = Number(
    response.headers.get("content-length") || 0
  );

  if (declaredLength > MAX_IMAGE_BYTES) {
    throw new Error("Изображение слишком большое (лимит 5 МБ).");
  }

  if (!response.body) {
    throw new Error("Не удалось получить содержимое изображения.");
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      total += value.byteLength;

      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error("Изображение слишком большое (лимит 5 МБ).");
      }

      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  if (!total) {
    throw new Error("ImgBB вернул пустое изображение.");
  }

  const base64 = Buffer.concat(chunks).toString("base64");

  return `data:${contentType};base64,${base64}`;
}

async function normalizeContent(content) {
  if (typeof content === "string") {
    return content.slice(0, 250000);
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const parts = [];

  for (const part of content) {
    if (!part || typeof part !== "object") continue;

    if (part.type === "text" && typeof part.text === "string") {
      parts.push({
        type: "text",
        text: part.text.slice(0, 250000)
      });

      continue;
    }

    if (
      part.type === "image_url" &&
      part.image_url &&
      typeof part.image_url.url === "string"
    ) {
      const url = part.image_url.url;

      const isDataImage =
        /^data:image\/(png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i.test(url);

      let visionUrl = null;

      if (isDataImage) {
        visionUrl = url;
      } else if (/^https:\/\//i.test(url)) {
        visionUrl = await fetchImgBBAsDataUrl(url);
      }

      if (visionUrl) {
        parts.push({
          type: "image_url",
          image_url: {
            url: visionUrl,
            detail:
              part.image_url.detail === "low" ||
              part.image_url.detail === "high"
                ? part.image_url.detail
                : "auto"
          }
        });
      }
    }
  }

  return parts.length ? parts : null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return jsonError(res, 405, "Method not allowed");
  }

  const apiKey = process.env.API_KEY;

  if (!apiKey) {
    return jsonError(
      res,
      500,
      "API_KEY не настроен в Vercel Environment Variables"
    );
  }

  try {
    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;

    const model = body?.model || body?.models?.[0];

    if (!ALLOWED_MODELS.has(model)) {
      return jsonError(
        res,
        400,
        "Неизвестная модель. Выбери Flash или High."
      );
    }

    if (
      !Array.isArray(body?.messages) ||
      body.messages.length === 0
    ) {
      return jsonError(res, 400, "Нет сообщений для отправки");
    }

    const messages = [];

    const validMessages = body.messages
      .filter(
        message =>
          message &&
          ["system", "user", "assistant"].includes(message.role)
      )
      .slice(-40);

    for (const message of validMessages) {
      const content = await normalizeContent(message.content);

      if (content !== null && content !== "") {
        messages.push({
          role: message.role,
          content
        });
      }
    }

    if (
      !messages.length ||
      !messages.some(message => message.role === "user")
    ) {
      return jsonError(
        res,
        400,
        "Нет корректных сообщений пользователя"
      );
    }

    const requestBody = {
      model,
      messages,
      stream: body.stream !== false,
      max_tokens: Number.isInteger(body.max_tokens)
        ? Math.max(1, Math.min(body.max_tokens, 8192))
        : 8192
    };

    const upstream = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: requestBody.stream
          ? "text/event-stream"
          : "application/json"
      },
      body: JSON.stringify(requestBody)
    });

    if (!upstream.ok) {
      const rawError = await upstream.text();

      let detail = rawError;

      try {
        const parsed = JSON.parse(rawError);

        detail =
          parsed.error?.message ||
          parsed.message ||
          rawError;
      } catch (_) {}

      console.error(
        "AnyModel API error:",
        upstream.status,
        detail.slice(0, 1000)
      );

      return jsonError(
        res,
        502,
        `AnyModel API ${upstream.status}: ${detail.slice(0, 700)}`
      );
    }

    const contentType =
      upstream.headers.get("content-type") || "";

    if (
      contentType.includes("text/event-stream") &&
      upstream.body
    ) {
      res.statusCode = 200;

      res.setHeader(
        "Content-Type",
        "text/event-stream; charset=utf-8"
      );

      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      for await (const chunk of upstream.body) {
        if (res.destroyed) break;
        res.write(chunk);
      }

      return res.end();
    }

    const result = await upstream.text();

    res.statusCode = 200;

    res.setHeader(
      "Content-Type",
      contentType || "application/json; charset=utf-8"
    );

    res.setHeader("Cache-Control", "no-store");

    return res.end(result);

  } catch (error) {
    console.error("Venus AI API error:", error);

    if (res.headersSent) {
      return res.end();
    }

    return jsonError(
      res,
      500,
      error?.message || "Внутренняя ошибка API"
    );
  }
}
