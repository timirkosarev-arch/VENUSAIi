
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getDatabase } from "firebase-admin/database";

const ANYMODEL_URL = "https://anymodel.org/v1/chat/completions";

const MODELS = Object.freeze({
  flash: "cx/gpt-6-luna",
  high: "cx/gpt-6-sol",
  astro: "cx/gpt-6-astra"
});

const ADMIN_EMAIL = "flexadssq@gmail.com";
const PRO_MS = 30 * 24 * 60 * 60 * 1000;

const MAX_TOKENS = 30000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_CONTENT_CHARS = 250000;
const MAX_MESSAGES = 40;

const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif"
]);

const normalEmail = value =>
  String(value || "").trim().toLowerCase();

const httpError = (status, message) =>
  Object.assign(new Error(message), { status });

const sendError = (res, status, message) =>
  res.status(status).json({ error: message });

function adminApp() {
  const existing = getApps().find(
    app => app.name === "venus-ai-api"
  );

  if (existing) return existing;

  let account;

  try {
    account = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
      ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
      : {
          project_id: process.env.FIREBASE_PROJECT_ID,
          client_email: process.env.FIREBASE_CLIENT_EMAIL,
          private_key: process.env.FIREBASE_PRIVATE_KEY
        };
  } catch {
    throw httpError(
      500,
      "Некорректный FIREBASE_SERVICE_ACCOUNT_JSON."
    );
  }

  if (
    !account?.project_id ||
    !account?.client_email ||
    !account?.private_key
  ) {
    throw httpError(
      500,
      "Не настроен Firebase Admin в Vercel."
    );
  }

  if (!process.env.FIREBASE_DATABASE_URL) {
    throw httpError(
      500,
      "Не настроен FIREBASE_DATABASE_URL."
    );
  }

  account.private_key =
    account.private_key.replace(/\\n/g, "\n");

  return initializeApp({
    credential: cert(account),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  }, "venus-ai-api");
}

async function getUser(req) {
  const auth = String(req.headers.authorization || "");

  const token = auth.match(/^Bearer\s+(.+)$/i)?.[1];

  if (!token) {
    throw httpError(
      401,
      "Войдите в аккаунт Venus AI."
    );
  }

  try {
    return await getAuth(adminApp()).verifyIdToken(
      token,
      true
    );
  } catch {
    throw httpError(
      401,
      "Сессия истекла. Войдите в аккаунт заново."
    );
  }
}

async function checkPro(user) {
  const grantSnapshot = await getDatabase(adminApp())
    .ref(`venusPro/grants/${user.uid}`)
    .get();

  const g = grantSnapshot.val();
  const now = Date.now();

  const start = Number(g?.grantedAt);
  const end = Number(g?.expiresAt);

  const valid =
    g &&
    normalEmail(g.email) === normalEmail(user.email) &&
    normalEmail(g.grantedBy) === ADMIN_EMAIL &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start <= now + 300000 &&
    end > now &&
    end > start &&
    end - start <= PRO_MS + 300000;

  if (!valid) {
    throw httpError(
      403,
      "Для GPT-6 ASTRO нужна активная подписка Pro."
    );
  }
}

function imgBBHost(host) {
  return (
    host === "i.ibb.co" ||
    host === "i.ibb.co.com"
  );
}

async function imgBBToDataUrl(imageUrl) {
  let url;

  try {
    url = new URL(imageUrl);
  } catch {
    throw httpError(
      400,
      "Некорректная ссылка на фотографию."
    );
  }

  for (let redirects = 0; redirects <= 4; redirects++) {
    if (
      url.protocol !== "https:" ||
      !imgBBHost(url.hostname)
    ) {
      throw httpError(
        400,
        "Разрешены только прямые HTTPS-ссылки ImgBB."
      );
    }

    const response = await fetch(url.href, {
      headers: {
        Accept: "image/jpeg,image/png,image/webp,image/gif"
      },
      redirect: "manual"
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");

      if (!location) {
        throw httpError(
          400,
          "ImgBB вернул пустое перенаправление."
        );
      }

      url = new URL(location, url);
      continue;
    }

    if (!response.ok) {
      throw httpError(
        502,
        `ImgBB: HTTP ${response.status}.`
      );
    }

    const type = (
      response.headers.get("content-type") || ""
    ).split(";")[0].toLowerCase();

    if (!IMAGE_TYPES.has(type)) {
      throw httpError(
        400,
        "Неподдерживаемый формат изображения."
      );
    }

    if (
      Number(response.headers.get("content-length") || 0) >
      MAX_IMAGE_BYTES
    ) {
      throw httpError(
        413,
        "Размер изображения превышает 5 МБ."
      );
    }

    if (!response.body) {
      throw httpError(
        502,
        "ImgBB вернул пустой файл."
      );
    }

    const reader = response.body.getReader();
    const buffers = [];
    let size = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        size += value.length;

        if (size > MAX_IMAGE_BYTES) {
          await reader.cancel();

          throw httpError(
            413,
            "Размер изображения превышает 5 МБ."
          );
        }

        buffers.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }

    if (!size) {
      throw httpError(
        502,
        "Пустой файл изображения."
      );
    }

    return (
      `data:${type};base64,` +
      Buffer.concat(buffers).toString("base64")
    );
  }

  throw httpError(
    400,
    "Слишком много перенаправлений ImgBB."
  );
}

async function normalizeContent(content) {
  if (typeof content === "string") {
    return content.slice(0, MAX_CONTENT_CHARS);
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const result = [];

  for (const item of content) {
    if (
      item?.type === "text" &&
      typeof item.text === "string"
    ) {
      result.push({
        type: "text",
        text: item.text.slice(0, MAX_CONTENT_CHARS)
      });
    } else if (
      item?.type === "image_url" &&
      typeof item.image_url?.url === "string"
    ) {
      let url = item.image_url.url;

      if (url.startsWith("data:")) {
        const match = url.match(
          /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/
        );

        if (
          !match ||
          Buffer.from(match[2], "base64").length >
            MAX_IMAGE_BYTES
        ) {
          throw httpError(
            400,
            "Неверное изображение или размер больше 5 МБ."
          );
        }
      } else {
        url = await imgBBToDataUrl(url);
      }

      result.push({
        type: "image_url",
        image_url: {
          url,
          detail: "auto"
        }
      });
    }
  }

  return result.length ? result : null;
}

function isTokenLimitError(status, message) {
  return (
    [400, 422].includes(status) &&
    /(?:max[_ -]?(?:completion[_ -]?)?tokens?|output.{0,20}tokens?|context.{0,20}length)/i.test(message)
  );
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return sendError(
      res,
      405,
      "Метод не поддерживается."
    );
  }

  try {
    if (!process.env.API_KEY) {
      throw httpError(
        500,
        "API_KEY не настроен в Vercel."
      );
    }

    const user = await getUser(req);

    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;

    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body)
    ) {
      throw httpError(
        400,
        "Некорректный запрос."
      );
    }

    const model = MODELS[body.model] || body.model;

    if (!Object.values(MODELS).includes(model)) {
      throw httpError(
        400,
        "Неизвестная модель Venus AI."
      );
    }

    if (model === MODELS.astro) {
      await checkPro(user);
    }

    if (
      !Array.isArray(body.messages) ||
      body.messages.length === 0
    ) {
      throw httpError(
        400,
        "Нет сообщений для модели."
      );
    }

    const messages = [];

    for (const msg of body.messages.slice(-MAX_MESSAGES)) {
      if (
        !["system", "user", "assistant"].includes(msg?.role)
      ) {
        continue;
      }

      const content = await normalizeContent(msg.content);

      if (
        content &&
        (!Array.isArray(content) || content.length)
      ) {
        messages.push({
          role: msg.role,
          content
        });
      }
    }

    if (!messages.some(m => m.role === "user")) {
      throw httpError(
        400,
        "Нет сообщения пользователя."
      );
    }

    const requestTokens = Number(body.max_tokens);

    const maxTokens =
      Number.isFinite(requestTokens) &&
      requestTokens >= 1
        ? Math.min(
            MAX_TOKENS,
            Math.floor(requestTokens)
          )
        : 8192;

    const stream = body.stream === true;

    const payload = {
      model,
      messages,
      stream,
      max_tokens: maxTokens
    };

    const headers = {
      Authorization: `Bearer ${process.env.API_KEY}`,
      "Content-Type": "application/json",
      Accept: stream
        ? "text/event-stream"
        : "application/json"
    };

    let upstream;

    const limits = [
      ...new Set(
        [maxTokens, 8192, 4096, 2048].filter(
          n => n <= maxTokens
        )
      )
    ];

    let lastError = "";

    for (const limit of limits) {
      payload.max_tokens = limit;

      upstream = await fetch(ANYMODEL_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });

      if (!upstream.ok) {
        const raw = await upstream.text();
        let reason = raw;

        try {
          const data = JSON.parse(raw);

          reason =
            data.error?.message ||
            data.error ||
            data.message ||
            raw;
        } catch {}

        lastError = String(reason).slice(0, 450);

        if (
          isTokenLimitError(upstream.status, lastError)
        ) {
          continue;
        }

        throw httpError(
          502,
          `AnyModel ${upstream.status}: ${lastError}`
        );
      }

      if (stream) break;

      const raw = await upstream.text();
      let parsed;

      try {
        parsed = JSON.parse(raw);
      } catch {
        throw httpError(
          502,
          "AnyModel вернул некорректный JSON."
        );
      }

      if (parsed?.error) {
        const detail =
          typeof parsed.error === "string"
            ? parsed.error
            : parsed.error.message;

        throw httpError(
          502,
          String(detail || "Ошибка AnyModel.").slice(0, 450)
        );
      }

      res.setHeader("Cache-Control", "no-store");

      res.setHeader(
        "Content-Type",
        "application/json; charset=utf-8"
      );

      return res.status(200).send(raw);
    }

    if (!upstream?.ok || !stream) {
      throw httpError(
        502,
        lastError || "Модель не вернула текст."
      );
    }

    res.statusCode = 200;

    res.setHeader(
      "Content-Type",
      upstream.headers.get("content-type") ||
        "text/event-stream; charset=utf-8"
    );

    res.setHeader(
      "Cache-Control",
      "no-cache, no-transform"
    );

    res.setHeader(
      "X-Accel-Buffering",
      "no"
    );

    if (!upstream.body) {
      throw httpError(
        502,
        "Сервер не предоставил поток ответа."
      );
    }

    for await (const chunk of upstream.body) {
      if (res.destroyed) break;
      res.write(chunk);
    }

    return res.end();

  } catch (error) {
    console.error(
      "Venus AI API:",
      error.status || 500,
      error.message || "unknown"
    );

    if (res.headersSent) {
      return res.end();
    }

    return sendError(
      res,
      error.status || 500,
      error.message || "Ошибка сервера Venus AI."
    );
  }
}
