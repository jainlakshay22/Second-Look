const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const capture = {source:'chatgpt.com',question:'What is 17 times 19?',reply:'323',history:[],capturedAt:new Date().toISOString()};
const valid = {verdict:'correct',summary:'The arithmetic is correct.',issues:[],missing_points:[],strengths:['Correct product.']};
function fixture({session = {}, local = {}} = {}) {
  local = {provider:'google',apiKey:'fake-test-key',model:'gemini-3.5-flash-lite',geminiHome:'obsolete',browserSetup:true,...local};
  const requests = [], opened = [], access = [];
  let listener;
  const changed = [];
  const area = (data,name) => ({
    async setAccessLevel(value) {assert.equal(value.accessLevel,'TRUSTED_CONTEXTS');access.push(name);},
    async get(defaults) {return typeof defaults==='string'?{[defaults]:structuredClone(data[defaults])}
      :Object.fromEntries(Object.entries(defaults).map(([k,v])=>[k,structuredClone(data[k]??v)]));},
    async set(values) {Object.assign(data,structuredClone(values));for(const fn of changed)fn(Object.fromEntries(Object.entries(values).map(([k,v])=>[k,{newValue:v}])),name);},
    async remove(keys) {for(const key of Array.isArray(keys)?keys:[keys])delete data[key];},
  });
  const runtime = {id:'test',getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener(fn){listener=fn;}},onInstalled:{addListener(){}},openOptionsPage(){}};
  const chrome = {runtime,storage:{local:area(local,'local'),session:area(session,'session'),onChanged:{addListener(fn){changed.push(fn);}}},sidePanel:{async open(value){opened.push(value);}}};
  const context = vm.createContext({chrome,crypto:webcrypto,URL,console,Date,AbortController,TextDecoder,setTimeout:(fn,ms)=>setTimeout(fn,ms).unref(),clearTimeout,
    fetch(url,options) {
      return new Promise(resolve => {
        requests.push({url,options,finish:(raw=JSON.stringify(valid),status=200)=>resolve({
          ok:status===200,status,
          body: new ReadableStream({start(controller) {
            controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:raw}]}}]})+'\n\n')); controller.close();
          }}),
          json:async()=>({candidates:[{finishReason:'STOP',content:{parts:[{text:raw}]}}]}),
        })});
      });
    },
  });
  context.importScripts=(...paths)=>paths.forEach(p=>vm.runInContext(read(path.posix.join('src/background',p)),context));
  vm.runInContext(read('src/background/service-worker.js'),context);
  const chat={id:'test',url:'https://chatgpt.com/c/example',frameId:0,tab:{id:1,windowId:2}};
  const panel={id:'test',url:runtime.getURL('src/sidepanel/sidepanel.html')};
  const options={id:'test',url:runtime.getURL('src/options/options.html')};
  function dispatch(message,sender=panel) {return new Promise(resolve=>{if(!listener(message,sender,resolve))resolve(null);});}
  class Element {
    constructor(){this.dataset={};this.listeners={};this.children=[];}
    addEventListener(name,fn){this.listeners[name]=fn;}
    append(...nodes){this.children.push(...nodes);}
    replaceChildren(...nodes){this.children=nodes;}
  }
  const elements={}, pageEvents={};
  const panelContext=vm.createContext({AbortController,TextDecoder,console,setTimeout:(fn,ms)=>setTimeout(fn,ms).unref(),clearTimeout,
    setInterval:()=>1,clearInterval(){},
    window:{addEventListener(name,fn){pageEvents[name]=fn;}},
    document:{querySelector(selector){return elements[selector] ||= new Element();},createElement:()=>new Element(),createTextNode:text=>text},
    chrome:{storage:chrome.storage,runtime:{sendMessage:message=>dispatch(message)}},fetch:context.fetch,
  });
  for(const file of ['selectors.js','src/shared/settings.js','src/shared/review.js','src/background/gemini.js','src/sidepanel/sidepanel.js'])vm.runInContext(read(file),panelContext);
  async function send(message,sender=panel) {
    const result=await dispatch(message,sender);
    // Simulate the trusted panel starting only the one request authorized by the worker.
    if(message.type==='SEND_REVIEW' && sender===panel && result?.ok){
      panelContext.approved=result;vm.runInContext('runReview(approved.id,approved.prompt)',panelContext);await tick();
    }
    return result;
  }
  return {local,session,requests,opened,access,context,chat,panel,options,send,pageEvents};
}
async function prepare(f,context=capture) {await f.send({type:'CAPTURE_REVIEW',context},f.chat);return f.session.review.id;}
async function finish(f,index=0,raw,status) {f.requests[index].finish(raw,status);await tick();await f.send({type:'GET_REVIEW'});}

test('capture, settings read, and cancellation send no data; old browser settings are cleared',async()=>{
  const f=fixture({session:{setupTabId:10,review:{id:'old',phase:'waiting'}}});
  assert.equal((await f.send({type:'GET_REVIEW'})).review,null);
  assert.equal((await f.send({type:'OPEN_PREVIEW'},f.chat)).ok,true);
  assert.deepEqual({...await f.send({type:'GET_CAPTURE_SETTINGS'},f.chat)},{historyCount:4});
  const id=await prepare(f);
  assert.equal(f.session.review.phase,'preview');assert.equal(f.requests.length,0);
  await f.send({type:'CANCEL_REVIEW',id});
  assert.equal(f.session.review.context,undefined);assert.equal(f.requests.length,0);
  assert.equal(f.local.apiKey,'fake-test-key');assert.equal(f.local.geminiHome,undefined);assert.equal(f.session.setupTabId,undefined);
  assert.deepEqual(f.access.sort(),['local','session']);
});

test('only trusted Send submits once, with schema, and returns a structured review',async()=>{
  const f=fixture();const id=await prepare(f);
  for(const sender of [f.chat,f.options,{...f.panel,id:'other'}])assert.equal(await f.send({type:'SEND_REVIEW',id,selected:[]},sender),null);
  assert.ok((await f.send({type:'SEND_REVIEW',id:'stale',selected:[]})).error);
  await Promise.all([f.send({type:'SEND_REVIEW',id,selected:[]}),f.send({type:'SEND_REVIEW',id,selected:[]})]);
  assert.equal(f.requests.length,1);assert.equal(f.session.review.phase,'waiting');
  const {url,options}=f.requests[0],body=JSON.parse(options.body);
  assert.ok(url.startsWith('https://generativelanguage.googleapis.com/v1beta/models/'));
  assert.equal(options.headers['x-goog-api-key'],'fake-test-key');
  assert.ok(!JSON.stringify(f.session).includes('fake-test-key'));
  assert.ok(!options.body.includes('fake-test-key'));assert.ok(!url.includes('fake-test-key'));
  assert.equal(body.generationConfig.responseMimeType,'application/json');
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel,'MINIMAL');
  assert.deepEqual(body.generationConfig.responseJsonSchema.properties.verdict.enum,['correct','mostly_correct','questionable','incorrect']);
  await finish(f);
  assert.equal(f.session.review.phase,'done');assert.equal(f.session.review.result.verdict,'correct');
  assert.equal(await f.send({type:'GEMINI_RESULT',id,raw:'fake'},f.chat),null);
});

test('cancel is responsive during a request and late completion cannot replace a newer review',async()=>{
  const f=fixture();const id=await prepare(f);await f.send({type:'SEND_REVIEW',id,selected:[]});
  assert.equal((await f.send({type:'GET_REVIEW'})).review.phase,'waiting');
  await f.send({type:'CANCEL_REVIEW',id});await tick();
  assert.equal(f.requests[0].options.signal.aborted,true);
  const next=await prepare(f,{...capture,question:'A different question'});
  await finish(f);
  assert.equal(f.session.review.id,next);assert.equal(f.session.review.phase,'preview');
});

test('oversized and invalid selections never call Google; expired reviews never resend',async()=>{
  const f=fixture();const id=await prepare(f,{...capture,history:Array.from({length:5},()=>({role:'user',text:'x'.repeat(8000)}))});
  for(const selected of [[0,1,2,3,4],[99],[0,0]])assert.ok((await f.send({type:'SEND_REVIEW',id,selected})).error);
  assert.equal(f.requests.length,0);
  await f.send({type:'SEND_REVIEW',id,selected:[]});f.session.review.deadline=Date.now()-1;
  await f.send({type:'GET_REVIEW'});assert.equal(f.session.review.phase,'error');
  await finish(f);assert.equal(f.session.review.phase,'error');assert.equal(f.requests.length,1);
});

test('missing key, quota errors, and restarted workers produce useful errors without retries',async()=>{
  const missing=fixture({local:{apiKey:''}});let id=await prepare(missing);
  await missing.send({type:'SEND_REVIEW',id,selected:[]});await tick();
  assert.equal(missing.requests.length,0);assert.match(missing.session.review.error,/API key/);
  const f=fixture();id=await prepare(f);await f.send({type:'SEND_REVIEW',id,selected:[]});await finish(f,0,undefined,429);
  assert.match(f.session.review.error,/quota/);assert.equal(f.requests.length,1);
  const restarted=fixture({session:{review:{id:'interrupted',transport:'api',phase:'waiting',deadline:Date.now()+30000}}});
  await restarted.send({type:'GET_REVIEW'});assert.equal(restarted.session.review.phase,'waiting');assert.equal(restarted.requests.length,0);
  restarted.session.review.deadline=Date.now()-1;await restarted.send({type:'GET_REVIEW'});assert.match(restarted.session.review.error,/interrupted/);
});

test('connection test is restricted to Settings and never sends captured conversation',async()=>{
  const f=fixture();await prepare(f,{...capture,reply:'PRIVATE CONVERSATION SAMPLE'});
  assert.equal(await f.send({type:'TEST_GEMINI_CONNECTION'},f.chat),null);
  const tested=f.send({type:'TEST_GEMINI_CONNECTION'},f.options);await tick();
  assert.ok((await f.send({type:'TEST_GEMINI_CONNECTION'},f.options)).error);
  assert.equal(f.requests.length,1);assert.ok(!f.requests[0].options.body.includes('PRIVATE CONVERSATION SAMPLE'));
  f.requests[0].finish('OK');assert.equal((await tested).ok,true);assert.equal(f.session.review.phase,'preview');
});

test('malformed output falls back to inert text, and omitted context stays out of prompts',async()=>{
  const f=fixture();const id=await prepare(f,{...capture,history:[{role:'user',text:'PRIVATE OMITTED MESSAGE'}]});
  await f.send({type:'SEND_REVIEW',id,selected:[]});assert.ok(!f.requests[0].options.body.includes('PRIVATE OMITTED MESSAGE'));
  await finish(f,0,'<img src=x onerror=alert(1)>');assert.equal(f.session.review.result,null);
  assert.equal(f.session.review.raw,'<img src=x onerror=alert(1)>');
  f.context.raw=JSON.stringify({...valid,issues:[{severity:'made-up'}]});assert.equal(vm.runInContext('parseReview(raw)',f.context),null);
});

test('manifest uses API host only and all referenced files exist',()=>{
  const manifest=JSON.parse(read('manifest.json'));
  assert.deepEqual(manifest.permissions,['storage','sidePanel']);
  assert.deepEqual(manifest.host_permissions,['https://generativelanguage.googleapis.com/*']);
  assert.equal(manifest.content_scripts.length,1);
  assert.deepEqual(manifest.content_scripts[0].matches,['https://chatgpt.com/*']);
  for(const file of [manifest.background.service_worker,manifest.options_ui.page,manifest.side_panel.default_path,
    ...manifest.content_scripts.flatMap(item=>[...item.js,...(item.css||[])])])assert.ok(fs.existsSync(path.join(root,file)));
});

test('closing the panel aborts its API request and prevents late results from appearing',async()=>{
  const f=fixture();const id=await prepare(f);await f.send({type:'SEND_REVIEW',id,selected:[]});
  f.pageEvents.pagehide();await tick();
  assert.equal(f.requests[0].options.signal.aborted,true);
  assert.equal(f.session.review.phase,'cancelled');
  await finish(f);assert.equal(f.session.review.phase,'cancelled');assert.equal(f.requests.length,1);
});
