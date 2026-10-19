const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
function fixture() {
  const local = {apiKey:'old-key-must-never-leave-storage'}, session = {}, created = [], sent = [], opened = [];
  let listener, removed, status = {ready:true,signedIn:true,hasComposer:true};
  const area = data => ({
    async setAccessLevel(value) {assert.equal(value.accessLevel,'TRUSTED_CONTEXTS');},
    async get(defaults) {return typeof defaults==='string'?{[defaults]:structuredClone(data[defaults])}:{...defaults,...structuredClone(data)};},
    async set(values) {Object.assign(data,structuredClone(values));},
  });
  const runtime = {id:'test',getURL: p=>'chrome-extension://test/'+p,onMessage:{addListener(fn){listener=fn;}},onInstalled:{addListener(){}},openOptionsPage(){}};
  const chrome = {runtime,storage:{local:area(local),session:area(session)},sidePanel:{async open(value){opened.push(value);}},tabs:{
    async create(value){const tab={...value,id:created.length+10};created.push(tab);return tab;},
    async get(id){return created.find(tab=>tab.id===id);},async update(){},
    async sendMessage(id,message){sent.push({id,message});return message.type==='GEMINI_STATUS'?status:{accepted:true};},
    onRemoved:{addListener(fn){removed=fn;}},
  }};
  const context = vm.createContext({chrome,crypto:webcrypto,URL,console,Date,fetch(){assert.fail('Browser mode must not call an API');}});
  context.importScripts=(...paths)=>paths.forEach(p=>vm.runInContext(read(path.posix.join('src/background',p)),context));
  vm.runInContext(read('src/background/service-worker.js'),context);
  const chat={id:'test',url:'https://chatgpt.com/c/example',frameId:0,tab:{id:1,windowId:2}};
  const panel={id:'test',url:runtime.getURL('src/sidepanel/sidepanel.html')};
  const options={id:'test',url:runtime.getURL('src/options/options.html')};
  function send(message,sender=panel) {return new Promise(resolve=>{if(!listener(message,sender,resolve))resolve(null);});}
  return {local,session,created,sent,opened,context,chat,panel,options,send,removed,setStatus(value){status=value;}};
}
const capture = {source:'chatgpt.com',question:'What is 17 times 19?',reply:'323',history:[],capturedAt:new Date().toISOString()};
const valid = {verdict:'correct',summary:'The arithmetic is correct.',issues:[],missing_points:[],strengths:['Correct product.']};

test('preview and cancel never create a Gemini tab or send a prompt',async()=>{
  const f=fixture();
  assert.equal((await f.send({type:'OPEN_PREVIEW'},f.chat)).ok,true);
  await f.send({type:'CAPTURE_REVIEW',context:capture},f.chat);
  const {review}=await f.send({type:'GET_REVIEW'});
  assert.equal(review.phase,'preview');assert.equal(f.created.length,0);assert.equal(f.sent.length,0);
  await f.send({type:'CANCEL_REVIEW',id:review.id});
  assert.equal(f.session.review.phase,'cancelled');assert.equal(f.session.review.context,undefined);
  assert.equal(f.local.apiKey,'old-key-must-never-leave-storage');
});

test('only a trusted panel confirmation sends once; only its dedicated Gemini tab can return the result',async()=>{
  const f=fixture();await f.send({type:'CAPTURE_REVIEW',context:capture},f.chat);const id=f.session.review.id;
  assert.equal(await f.send({type:'SEND_REVIEW',id,selected:[]},f.chat),null);
  assert.equal(await f.send({type:'SEND_REVIEW',id,selected:[]},f.options),null);
  assert.ok((await f.send({type:'SEND_REVIEW',id:'stale',selected:[]})).error);
  assert.equal(f.created.length,0);
  await f.send({type:'SEND_REVIEW',id,selected:[]});
  assert.equal(f.created.length,1);assert.equal(f.created[0].url,'https://gemini.google.com/app');
  assert.equal(f.created[0].active,true);
  await f.send({type:'SEND_REVIEW',id,selected:[]});
  assert.equal(f.sent.filter(x=>x.message.type==='GEMINI_START').length,1);
  assert.ok(!JSON.stringify(f.sent).includes(f.local.apiKey));
  const sender={id:'test',url:'https://gemini.google.com/app/new',frameId:0,tab:{id:999}};
  await f.send({type:'GEMINI_RESULT',id,raw:JSON.stringify(valid)},sender);assert.equal(f.session.review.phase,'sending');
  sender.tab.id=f.created[0].id;
  await f.send({type:'GEMINI_PROGRESS',id},sender);assert.equal(f.session.review.phase,'waiting');
  await f.send({type:'GEMINI_RESULT',id,raw:JSON.stringify(valid)},sender);
  assert.equal(f.session.review.phase,'done');assert.equal(f.session.review.result.verdict,'correct');
  assert.equal(f.session.review.prompt,undefined);
});

test('sign-in and draft protection require Continue; closing the dedicated tab shows an error',async()=>{
  const f=fixture();f.setStatus({ready:false,reason:'Sign in first.'});
  await f.send({type:'CAPTURE_REVIEW',context:capture},f.chat);const id=f.session.review.id;
  await f.send({type:'SEND_REVIEW',id,selected:[]});assert.equal(f.session.review.phase,'needs_attention');
  assert.equal(f.sent.filter(x=>x.message.type==='GEMINI_START').length,0);
  f.setStatus({ready:true});await f.send({type:'CONTINUE_REVIEW',id});
  assert.equal(f.session.review.phase,'sending');
  f.removed(f.created[0].id);await f.send({type:'GET_REVIEW'});
  assert.equal(f.session.review.phase,'error');
});

test('oversized context, changed IDs, and expired work cannot trigger an automatic resend',async()=>{
  const f=fixture();await f.send({type:'CAPTURE_REVIEW',context:{...capture,history:Array.from({length:5},()=>({role:'user',text:'x'.repeat(8000)}))}},f.chat);
  const id=f.session.review.id;
  assert.ok((await f.send({type:'SEND_REVIEW',id,selected:[0,1,2,3,4]})).error);assert.equal(f.created.length,0);
  await f.send({type:'SEND_REVIEW',id,selected:[]});f.session.review.deadline=Date.now()-1;
  await f.send({type:'GET_REVIEW'});assert.equal(f.session.review.phase,'error');
  await f.send({type:'GEMINI_READY'}, {id:'test',url:'https://gemini.google.com/app',frameId:0,tab:{id:f.created[0].id}});
  assert.equal(f.sent.filter(x=>x.message.type==='GEMINI_START').length,1);
});

test('review parser rejects malformed output, keeps text inert, and excludes deselected context',()=>{
  const f=fixture();
  f.context.raw=JSON.stringify({...valid,summary:'<img src=x onerror=alert(1)>'});
  assert.equal(vm.runInContext('parseReview(raw).summary',f.context),'<img src=x onerror=alert(1)>');
  f.context.raw='not json';assert.equal(vm.runInContext('parseReview(raw)',f.context),null);
  f.context.raw=JSON.stringify({...valid,issues:[{severity:'made-up'}]});assert.equal(vm.runInContext('parseReview(raw)',f.context),null);
  f.context.sample={...capture,history:[{role:'user',text:'PRIVATE OMITTED MESSAGE'}]};
  assert.ok(!vm.runInContext('buildReviewPrompt(sample,[])',f.context).includes('PRIVATE OMITTED MESSAGE'));
  assert.throws(()=>vm.runInContext('buildReviewPrompt(sample,[99])',f.context));
  assert.equal(vm.runInContext('geminiHomeFor("https://gemini.google.com/u/1/app/abc")',f.context),'https://gemini.google.com/u/1/app');
  assert.equal(vm.runInContext('geminiHomeFor("https://evil.test/app")',f.context),null);
});

test('manifest grants no cookie or API endpoint access and all referenced files exist',()=>{
  const manifest=JSON.parse(read('manifest.json'));
  assert.deepEqual(manifest.permissions,['storage','sidePanel']);
  assert.deepEqual(manifest.host_permissions,['https://gemini.google.com/*']);
  for(const file of [manifest.background.service_worker,manifest.options_ui.page,manifest.side_panel.default_path,
    ...manifest.content_scripts.flatMap(item=>[...item.js,...(item.css||[])])])assert.ok(fs.existsSync(path.join(root,file)));
});
