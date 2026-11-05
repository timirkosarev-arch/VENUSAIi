
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getDatabase } from "firebase-admin/database";

const API_URL = "https://anymodel.org/v1/chat/completions";

const FREE_MODELS = new Set([
  "cx/gpt-6-luna",
  "cx/gpt-6.1-sol"
]);

const PRO_MODEL = "cx/gpt-6-astra";
const ADMIN_EMAIL = "flexadssq@gmail.com";
const PRO_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_MESSAGES = 40;
const MAX_CONTENT_CHARS = 250000;
const MAX_OUTPUT_TOKENS = 30000;

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif"
]);

function jsonError(res, status, message) {
  return res.status(status).json({ error: message });
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function getFirebaseAdminApp() {
  const existing = getApps().find(
    app => app.name === "venus-ai-api"
  );

  if (existing) return existing;

  let serviceAccount;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      serviceAccount = JSON.parse(
        process.env.FIREBASE_SERVICE_ACCOUNT_JSON
      );
    } catch (error) {
      throw new Error(
        "FIREBASE_SERVICE_ACCOUNT_JSON содержит некорректный JSON."
      );
    }
  } else {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY;

    if (!projectId || !clientEmail || !privateKey) {
      throw new Error(
        "Настройте FIREBASE_SERVICE_ACCOUNT_JSON либо FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL и FIREBASE_PRIVATE_KEY."
      );
    }

    serviceAccount = {
      project_id: projectId,
      client_email: clientEmail,
      private_key: privateKey.replace(/\\n/g, "\n")
    };
  }

  if (typeof serviceAccount.private_key === "string") {
    serviceAccount.private_key =
      serviceAccount.private_key.replace(/\\n/g, "\n");
  }

  const databaseURL = process.env.FIREBASE_DATABASE_URL;

  if (!databaseURL) {
    throw new Error(
      "Не задан FIREBASE_DATABASE_URL для Firebase Realtime Database."
    );
  }

  return initializeApp({
    credential: cert(serviceAccount),
    databaseURL
  }, "venus-ai-api");
}

function getBearerToken(req) {
  const header =
    req.headers.authorization ||
    req.headers.Authorization ||
    "";

  const match = String(header).match(/^Bearer\s+(.+)$/i);

  return match ? match[1].trim() : "";
}

async function requireActivePro(req) {
  const token = getBearerToken(req);

  if (!token) {
    const error = new Error(
      "Для GPT-6 ASTRO войдите в аккаунт с активной подпиской Pro."
    );
    error.statusCode = 401;
    throw error;
  }

  const app = getFirebaseAdminApp();

  let decoded;

  try {
    decoded = await getAuth(app).verifyIdToken(token, true);
  } catch (error) {
    const authError = new Error(
      "Не удалось подтвердить вход. Войдите в аккаунт заново."
    );
    authError.statusCode = 401;
    throw authError;
  }

  const email = normalizeEmail(decoded.email);

  if (!decoded.uid || !email) {
    const error = new Error(
      "В токене Firebase отсутствует email аккаунта."
    );
    error.statusCode = 403;
    throw error;
  }

  const snapshot = await getDatabase(app)
    .ref(`venusPro/grants/${decoded.uid}`)
    .get();

  const grant = snapshot.exists()
    ? snapshot.val()
    : null;

  const grantedAt = Number(grant?.grantedAt);
  const expiresAt = Number(grant?.expiresAt);
  const now = Date.now();

  const validGrant =
    grant &&
    normalizeEmail(grant.email) === email &&
    normalizeEmail(grant.grantedBy) === ADMIN_EMAIL &&
    Number.isFinite(grantedAt) &&
    Number.isFinite(expiresAt) &&
    grantedAt <= now + 5 * 60 * 1000 &&
    expiresAt > now &&
    expiresAt > grantedAt &&
    expiresAt - grantedAt <= PRO_DURATION_MS + 5 * 60 * 1000;

  if (!validGrant) {
    const error = new Error(
      "У этого аккаунта нет активной подписки Pro."
    );
    error.statusCode = 403;
    throw error;
  }

  return decoded;
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
    throw new Error(
      "Для фото разрешены только прямые ссылки ImgBB."
    );
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

  const finalUrl = new URL(
    response.url || parsed.toString()
  );

  if (
    finalUrl.protocol !== "https:" ||
    !isImgBBHost(finalUrl.hostname)
  ) {
    throw new Error(
      "ImgBB перенаправил запрос на неизвестный адрес."
    );
  }

  const contentType = (
    response.headers.get("content-type") || ""
  ).split(";")[0].trim().toLowerCase();

  if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
    throw new Error(
      `ImgBB вернул неподдерживаемый тип файла: ${contentType || "неизвестно"}.`
    );
  }

  const declaredLength = Number(
    response.headers.get("content-length") || 0
  );

  if (declaredLength > MAX_IMAGE_BYTES) {
    throw new Error(
      "Изображение слишком большое (лимит 5 МБ)."
    );
  }

  if (!response.body) {
    throw new Error(
      "Не удалось получить содержимое изображения."
    );
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

        throw new Error(
          "Изображение слишком большое (лимит 5 МБ)."
        );
      }

      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  if (!total) {
    throw new Error(
      "ImgBB вернул пустое изображение."
    );
  }

  return (
    `data:${contentType};base64,` +
    Buffer.concat(chunks).toString("base64")
  );
}

function validateDataImage(dataUrl) {
  const match = String(dataUrl).match(
    /^data:(image\/(?:png|jpe?g|webp|gif));base64,([a-z0-9+/=]+)$/i
  );

  if (!match) return false;

  const mime = match[1].toLowerCase() === "image/jpg"
    ? "image/jpeg"
    : match[1].toLowerCase();

  if (!ALLOWED_IMAGE_TYPES.has(mime)) {
    return false;
  }

  const estimatedBytes = Buffer.from(
    match[2],
    "base64"
  ).byteLength;

  return (
    estimatedBytes > 0 &&
    estimatedBytes <= MAX_IMAGE_BYTES
  );
}

async function normalizeContent(content) {
  if (typeof content === "string") {
    return content.slice(0, MAX_CONTENT_CHARS);
  }

  if (!Array.isArray(content)) return null;

  const parts = [];

  for (const part of content) {
    if (!part || typeof part !== "object") continue;

    if (
      part.type === "text" &&
      typeof part.text === "string"
    ) {
      parts.push({
        type: "text",
        text: part.text.slice(0, MAX_CONTENT_CHARS)
      });

      continue;
    }

    if (
      part.type === "image_url" &&
      typeof part.image_url?.url === "string"
    ) {
      const url = part.image_url.url;
      let visionUrl = null;

      if (url.startsWith("data:")) {
        if (validateDataImage(url)) {
          visionUrl = url;
        }
      } else if (/^https:\/\//i.test(url)) {
        visionUrl = await fetchImgBBAsDataUrl(url);
      }

      if (visionUrl) {
        parts.push({
          type: "image_url",
          image_url: {
            url: visionUrl,
            detail: ["low", "high"].includes(
              part.image_url.detail
            )
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

    return jsonError(
      res,
      405,
      "Method not allowed"
    );
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
    const body = typeof req.body === "string"
      ? JSON.parse(req.body)
      : req.body;

    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body)
    ) {
      return jsonError(
        res,
        400,
        "Некорректное тело запроса."
      );
    }

    const model = typeof body.model === "string"
      ? body.model
      : "";

    if (
      !FREE_MODELS.has(model) &&
      model !== PRO_MODEL
    ) {
      return jsonError(
        res,
        400,
        "Неизвестная модель. Выбери Flash, High или Pro High."
      );
    }

    if (model === PRO_MODEL) {
      try {
        await requireActivePro(req);
      } catch (error) {
        console.warn(
          "Pro access denied:",
          error.message
        );

        return jsonError(
          res,
          error.statusCode || 503,
          error.message ||
            "Не удалось проверить подписку Pro."
        );
      }
    }

    if (
      !Array.isArray(body.messages) ||
      body.messages.length === 0
    ) {
      return jsonError(
        res,
        400,
        "Нет сообщений для отправки"
      );
    }

    const messages = [];

    const validMessages = body.messages
      .filter(
        message =>
          message &&
          ["system", "user", "assistant"].includes(
            message.role
          )
      )
      .slice(-MAX_MESSAGES);

    for (const message of validMessages) {
      const content = await normalizeContent(
        message.content
      );

      if (content !== null && content !== "") {
        messages.push({
          role: message.role,
          content
        });
      }
    }

    if (
      !messages.length ||
      !messages.some(
        message => message.role === "user"
      )
    ) {
      return jsonError(
        res,
        400,
        "Нет корректных сообщений пользователя"
      );
    }

    // Лимит до 30 000 выходных токенов на запрос.
    // Реальное ограничение зависит от модели.

    const requestedTokens = Number(body.max_tokens);

    const maxTokens =
      Number.isFinite(requestedTokens) &&
      requestedTokens > 0
        ? Math.min(
            MAX_OUTPUT_TOKENS,
            Math.floor(requestedTokens)
          )
        : MAX_OUTPUT_TOKENS;

    const requestBody = {
      model,
      messages,
      stream: body.stream !== false,
      max_tokens: maxTokens
    };

    const upstreamHeaders = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: requestBody.stream
        ? "text/event-stream"
        : "application/json"
    };

    let upstream = await fetch(API_URL, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(requestBody)
    });

    // Если модель не поддерживает 30K,
    // пробуем 8192, затем 4096 токенов.

    for (const smallerLimit of [8192, 4096]) {
      if (
        upstream.ok ||
        requestBody.max_tokens <= smallerLimit
      ) {
        break;
      }

      if (
        ![400, 422].includes(upstream.status)
      ) {
        break;
      }

      const detail = await upstream.text();

      if (
        !/(?:max[_ -]?(?:completion[_ -]?)?tokens?|output.{0,20}tokens?|tokens?.{0,20}limit|context.{0,20}length)/i.test(detail)
      ) {
        return jsonError(
          res,
          502,
          `AnyModel API ${upstream.status}: ${detail.slice(0, 700)}`
        );
      }

      requestBody.max_tokens = smallerLimit;

      upstream = await fetch(API_URL, {
        method: "POST",
        headers: upstreamHeaders,
        body: JSON.stringify(requestBody)
      });
    }

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

      res.setHeader(
        "Cache-Control",
        "no-cache, no-transform"
      );

      res.setHeader(
        "Connection",
        "keep-alive"
      );

      res.setHeader(
        "X-Accel-Buffering",
        "no"
      );

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
      contentType ||
        "application/json; charset=utf-8"
    );

    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    return res.end(result);

  } catch (error) {
    console.error(
      "Venus AI API error:",
      error
    );

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
