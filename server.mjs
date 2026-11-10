import http from 'node:http';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.APP_DATA_DIR || path.join(root, 'data');
const configFile = path.join(dataDir, 'config.json');
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
const envApiKey = process.env.GEMINI_API_KEY?.trim() || '';
const trustedAdminIps = new Set((process.env.ADMIN_TRUSTED_IPS || '').split(',').map((ip) => ip.trim()).filter(Boolean));
const html = await readFile(path.join(root, 'index.html'));
await mkdir(dataDir, { recursive: true });
if (!existsSync(configFile)) await writeFile(configFile, JSON.stringify({ apiKey: '', model: 'gemini-3.5-flash-lite', systemPrompt: 'Ты — дружелюбный и полезный собеседник Алисы. Отвечай по-русски, естественно и кратко. Ответ предназначен для озвучивания: без Markdown, списков и длинных вступлений.', fallback: 'Похоже, я задумалась. Спроси меня ещё раз через секунду.' }, null, 2), { mode: 0o600 });
await chmod(configFile, 0o600);
let config = JSON.parse(await readFile(configFile, 'utf8'));
const log = [];
const MAX_HISTORY_TURNS = 3;
const MAX_HISTORY_TEXT = 100;
function isLocalRequest(req) {
 const address = req.socket.remoteAddress || '';
 const normalized = address.startsWith('::ffff:') ? address.slice(7) : address;
 return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address === '::ffff:7f00:1' || trustedAdminIps.has(normalized);
}
let tunnelProcess = null;
let tunnelUrl = '';
let tunnelError = '';
let tunnelBuffer = '';
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(value)); };
async function body(req) { let raw=''; for await (const chunk of req) { raw+=chunk; if(raw.length>1_000_000) throw new Error('Слишком большой запрос'); } return raw ? JSON.parse(raw) : {}; }
function aliceReply(req, text, end=false, history=[]) { return { response: { text: String(text).slice(0, 1024), end_session: end }, session: { session_id: req.session?.session_id || 'local-test', message_id: req.session?.message_id ?? 0, user_id: req.session?.user_id || req.session?.application?.application_id || 'local-test' }, session_state: { history }, version: '1.0' }; }
function addLog(entry) { log.unshift({ time: new Date().toISOString(), ...entry }); log.splice(50); }
function getHistory(input) {
 if (input.session?.new) return [];
 const value=input.state?.session?.history;
 if(!Array.isArray(value)) return [];
 return value.filter((item)=>item && (item.role==='user'||item.role==='model') && typeof item.text==='string').slice(-MAX_HISTORY_TURNS*2).map((item)=>({role:item.role,text:item.text.slice(0,MAX_HISTORY_TEXT)}));
}
function storedHistory(items) {
 let history=items.slice(-MAX_HISTORY_TURNS*2);
 while(history.length && JSON.stringify({history}).length>950) history=history.slice(2);
 return history;
}
function isSearchIntent(text) {
 return /\b(latest|today|current|news|weather|price|search|look up)\b|сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные|в интернете|погугл/i.test(text);
}
async function searchWeb(query, timeoutMs, metrics={}) {
 const key = process.env.SERPER_API_KEY;
 metrics.serperHttp = null;
 metrics.serperOrganicCount = 0;
 metrics.serperAnswerBox = false;
 metrics.serperOutcome = 'pending';
 if (!key) { metrics.serperOutcome = 'no_api_key'; return ''; }
 if (timeoutMs < 150) { metrics.serperOutcome = 'budget_too_small'; return ''; }
 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), timeoutMs);
 try {
  const response = await fetch('https://google.serper.dev/search', {
   method: 'POST',
   headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
   body: JSON.stringify({ q: query, gl: 'ru', hl: 'ru', num: 3 }),
   signal: controller.signal
  });
  metrics.serperHttp = response.status;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
   metrics.serperOutcome = 'http_error';
   return '';
  }
  const organic = Array.isArray(data.organic) ? data.organic : [];
  metrics.serperOrganicCount = organic.length;
  const answerBox = data.answerBox?.answer || data.answerBox?.snippet;
  metrics.serperAnswerBox = Boolean(answerBox);
  const results = organic
   .slice(0, 3)
   .map((item, i) => `${i + 1}. ${String(item.title || '').slice(0, 160)}: ${String(item.snippet || '').slice(0, 300)} ${String(item.link || '').slice(0, 200)}`);
  if (answerBox) results.unshift(`Краткий ответ поисковика: ${String(answerBox).slice(0, 300)}`);
  const context = results.join('\n').slice(0, 1800);
  metrics.serperOutcome = context ? 'results' : 'no_results';
  return context;
 } catch (e) {
  metrics.serperOutcome = e.name === 'AbortError' ? 'timeout' : 'network_error';
  return '';
 } finally {
  clearTimeout(timer);
 }
}
async function askGemini(text, history=[], searchContext='', timeoutMs=3000, metrics={}) {
 const apiKey = envApiKey || config.apiKey;
 if (!apiKey) throw new Error('Добавьте API-ключ Gemini в .env или в настройках.');
 const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); const geminiStarted=Date.now();
 try {
  const userText=searchContext?`${text}\n\nРезультаты поиска:\n${searchContext}\nИспользуй их, если они относятся к вопросу. Не утверждай, что у тебя нет доступа к интернету.`:text;
  const contents=[...history.map((item)=>({role:item.role,parts:[{text:item.text}]})),{role:'user',parts:[{text:userText}]}];
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`, { method:'POST', headers:{'content-type':'application/json','x-goog-api-key':apiKey}, body:JSON.stringify({ systemInstruction:{parts:[{text:config.systemPrompt}]}, contents, generationConfig:{temperature:0.5,maxOutputTokens:256,...(config.model.startsWith('gemini-3')?{thinkingConfig:{thinkingLevel:'minimal'}}:{})} }), signal:controller.signal });
  const data = await response.json(); metrics.geminiHttp=response.status; metrics.finishReason=data.candidates?.[0]?.finishReason ?? 'missing'; metrics.outputTokens=data.usageMetadata?.candidatesTokenCount ?? null; if (!response.ok) throw new Error(data.error?.message || `Gemini вернул HTTP ${response.status}`);
  return data.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('').trim() || 'Не получилось сформулировать ответ. Спроси ещё раз.';
 } finally { metrics.geminiMs=Date.now()-geminiStarted; clearTimeout(timer); }
}
const server = http.createServer(async (req,res) => {
 const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
 const isAlicePath = url.pathname.replace(/\/+$/, '') === '/alice';
 const isPublicTunnelRequest = Boolean(req.headers['cf-connecting-ip'] || req.headers['cf-ray'] || req.headers['x-forwarded-for']);
 if (isPublicTunnelRequest) { const entry={time:new Date().toISOString(),question:`${req.method} ${url.pathname}`,answer:'Публичный запрос дошёл до сервера',ok:true}; log.unshift(entry); log.splice(50); }
 if ((!isLocalRequest(req) || isPublicTunnelRequest) && !isAlicePath) return json(res,404,{error:'Не найдено'});
 if (req.method==='GET' && url.pathname==='/') { res.writeHead(200,{'content-type':'text/html; charset=utf-8'}); return res.end(html); }
 if (req.method==='GET' && url.pathname==='/api/status') return json(res,200,{configured:!!(envApiKey || config.apiKey),apiKeySource:envApiKey?'environment':'settings',model:config.model,systemPrompt:config.systemPrompt,webhook:`http://localhost:${port}/alice`,requests:log.length,tunnel:{running:!!tunnelProcess,url:tunnelUrl,error:tunnelError}});
 if (req.method==='GET' && url.pathname==='/api/log') return json(res,200,log);
 if (req.method==='POST' && url.pathname==='/api/config') { try { const input=await body(req); config={...config,apiKey:envApiKey?config.apiKey:String(input.apiKey ?? config.apiKey).trim(),model:String(input.model || config.model).trim(),systemPrompt:String(input.systemPrompt || config.systemPrompt).slice(0,4000),fallback:String(input.fallback || config.fallback).slice(0,300)}; await writeFile(configFile,JSON.stringify(config,null,2),{mode:0o600}); await chmod(configFile,0o600); return json(res,200,{ok:true,configured:!!(envApiKey || config.apiKey),apiKeySource:envApiKey?'environment':'settings',model:config.model}); } catch(e) { return json(res,400,{error:e.message}); } }
 if (req.method==='POST' && url.pathname==='/api/tunnel/start') {
  if (tunnelProcess) return json(res,200,{running:true,url:tunnelUrl});
  const binary = process.env.CLOUDFLARED_PATH || (process.platform === 'darwin' && existsSync('/opt/homebrew/bin/cloudflared') ? '/opt/homebrew/bin/cloudflared' : (process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'));
  tunnelUrl=''; tunnelError=''; tunnelBuffer='';
  try {
   tunnelProcess=spawn(binary,['tunnel','--protocol','http2','--url',`http://127.0.0.1:${port}`],{stdio:['ignore','pipe','pipe']});
   const consume=(chunk)=>{ tunnelBuffer=(tunnelBuffer+chunk.toString()).slice(-16000); const match=tunnelBuffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i); if(match) tunnelUrl=match[0]; };
   tunnelProcess.stdout.on('data',consume); tunnelProcess.stderr.on('data',consume);
   tunnelProcess.on('error',(e)=>{tunnelError=e.code==='ENOENT'?'Не найден cloudflared. Установите его командой: brew install cloudflared':e.message;tunnelProcess=null;});
   tunnelProcess.on('exit',(code)=>{if(code && !tunnelError) tunnelError=`Туннель завершился с кодом ${code}`;tunnelProcess=null;tunnelUrl='';});
   const deadline=Date.now()+12000;
   while(!tunnelUrl && !tunnelError && tunnelProcess && Date.now()<deadline) await new Promise(r=>setTimeout(r,200));
   return json(res,200,{running:!!tunnelProcess,url:tunnelUrl,error:tunnelError||(!tunnelUrl?'Cloudflare не выдал адрес за 12 секунд. Проверьте интернет и cloudflared.':'')});
  } catch(e) { tunnelProcess=null;tunnelError=e.message;return json(res,200,{running:false,url:'',error:tunnelError}); }
 }
 if (req.method==='POST' && url.pathname==='/api/tunnel/stop') { if(tunnelProcess) tunnelProcess.kill('SIGTERM'); tunnelProcess=null;tunnelUrl='';return json(res,200,{running:false}); }
 if (req.method==='POST' && (isAlicePath || url.pathname==='/api/test')) {
  const entry={time:new Date().toISOString(),question:'(входящий запрос)',answer:'',ok:false}; log.unshift(entry); log.splice(50);
  let input; try { input=await body(req); } catch(e) { entry.error=e.message; entry.answer='Некорректный JSON'; return json(res,400,{error:e.message}); }
  const text=String(input.request?.original_utterance || input.request?.command || input.text || '').trim();
  const history=getHistory(input);
  if(!text) { const reply=aliceReply(input,'Привет! Я подключена к Gemini. О чём поговорим?',false,history); Object.assign(entry,{question:'(запуск навыка)',answer:reply.response.text,ok:true}); return json(res,200,reply); }
  entry.question=text;
  const requestStarted=Date.now(); const requestId=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8); const metrics={requestId,timeMsk:new Date(requestStarted).toLocaleString('sv-SE',{timeZone:'Europe/Moscow',hour12:false}),port,serperRequested:false,serperMs:0,serperResultsProvided:false,serperContextChars:0,geminiMs:0,geminiHttp:null,finishReason:null,outputTokens:null,outcome:'ok'}; try { const responseDeadline=Date.now()+3600; const wantsSearch=isSearchIntent(text)&&Boolean(process.env.SERPER_API_KEY); let searchContext=''; if(wantsSearch){metrics.serperRequested=true; const serperStarted=Date.now(); searchContext=await searchWeb(text,Math.min(1600,Math.max(0,responseDeadline-Date.now()-1900)),metrics); metrics.serperMs=Date.now()-serperStarted; metrics.serperResultsProvided=Boolean(searchContext); metrics.serperContextChars=searchContext.length;} const geminiTimeout=Math.max(100,Math.min(wantsSearch?2200:3000,responseDeadline-Date.now()-250)); const answer=await askGemini(text,history,searchContext,geminiTimeout,metrics); metrics.answerChars=answer.length; const nextHistory=storedHistory([...history,{role:'user',text:text.slice(0,MAX_HISTORY_TEXT)},{role:'model',text:answer.slice(0,MAX_HISTORY_TEXT)}]); const reply=aliceReply(input,answer,false,nextHistory); metrics.replyChars=reply.response.text.length; Object.assign(entry,{answer:reply.response.text,ok:true}); metrics.totalMs=Date.now()-requestStarted; console.info('[request-metrics] '+JSON.stringify(metrics)); return json(res,200,reply); }
  catch(e) { const timed=e.name==='AbortError'; const answer=timed?config.fallback:`Не удалось обратиться к Gemini: ${e.message}`; Object.assign(entry,{answer,ok:false,error:timed?'Превышено время ожидания Gemini':e.message}); metrics.totalMs=Date.now()-requestStarted; metrics.outcome=timed?'timeout':'error'; console.info('[request-metrics] '+JSON.stringify(metrics)); return json(res,200,aliceReply(input,answer,false,history)); }
 }
 if (req.method==='OPTIONS') { res.writeHead(204,{'access-control-allow-origin':'*','access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'content-type'}); return res.end(); }
 json(res,404,{error:'Не найдено'});
});
server.listen(port,host,()=>console.log(`Alice Gemini Bridge: http://${host}:${port}`));
