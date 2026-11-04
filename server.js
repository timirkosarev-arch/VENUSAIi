
require('dotenv').config();

const express = require('express');
const app = express();

app.use(express.json({limit:'1mb'}));
app.use(express.static(__dirname));

app.post('/api/chat', async (req,res)=>{
 try {
  if(!process.env.API_KEY){
   return res.status(500).json({error:'API ключ не настроен'});
  }

  const messages = req.body.messages;

  if(!Array.isArray(messages) || messages.length === 0){
   return res.status(400).json({error:'Нет сообщений'});
  }

  const safeMessages = messages
   .filter(m =>
    ['user','assistant'].includes(m.role) &&
    typeof m.content === 'string'
   )
   .slice(-30);

  const response = await fetch(
   'https://anymodel.org/v1/chat/completions',
   {
    method:'POST',
    headers:{
     'Content-Type':'application/json',
     'Authorization':'Bearer '+process.env.API_KEY
    },
    body:JSON.stringify({
     model:'am/nemotron-3-ultra-550b-a55b',
     messages:safeMessages,
     stream:true
    })
   }
  );

  if(!response.ok){
   const error = await response.text();
   return res.status(response.status).json({
    error:error.slice(0,500)
   });
  }

  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('X-Accel-Buffering','no');

  for await (const chunk of response.body){
   if(res.destroyed) break;
   res.write(chunk);
  }

  res.end();

 }catch(error){
  console.error(error);
  if(!res.headersSent){
   res.status(500).json({error:'Ошибка подключения к ИИ'});
  }else{
   res.end();
  }
 }
});

app.listen(3000,()=>{
 console.log('My AI запущен: http://localhost:3000');
});
