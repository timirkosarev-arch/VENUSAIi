import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { POST as chat } from '../api/chat.js';
import { POST as upload } from '../api/upload.js';

const fixtures = process.argv.includes('--fixtures');
if (fixtures) {
  process.env.API_KEY = 'local-test-placeholder';
  process.env.IMGBB_API_KEY = 'local-test-placeholder';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url) === 'https://api.imgbb.com/1/upload') {
      return Response.json({success:true,data:{url:'https://i.ibb.co/local-test/test-image.png'}});
    }
    if (String(url).includes('/chat/completions')) {
      const {messages} = JSON.parse(options.body);
      const last = messages.at(-1).content;
      const text = typeof last === 'string' ? last : last.find(p => p.type === 'text').text;
      if (text === 'test:429') return Response.json({error:{message:'Rate limit'}},{status:429});
      if (text === 'test:html') return new Response('<html>Bad gateway</html>',{status:502,headers:{'Content-Type':'text/html'}});
      const answer = 'Это **тестовый ответ** локального стенда.\n\nВаше сообщение: ' + text + '\n\n```js\nconsole.log("Привет!");\n```\n\n- История сохраняется\n- Потоковый ответ работает\n\n| Проверка | Результат |\n| --- | --- |\n| Интерфейс | Готово |';
      let i = 0, timer; const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          const close = () => { clearInterval(timer); try { controller.close(); } catch {} };
          options.signal.addEventListener('abort', close, {once:true});
          timer = setInterval(() => {
            if (i >= answer.length) { controller.enqueue(encoder.encode('data: [DONE]\n\n')); close(); return; }
            const chunk = answer.slice(i, i + 8); i += 8;
            controller.enqueue(encoder.encode('data: ' + JSON.stringify({choices:[{delta:{content:chunk}}]}) + '\n\n'));
          }, 50);
        },
        cancel() { clearInterval(timer); }
      });
      return new Response(stream,{headers:{'Content-Type':'text/event-stream'}});
    }
    return originalFetch(url, options);
  };
  console.log('Local fixture mode: all model and image responses are simulated.');
}
const server = http.createServer(async (req, res) => {
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/mobile') {
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      res.end('<!doctype html><html><head><title>Mobile QA</title><style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#101010}iframe{width:390px;height:844px;border:1px solid #555;border-radius:14px}</style></head><body><iframe src="/" title="Мобильный интерфейс Venus AI"></iframe></body></html>'); return;
    }
    if (path === '/' || path === '/index.html') {
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      res.end(await readFile(new URL('../index.html', import.meta.url))); return;
    }
    const handler = path === '/api/chat' ? chat : path === '/api/upload' ? upload : null;
    if (!handler) { res.writeHead(404); res.end('Not found'); return; }
    if (req.method !== 'POST') { res.writeHead(405,{'Allow':'POST'}); res.end('Method not allowed'); return; }
    const parts = []; let size = 0;
    for await (const chunk of req) { parts.push(chunk); size += chunk.length; if (size > 4500000) { res.writeHead(413); res.end(); return; } }
    const origin = req.headers.origin || 'http://' + req.headers.host;
    const request = new Request(origin + path,{method:req.method,headers:req.headers,body:Buffer.concat(parts),signal:controller.signal});
    const response = await handler(request);
    res.writeHead(response.status,Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) { if (res.destroyed) break; if (!res.write(chunk)) await new Promise(resolve => { res.once('drain',resolve); res.once('close',resolve); }); }
    res.end();
  } catch (e) { if (!res.headersSent) res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
});
const portArgument = process.argv.indexOf('--port');
const port = Number(process.env.PORT || (portArgument >= 0 && process.argv[portArgument + 1]) || 3000);
server.listen(port, '0.0.0.0', () => console.log('Venus AI listening on port ' + port));
