
import admin from "firebase-admin";

const API_URL = "https://anymodel.org/v1/chat/completions";

const MODELS = new Set([
  "cx/gpt-6-luna",
  "cx/gpt-6.1-sol",
  "cx/gpt-6-astra"
]);

const ADMIN_EMAIL = "flexadssq@gmail.com";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif"
]);

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  );

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}

const auth = admin.auth();
const db = admin.database();

function jsonError(res, status, message) {
  return res.status(status).json({ error: message });
}

function isImgBBHost(hostname) {
  const host = String(hostname || "").toLowerCase();

  return host === "i.ibb.co" ||
    host === "i.ibb.co.com" ||
    host.endsWith(".ibb.co");
}

async function fetchImgBBAsDataUrl(sourceUrl) {
  const parsed = new URL(sourceUrl);

  if (
    parsed.protocol !== "https:" ||
    !isImgBBHost(parsed.hostname)
  ) {
    throw new Error("Разрешены только ссылки ImgBB.");
  }

  const response = await fetch(parsed.toString(), {
    headers: {
      Accept: "image/jpeg,image/png,image/webp,image/gif"
    },
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error("Не удалось загрузить изображение.");
  }

  const finalUrl = new URL(response.url);

  if (
    finalUrl.protocol !== "https:" ||
    !isImgBBHost(finalUrl.hostname)
  ) {
    throw new Error("Недопустимый адрес перенаправления.");
  }

  const contentType = (
    response.headers.get("content-type") || ""
  ).split(";")[0].trim().toLowerCase();

  if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
    throw new Error("Неподдерживаемый формат изображения.");
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
        throw new Error("Изображение больше 5 МБ.");
      }

      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return `data:${contentType};base64,${Buffer.concat(chunks).toString("base64")}`;
}

async function normalizeContent(content) {
  if (typeof content === "string") {
    return content.slice(0, 250000);
  }

  if (!Array.isArray(content)) return null;

  const parts = [];

  for (const part of content) {
    if (!part || typeof part !== "object") continue;

    if (part.type === "text" && typeof part.text === "string") {
      parts.push({
        type: "text",
        text: part.text.slice(0, 250000)
      });
    }

    if (
      part.type === "image_url" &&
      typeof part.image_url?.url === "string"
    ) {
      const url = part.image_url.url;

      const isDataImage =
        /^data:image\/(png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i.test(url);

      let imageUrl = null;

      if (isDataImage) {
        imageUrl = url;
      } else if (/^https:\/\//i.test(url)) {
        imageUrl = await fetchImgBBAsDataUrl(url);
      }

      if (imageUrl) {
        parts.push({
          type: "image_url",
          image_url: {
            url: imageUrl,
            detail: ["low", "high"].includes(part.image_url.detail)
              ? part.image_url.detail
              : "auto"
          }
        });
      }
    }
  }

  return parts.length ? parts : null;
}

async function authenticate(req) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    throw new Error("UNAUTHORIZED");
  }

  const token = header.slice(7);
  return auth.verifyIdToken(token);
}

async function checkPro(uid) {
  const snapshot = await db.ref(`proUsers/${uid}`).get();
  const data = snapshot.val();

  if (!data || data.active !== true) return false;

  return Number(data.expiresAt) > Date.now();
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return jsonError(res, 405, "Method not allowed");
  }

  if (!process.env.API_KEY) {
    return jsonError(res, 500, "API_KEY не настроен.");
  }

  try {
    const body = typeof req.body === "string"
      ? JSON.parse(req.body)
      : req.body;

    const model = body?.model || body?.models?.[0];

    if (!MODELS.has(model)) {
      return jsonError(res, 400, "Неизвестная модель.");
    }

    const decoded = await authenticate(req);

    const email = String(decoded.email || "").toLowerCase();

    if (model === "cx/gpt-6-astra") {
      const isAdmin = email === ADMIN_EMAIL;
      const hasPro = await checkPro(decoded.uid);

      if (!isAdmin && !hasPro) {
        return jsonError(res, 403, "Для GPT-6 ASTRO нужна подписка Pro.");
      }
    }

    if (
      !Array.isArray(body.messages) ||
      !body.messages.length
    ) {
      return jsonError(res, 400, "Нет сообщений.");
    }

    const messages = [];

    for (const message of body.messages
      .filter(m => m && ["system", "user", "assistant"].includes(m.role))
      .slice(-40)) {

      const content = await normalizeContent(message.content);

      if (content !== null && content !== "") {
        messages.push({
          role: message.role,
          content
        });
      }
    }

    if (!messages.some(m => m.role === "user")) {
      return jsonError(res, 400, "Нет сообщений пользователя.");
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
        Authorization: `Bearer ${process.env.API_KEY}`,
        "Content-Type": "application/json",
        Accept: requestBody.stream
          ? "text/event-stream"
          : "application/json"
      },
      body: JSON.stringify(requestBody)
    });

    if (!upstream.ok) {
      const error = await upstream.text();
      console.error("AnyModel:", upstream.status, error.slice(0, 1000));

      return jsonError(res, 502, "Ошибка AnyModel API: " + upstream.status);
    }

    const contentType = upstream.headers.get("content-type") || "";

    if (contentType.includes("text/event-stream") && upstream.body) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
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
    res.setHeader("Content-Type", contentType || "application/json");
    res.setHeader("Cache-Control", "no-store");

    return res.end(result);

  } catch (error) {
    console.error("Venus API:", error);

    if (error.message === "UNAUTHORIZED") {
      return jsonError(res, 401, "Войдите в аккаунт.");
    }

    if (error.code === "auth/id-token-expired" ||
        error.code === "auth/argument-error") {
      return jsonError(res, 401, "Недействительный токен.");
    }

    if (res.headersSent) return res.end();

    return jsonError(
      res,
      500,
      error.message || "Внутренняя ошибка."
    );
  }
}
