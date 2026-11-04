const IMGBB_ENDPOINT = "https://api.imgbb.com/1/upload";

function sendError(res, status, message) {
  return res.status(status).json({ error: message });
}

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "5mb"
    }
  }
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendError(res, 405, "Method not allowed");
  }

  const key = process.env.IMGBB_API_KEY;

  if (!key) {
    return sendError(res, 500, "IMGBB_API_KEY не настроен");
  }

  try {
    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;

    const image = body?.image;

    if (typeof image !== "string" || !image) {
      return sendError(res, 400, "Изображение не передано");
    }

    if (image.length > 4400000) {
      return sendError(res, 413, "Изображение слишком большое");
    }

    const form = new FormData();
    form.append("image", image);

    if (typeof body.name === "string") {
      form.append("name", body.name.slice(0, 120));
    }

    const response = await fetch(
      `${IMGBB_ENDPOINT}?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        body: form
      }
    );

    const result = await response.json();

    if (!response.ok || !result.success || !result.data?.url) {
      return sendError(
        res,
        502,
        result.error?.message || "Ошибка ImgBB"
      );
    }

    return res.status(200).json({
      url: result.data.url,
      displayUrl: result.data.display_url,
      viewerUrl: result.data.url_viewer
    });

  } catch (error) {
    console.error(error);

    return sendError(
      res,
      500,
      "Ошибка загрузки изображения"
    );
  }
}
