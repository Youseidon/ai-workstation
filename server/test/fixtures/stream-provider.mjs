import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';

const mode=process.argv[2];
const scenario=process.env.FIXTURE_SCENARIO ?? 'normal';
const log=entry=>{ if(process.env.FIXTURE_LOG)appendFileSync(process.env.FIXTURE_LOG,JSON.stringify(entry)+'\n'); };
const finish=()=>{ if(process.env.FIXTURE_FINISHED)writeFileSync(process.env.FIXTURE_FINISHED,'finished'); };
log({pid:process.pid,cwd:process.cwd(),serverOnlyEnv:['HYDRA_DB','HYDRA_DATABASE_PATH','DATABASE_URL','SETTINGS_FILE'].filter(key=>process.env[key]!==undefined)});
let timer;
if(mode==='codex'){
 const send=value=>{
  const line=JSON.stringify(value)+'\n';
  process.stdout.write(line.slice(0,11));process.stdout.write(line.slice(11));
 };
 const notify=(method,params)=>send({method,params:{threadId:'thread',turnId:'turn',...params}});
 const stop=status=>{clearTimeout(timer);notify('turn/completed',{turn:{id:'turn',status,items:status==='completed'?[{id:'answer',type:'agentMessage',text:'First 🌊 words'}]:[]}});};
 createInterface({input:process.stdin}).on('line',line=>{
  const message=JSON.parse(line);log({request:message});
  if(message.method==='initialize'){
   if(scenario==='timeout')return;
   if(scenario==='invalid'){process.stdout.write('invalid-json\n');return;}
   send({id:message.id,result:{userAgent:'fixture'}});
  }else if(message.method==='account/login/start')send({id:message.id,result:{type:'apiKey'}});
  else if(message.method==='thread/start'||message.method==='thread/resume')send({id:message.id,result:{thread:{id:'thread'},sandbox:{type:'readOnly',networkAccess:false}}});
  else if(message.method==='turn/start'){
   if(scenario==='exit'){process.exit(0);return;}
   notify('turn/started',{turn:{id:'turn'}});send({id:message.id,result:{turn:{id:'turn'}}});
   notify('item/reasoning/summaryTextDelta',{itemId:'thinking',summaryIndex:0,delta:'Considering'});
   notify('item/agentMessage/delta',{threadId:'other',itemId:'bad',delta:'LEAK'});
   notify('item/agentMessage/delta',{itemId:'answer',delta:'First 🌊'});
   if(scenario!=='hang')timer=setTimeout(()=>{
    notify('item/agentMessage/delta',{itemId:'answer',delta:' words'});
    notify('item/completed',{item:{id:'answer',type:'agentMessage',text:'First 🌊 words'}});
    finish();stop('completed');
   },180);
  }else if(message.method==='turn/interrupt'&&scenario!=='hang'){
   send({id:message.id,result:{}});stop('interrupted');
  }
 });
 setInterval(()=>{},1000);
}else if(mode==='kilo'){
 let stream;
 let prompt;
 const emit=(type,properties)=>{
  const data=JSON.stringify({id:`event-${sequence++}`,type,properties});
  stream?.write(`data: ${data}\r\n\r\n`);
 };
 let sequence=0;
 const sessionID='ses_mock';
 const part=(id,type,text,messageID='msg_assistant')=>({id,type,text,messageID,sessionID});
 const output=()=>{
  emit('message.updated',{info:{id:'msg_old',sessionID,role:'assistant',parentID:'msg_old_parent'}});
  emit('message.part.updated',{part:part('prt_old','text','OLD HISTORY','msg_old')});
  emit('message.updated',{info:{id:'msg_assistant',sessionID,role:'assistant',parentID:prompt.messageID}});
  emit('message.part.updated',{part:part('prt_reason','reasoning','')});
  emit('message.part.delta',{sessionID,messageID:'msg_assistant',partID:'prt_reason',field:'text',delta:'Considering'});
  emit('message.part.updated',{part:part('prt_answer','text','')});
  emit('message.part.delta',{sessionID,messageID:'msg_assistant',partID:'prt_answer',field:'text',delta:'First 🌊'});
  if(scenario==='disconnect'){timer=setTimeout(()=>stream.end(),30);return;}
  if(scenario==='hang')return;
  timer=setTimeout(()=>{
   emit('message.part.delta',{sessionID,messageID:'msg_assistant',partID:'prt_answer',field:'text',delta:' words'});
   emit('message.part.updated',{part:part('prt_answer','text','First 🌊 words')});
   emit('message.part.updated',{part:part('prt_answer','text','First 🌊 words')});
   finish();emit('session.status',{sessionID,status:{type:'idle'}});
  },180);
 };
 const server=createServer(async(req,res)=>{
  if(req.headers.authorization!==`Basic ${Buffer.from('kilo:fixture-password').toString('base64')}`){res.writeHead(401).end();return;}
  const path=new URL(req.url,'http://localhost').pathname;
  let body='';for await(const chunk of req)body+=chunk;
  const value=body?JSON.parse(body):undefined;
  log({path,method:req.method,body:value,directory:new URL(req.url,'http://localhost').searchParams.get('directory')});
  if(path==='/event'){
   res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();stream=res;
   emit('server.connected',{});emit('session.status',{sessionID,status:{type:'idle'}});return;
  }
  if(path==='/session'&&req.method==='POST'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:sessionID}));return;}
  if(path===`/session/${sessionID}`&&req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:sessionID}));return;}
  if(path.endsWith('/prompt_async')){
   if(!stream){res.writeHead(409).end();return;}
   prompt=value;res.writeHead(204).end();emit('session.status',{sessionID,status:{type:'busy'}});
   if(scenario==='permission')emit('permission.asked',{sessionID,id:'per_mock',permission:'bash'});
   else output();return;
  }
  if(path==='/permission/per_mock/reply'){res.end('true');output();return;}
  if(path.endsWith('/abort')){
   clearTimeout(timer);res.end('true');
   emit('session.error',{sessionID,error:{name:'MessageAbortedError'}});emit('session.idle',{sessionID});return;
  }
  res.writeHead(404).end();
 });
 server.listen(0,'127.0.0.1',()=>console.log(`kilo server listening on http://127.0.0.1:${server.address().port}`));
}
