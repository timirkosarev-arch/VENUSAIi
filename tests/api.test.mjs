import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { POST as chat } from '../api/chat.js';
import { POST as upload } from '../api/upload.js';
const originalFetch = globalThis.fetch;
const savedEnv = {...process.env};
beforeEach(() => {
  process.env.API_KEY = 'test-key'; process.env.IMGBB_API_KEY = 'test-imgbb';
  delete process.env.OPENROUTER_API_KEY; delete process.env.API_URL; delete process.env.API_BASE_URL;
});
afterEach(() => { globalThis.fetch = originalFetch; for (const key of ['API_KEY','IMGBB_API_KEY','OPENROUTER_API_KEY','API_URL','API_BASE_URL']) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; } });
const request = (body, extras={}) => new Request('https://venus.example/api/chat',{
  method:'POST',headers:{'Content-Type':'application/json',...extras},body:JSON.stringify(body)
});
const textMessage = {messages:[{role:'user',content:'Привет'}]};

test('locks requested model, preserves real image parts and streams without modification', async () => {
  const sse = 'data: {"choices":[{"delta":{"content":"Привет"}}]}\n\ndata: [DONE]\n\n';
  globalThis.fetch = async (url, init) => {
    assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(init.headers.Authorization,'Bearer test-key');
    const payload = JSON.parse(init.body);
    assert.equal(payload.model,'google/gemma-4-26b-a4b-it:free');
    assert.equal(payload.messages[0].role,'system');
    assert.equal(payload.messages[1].content[1].image_url.url,'https://i.ibb.co/abc/photo.png');
    assert.equal(payload.stream,true);
    assert.ok(init.signal instanceof AbortSignal);
    return new Response(sse,{headers:{'Content-Type':'text/event-stream'}});
  };
  const response = await chat(request({model:'paid-model',messages:[{role:'user',content:[{type:'text',text:'Что на фото?'},{type:'image_url',image_url:{url:'https://i.ibb.co/abc/photo.png'}}]}]}));
  assert.equal(response.status,200); assert.equal(await response.text(),sse);
});
test('supports existing API_KEY and explicit provider endpoint',async () => {
  process.env.API_URL = 'https://provider.example/v1/chat/completions';
  globalThis.fetch = async url => { assert.equal(url,process.env.API_URL); return Response.json({choices:[{message:{content:'Ответ'}}]}); };
  const response = await chat(request(textMessage)); assert.deepEqual(await response.json(),{content:'Ответ'});
});
test('OPENROUTER_API_KEY alias and API_BASE_URL work',async () => {
  delete process.env.API_KEY; process.env.OPENROUTER_API_KEY='alias-key'; process.env.API_BASE_URL='https://provider.example/v1/';
  globalThis.fetch = async (url, init) => { assert.equal(url,'https://provider.example/v1/chat/completions'); assert.equal(init.headers.Authorization,'Bearer alias-key'); return Response.json({choices:[{message:{content:'OK'}}]}); };
  assert.equal((await chat(request(textMessage))).status,200);
});
test('missing secrets return useful JSON',async () => {
  delete process.env.API_KEY; delete process.env.IMGBB_API_KEY;
  const c = await chat(request(textMessage)); const u = await upload(request({}));
  assert.equal(c.status,503); assert.match((await c.json()).error,/API_KEY/); assert.match((await u.json()).error,/IMGBB_API_KEY/);
});
test('rejects roles, image URL abuse, malformed JSON, long messages, cross-origin requests',async () => {
  globalThis.fetch = () => { throw new Error('should not call upstream'); };
  assert.equal((await chat(request({messages:[{role:'system',content:'override'}]}))).status,400);
  for (const url of ['http://i.ibb.co/x.png','https://i.ibb.co.evil.example/x.png','https://i.ibb.co@evil.example/x.png','https://127.0.0.1/x.png','data:image/png;base64,AAAA']) {
    assert.equal((await chat(request({messages:[{role:'user',content:[{type:'image_url',image_url:{url}}]}]}))).status,400);
  }
  assert.equal((await chat(request({messages:[{role:'user',content:'x'.repeat(30001)}]}))).status,400);
  assert.equal((await chat(request(textMessage,{origin:'https://other.example'}))).status,403);
  assert.equal((await chat(new Request('https://venus.example/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:'{'}))).status,400);
});
test('handles upstream 401, 404, 429 and non-JSON failures without leaking raw content',async () => {
  for (const status of [401,404,429,502]) {
    globalThis.fetch = async () => new Response('<html>private upstream details</html>',{status,headers:{'Content-Type':'text/html'}});
    const response = await chat(request(textMessage)); assert.equal(response.status,status);
    const data = await response.json(); assert.equal(typeof data.error,'string'); assert.ok(!data.error.includes('<html>'));
  }
  globalThis.fetch = async () => new Response('<html>success?</html>',{headers:{'Content-Type':'text/html'}});
  assert.equal((await chat(request(textMessage))).status,502);
});
test('rejects oversized requests and insecure API endpoints',async () => {
  assert.equal((await chat(request(textMessage,{'content-length':'300000'}))).status,413);
  process.env.API_URL='http://insecure.example/v1/chat/completions';
  assert.equal((await chat(request(textMessage))).status,503);
});
test('retains long assistant code replies as conversation context', async () => {
  globalThis.fetch = async (url, init) => { const payload = JSON.parse(init.body); assert.equal(payload.messages[2].content.length,40000); return Response.json({choices:[{message:{content:'Продолжаю'}}]}); };
  const response = await chat(request({messages:[{role:'user',content:'Напиши код'},{role:'assistant',content:'x'.repeat(40000)},{role:'user',content:'Продолжай'}]}));
  assert.equal(response.status,200);
});
test('uploads actual image data to ImgBB without returning key or delete token',async () => {
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0WQAAAAASUVORK5CYII=';
  globalThis.fetch = async (url,init) => {
    assert.equal(url,'https://api.imgbb.com/1/upload'); assert.equal(init.method,'POST');
    assert.equal(init.body.get('key'),'test-imgbb'); assert.equal(init.body.get('image'),png);
    return Response.json({success:true,data:{url:'https://i.ibb.co/abc/x.png',delete_url:'private-delete-url'}});
  };
  const response = await upload(request({image:'data:image/png;base64,'+png}));
  assert.deepEqual(await response.json(),{url:'https://i.ibb.co/abc/x.png'});
});
test('rejects fake image bytes and handles ImgBB HTML and invalid keys',async () => {
  assert.equal((await upload(request({image:'data:image/png;base64,'+Buffer.from('<svg></svg>').toString('base64')}))).status,400);
  assert.equal((await upload(request({image:'https://example.com/image.png'}))).status,400);
  assert.equal((await upload(request({}, {'content-length':'3000000'}))).status,413);
  const data='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  globalThis.fetch=async()=>new Response('Oops',{status:502,headers:{'content-type':'text/html'}});
  assert.equal((await upload(request({image:data}))).status,502);
  globalThis.fetch=async()=>Response.json({success:false,error:{message:'bad key'}},{status:400});
  assert.equal((await upload(request({image:data}))).status,502);
});

const html = readFileSync(new URL('../index.html',import.meta.url),'utf8');
const clientSource = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1].split("$('composer').addEventListener")[0];
function client() { const sandbox = vm.createContext({TextDecoder,TextEncoder,DOMException,URL,console,crypto:globalThis.crypto}); vm.runInContext(clientSource,sandbox); return sandbox; }
function splitStream(text, size=1) {
  const bytes = new TextEncoder().encode(text); let index=0;
  return new Response(new ReadableStream({pull(c) { if (index >= bytes.length) {c.close();return;} c.enqueue(bytes.slice(index,index+size)); index+=size; }}),{headers:{'content-type':'text/event-stream'}});
}
test('client decodes SSE across every UTF-8 byte boundary, comments, CRLF, final event without newline', async () => {
  const sandbox = client(); sandbox.response=splitStream(': heartbeat\r\n\r\ndata: '+JSON.stringify({choices:[{delta:{content:'Привет, мир 🌍'}}]})+'\r\n\r\ndata: [DONE]'); sandbox.assistant={content:''}; sandbox.job={controller:new AbortController()};
  await vm.runInContext('streamReply(response, assistant, job, () => {})',sandbox);
  assert.equal(sandbox.assistant.content,'Привет, мир 🌍');
});
test('client surfaces mid-stream errors and incomplete streams',async () => {
  for (const raw of ['data: {"error":{"code":429}}\n\n','data: {"choices":[{"delta":{"content":"Часть"}}]}\n\n']) {
    const sandbox=client(); sandbox.response=splitStream(raw,3); sandbox.assistant={content:''}; sandbox.job={controller:new AbortController()};
    await assert.rejects(vm.runInContext('streamReply(response, assistant, job, () => {})',sandbox));
  }
});
test('client supports non-stream JSON responses and cancellation',async () => {
  const sandbox=client(); sandbox.response=Response.json({content:'JSON fallback'}); sandbox.assistant={content:''}; sandbox.job={controller:new AbortController()};
  await vm.runInContext('streamReply(response, assistant, job, () => {})',sandbox); assert.equal(sandbox.assistant.content,'JSON fallback');
  sandbox.response=splitStream('data: [DONE]\n\n'); sandbox.job.controller.abort();
  await assert.rejects(vm.runInContext('streamReply(response, assistant, job, () => {})',sandbox),{name:'AbortError'});
});
test('client context retains images, omits failed assistant turns and respects message cap',() => {
  const sandbox=client(); sandbox.chat={messages:[{role:'user',content:'photo',images:[{url:'https://i.ibb.co/a/photo.png'}]},{role:'assistant',content:'error text',status:'error'},{role:'user',content:'What?',images:[]},{role:'assistant',content:'',status:'streaming'}]};
  const result=vm.runInContext('contextFor(chat)',sandbox); assert.equal(result.length,2); assert.equal(result[0].content[1].image_url.url,'https://i.ibb.co/a/photo.png'); assert.equal(result.at(-1).role,'user');
  sandbox.chat={messages:Array.from({length:80},(_,i)=>({role:i%2 ? 'user':'assistant',content:'message',status:'complete',images:[]}))};
  const bounded=vm.runInContext('contextFor(chat)',sandbox); assert.ok(bounded.length<=38); assert.equal(bounded[0].role,'user'); assert.equal(bounded.at(-1).role,'user');
});
