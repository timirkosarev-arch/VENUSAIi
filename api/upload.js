const IMGBB_ENDPOINT = "https://api.imgbb.com/1/upload";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "5mb"
    }
  }
};

function sendError(res, status, message) {
  return res.status(status).json({
    error: message
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return sendError(
      res,
      405,
      "Method not allowed"
    );
  }

  const apiKey = process.env.IMGBB_API_KEY;

  if (!apiKey) {
    return sendError(
      res,
      500,
      "На Vercel не настроена переменная IMGBB_API_KEY."
    );
  }

  try {
    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;

    const image = body?.image;

    const name =
      typeof body?.name === "string"
        ? body.name
        : "venus-ai-image";

    if (
      typeof image !== "string" ||
      !image.trim()
    ) {
      return sendError(
        res,
        400,
        "Изображение не передано."
      );
    }

    if (image.length > 4400000) {
      return sendError(
        res,
        413,
        "Изображение слишком большое. Попробуй фото меньшего размера."
      );
    }

    const form = new FormData();

    form.append("image", image);

    form.append(
      "name",
      name
        .replace(/[^a-zA-Z0-9а-яА-ЯёЁ _.-]/g, "_")
        .slice(0, 120)
    );

    const upstream = await fetch(
      `${IMGBB_ENDPOINT}?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        body: form
      }
    );

    const result = await upstream
      .json()
      .catch(() => ({}));

    if (
      !upstream.ok ||
      !result.success ||
      !result.data?.url
    ) {
      const message =
        result.error?.message ||
        `ImgBB вернул ошибку ${upstream.status}.`;

      return sendError(res, 502, message);
    }

    return res.status(200).json({
      url: result.data.url,
      displayUrl:
        result.data.display_url || result.data.url,
      viewerUrl:
        result.data.url_viewer || ""
    });

  } catch (error) {
    console.error("ImgBB upload error:", error);

    return sendError(
      res,
      500,
      "Внутренняя ошибка при загрузке изображения."
    );
  }
}
