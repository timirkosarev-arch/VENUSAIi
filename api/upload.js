function error(message, status = 400) {
  return Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
}

function detect(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

export async function POST(request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return error('Запрос разрешён только с этого сайта.', 403);
  if (!request.headers.get('content-type')?.includes('application/json')) return error('Ожидается application/json.', 415);
  const key = (process.env.IMGBB_API_KEY || '').trim();
  if (!key) return error('Добавьте IMGBB_API_KEY в Vercel и выполните Redeploy.', 503);
  let image;
  try {
    if (Number(request.headers.get('content-length')) > 2900000) return error('Изображение слишком большое.', 413);
    const raw = await request.text();
    if (raw.length > 2900000) return error('Изображение слишком большое.', 413);
    const body = JSON.parse(raw);
    const match = typeof body.image === 'string' && body.image.match(/^data:image\/(jpeg|png|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match || match[2].length % 4 !== 0) return error('Нужен файл JPG, PNG, WEBP или GIF.');
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > 2 * 1024 * 1024) return error('Фото после сжатия должно быть не больше 2 МБ.', 413);
    if (detect(bytes) !== match[1]) return error('Формат изображения не соответствует содержимому файла.');
    image = match[2];
  } catch {
    return error('Не удалось прочитать изображение. Прикрепите его заново.');
  }
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(50000)]);
  try {
    const form = new FormData();
    form.set('key', key);
    form.set('image', image);
    const response = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: form, signal });
    if (!response.headers.get('content-type')?.includes('application/json')) {
      await response.body?.cancel();
      return error('ImgBB временно недоступен. Попробуйте позже.', 502);
    }
    const data = await response.json();
    if (!response.ok || !data.success || !data.data?.url) {
      console.error('ImgBB upstream status:', response.status);
      return error('ImgBB отклонил загрузку. Проверьте IMGBB_API_KEY и лимиты сервиса.', 502);
    }
    const url = new URL(data.data.url);
    if (url.protocol !== 'https:' || url.hostname !== 'i.ibb.co' || url.username || url.password || url.port) {
      return error('ImgBB вернул неподдерживаемую ссылку.', 502);
    }
    return Response.json({ url: url.href }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (request.signal.aborted) return error('Загрузка остановлена.', 499);
    if (signal.aborted) return error('ImgBB не ответил вовремя. Попробуйте снова.', 504);
    console.error('ImgBB network failure:', e.name);
    return error('Не удалось загрузить фото в ImgBB. Попробуйте ещё раз.', 502);
  }
}
