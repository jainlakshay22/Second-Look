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
        requests.push({url,options,finish:(raw=JSON.stringify(valid),status=200,groundingMetadata)=>resolve({
          ok:status===200,status,
          body: new ReadableStream({start(controller) {
            controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:raw}]}}]})+'\n\n'));
            if (groundingMetadata) controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({candidates:[{groundingMetadata}]})+'\n\n'));
            controller.close();
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
    constructor(tag='div'){this.tag=tag;this.dataset={};this.listeners={};this.children=[];this.attributes={};}
    setAttribute(name,value){this.attributes[name]=value;}
    focus(){}
    set innerHTML(value){throw new Error('Unsafe rendering');}
    addEventListener(name,fn){this.listeners[name]=fn;}
    append(...nodes){this.children.push(...nodes);}
    replaceChildren(...nodes){this.children=nodes;}
  }
  const elements={}, pageEvents={};
  const panelContext=vm.createContext({AbortController,TextDecoder,URL,console,setTimeout:(fn,ms)=>setTimeout(fn,ms).unref(),clearTimeout,
    setInterval:()=>1,clearInterval(){},
    window:{addEventListener(name,fn){pageEvents[name]=fn;}},
    document:{querySelector(selector){return elements[selector] ||= new Element();},createElement:tag=>new Element(tag),createTextNode:text=>text},
    chrome:{storage:chrome.storage,runtime:{sendMessage:message=>dispatch(message)}},fetch:context.fetch,
  });
  for(const file of ['selectors.js','src/shared/settings.js','src/shared/review.js','src/background/gemini.js','src/sidepanel/claims.js','src/sidepanel/sidepanel.js'])vm.runInContext(read(file),panelContext);
  async function send(message,sender=panel) {
    const result=await dispatch(message,sender);
    // Simulate the trusted panel starting only the one request authorized by the worker.
    if(message.type==='SEND_REVIEW' && sender===panel && result?.ok){
      panelContext.approved=result;vm.runInContext('runReview(approved.id,approved.prompt,approved)',panelContext);await tick();
    }
    return result;
  }
  return {local,session,requests,opened,access,context,chat,panel,options,send,pageEvents,elements,panelContext,dispatch};
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

test('error recovery preserves selected context but requires a fresh explicit Send',async()=>{
  const f=fixture();const id=await prepare(f,{...capture,history:[{role:'user',text:'Selected context'},{role:'assistant',text:'Omitted context'}]});
  await f.send({type:'SEND_REVIEW',id,selected:[0]});await finish(f,0,undefined,429);
  assert.equal(await f.send({type:'EDIT_REVIEW',id},f.chat),null);
  assert.equal(await f.send({type:'EDIT_REVIEW',id},f.options),null);
  assert.equal((await f.send({type:'EDIT_REVIEW',id})).ok,true);
  const next=f.session.review.id;
  assert.notEqual(next,id);assert.equal(f.session.review.phase,'preview');
  assert.deepEqual([...f.session.review.selected],[0]);assert.equal(f.session.review.context.reply,'323');
  assert.equal(f.session.review.error,undefined);assert.equal(f.requests.length,1);
  assert.ok((await f.send({type:'API_REVIEW_RESULT',id,raw:JSON.stringify(valid)})).error);
  assert.ok((await f.send({type:'EDIT_REVIEW',id})).error);
  assert.equal(f.session.review.id,next);assert.equal(f.requests.length,1);
  await f.send({type:'SEND_REVIEW',id:next,selected:[0]});
  assert.equal(f.requests.length,2);assert.ok(!f.requests[1].options.body.includes('Omitted context'));
  await finish(f,1);assert.equal(f.session.review.phase,'done');
});

test('Review again reopens a result, while preview, waiting, and cancelled states reject it',async()=>{
  const f=fixture();const id=await prepare(f);
  assert.ok((await f.send({type:'EDIT_REVIEW',id})).error);
  await f.send({type:'SEND_REVIEW',id,selected:[]});
  assert.ok((await f.send({type:'EDIT_REVIEW',id})).error);
  await finish(f);assert.equal((await f.send({type:'EDIT_REVIEW',id})).ok,true);
  const next=f.session.review.id;
  assert.equal(f.session.review.result,undefined);assert.equal(f.session.review.raw,undefined);
  assert.equal(f.requests.length,1);
  await f.send({type:'CANCEL_REVIEW',id:next});
  assert.ok((await f.send({type:'EDIT_REVIEW',id:next})).error);
  assert.equal(f.session.review.context,undefined);
});

const descendants = node => typeof node === 'string' ? [] : [node,...node.children.flatMap(descendants)];
const groundUrl = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/example';
const claimReview = {summary:'The product is supported.',claims:[{
  id:'claim-1',quote:'323',verdict:'supported',explanation:'The multiplication gives 323.',sources:[groundUrl],
}]};
const groundMetadata = {groundingChunks:[{web:{uri:groundUrl,title:'Multiplication reference'}}],webSearchQueries:['17 times 19']};

test('Verify selector persists mode, SEND_REVIEW streams grounded claims, and the panel renders a highlight',async()=>{
  const f=fixture({local:{groundingEnabled:true}});const id=await prepare(f);await tick();
  assert.equal(f.session.review.mode,'review');
  assert.equal(f.elements['#grounding-notice'].hidden,true);
  f.elements['#review-mode'].value='verify_claims';
  await f.elements['#review-mode'].listeners.change();
  assert.equal(f.session.review.mode,'verify_claims');assert.equal(f.requests.length,0);
  assert.equal(f.elements['#grounding-notice'].hidden,false);
  const preview=f.elements['#prompt'].textContent;
  assert.match(preview,/Use Google Search/);
  assert.match(preview,/factual-claim verifier/);
  await f.elements['#send'].listeners.click();await tick();
  assert.equal(f.requests.length,1);assert.equal(f.session.review.phase,'waiting');
  const body=JSON.parse(f.requests[0].options.body);
  assert.deepEqual(body.tools,[{google_search:{}}]);
  assert.equal(body.contents[0].parts[0].text,preview);
  assert.deepEqual(body.generationConfig.responseJsonSchema.required,['claims','summary']);
  f.requests[0].finish(JSON.stringify(claimReview),200,groundMetadata);
  await tick();await tick();await f.send({type:'GET_REVIEW'});await tick();
  assert.equal(f.session.review.phase,'done');assert.equal(f.session.review.mode,'verify_claims');
  assert.deepEqual(f.session.review.result.review,claimReview);
  assert.deepEqual(f.session.review.result.grounding.sources,[groundUrl]);
  assert.equal(f.session.review.result.grounding.status,'grounded');
  const highlight=descendants(f.elements['#result']).find(node=>node.className==='claim-highlight');
  assert.ok(highlight);assert.equal(highlight.textContent,'323');assert.equal(highlight.dataset.verdict,'supported');
  highlight.listeners.click();
  const link=descendants(f.elements['#result']).find(node=>node.tag==='a');
  assert.equal(link.textContent,'Multiplication reference');assert.equal(link.href,groundUrl);
  assert.equal(link.rel,'noopener noreferrer');
  // Reopening reads the saved envelope; it never requests another review.
  vm.runInContext("renderedKey = ''; refresh()",f.panelContext);await tick();
  assert.ok(descendants(f.elements['#result']).some(node=>node.className==='claim-highlight'));
  assert.equal(f.requests.length,1);
  await f.send({type:'EDIT_REVIEW',id});await tick();
  assert.equal(f.session.review.mode,'verify_claims');assert.equal(f.elements['#review-mode'].value,'verify_claims');
});

test('Verify without grounding or with no returned sources still renders unverified claims',async()=>{
  for(const groundingEnabled of [false,true]) {
    const f=fixture({local:{groundingEnabled}});const id=await prepare(f);
    await f.send({type:'SEND_REVIEW',id,selected:[],mode:'verify_claims',groundingEnabled});
    const body=JSON.parse(f.requests[0].options.body);
    assert.equal(Boolean(body.tools),groundingEnabled);
    await finish(f,0,JSON.stringify(claimReview));await tick();
    assert.equal(f.session.review.phase,'done');
    assert.equal(f.session.review.result.grounding.status,groundingEnabled?'no_sources':'disabled');
    assert.equal(f.session.review.result.review.claims[0].verdict,'unverified');
    assert.deepEqual(f.session.review.result.review.claims[0].sources,[]);
    assert.equal(descendants(f.elements['#result']).find(n=>n.className==='claim-highlight').dataset.verdict,'unverified');
  }
});

test('Review keeps the original schema, prompt and result even with grounding switched on',async()=>{
  const f=fixture({local:{groundingEnabled:true}});const id=await prepare(f);await tick();
  const preview=f.elements['#prompt'].textContent;
  await f.send({type:'SEND_REVIEW',id,selected:[],mode:'review'});
  const body=JSON.parse(f.requests[0].options.body);
  assert.equal(body.tools,undefined);assert.equal(body.contents[0].parts[0].text,preview);
  assert.ok(body.generationConfig.responseJsonSchema.properties.verdict);
  assert.equal(f.elements['#grounding-notice'].hidden,true);
  await finish(f);await tick();assert.deepEqual(f.session.review.result,valid);
  assert.equal(descendants(f.elements['#result']).some(n=>n.className==='claim-highlight'),false);
});

test('mode changes require the trusted preview, preserve context selection, and reject unknown modes',async()=>{
  const f=fixture();const id=await prepare(f,{...capture,history:[{role:'user',text:'Optional earlier message'}]});await tick();
  const change={type:'SET_REVIEW_MODE',id,mode:'verify_claims',selected:[0]};
  assert.equal(await f.send(change,f.chat),null);
  assert.ok((await f.send({...change,mode:'invalid'})).error);
  await f.send(change);await tick();
  assert.equal(f.session.review.mode,'verify_claims');assert.deepEqual(f.session.review.selected,[0]);
  assert.equal(f.requests.length,0);
  assert.ok((await f.send({type:'SEND_REVIEW',id,mode:'invalid',selected:[]})).error);
  await f.send({type:'SEND_REVIEW',id,selected:[0],mode:'verify_claims',groundingEnabled:false});
  assert.ok((await f.send(change)).error);
  await f.send({type:'CANCEL_REVIEW',id});await tick();
  assert.equal(f.requests[0].options.signal.aborted,true);
  await finish(f,0,JSON.stringify(claimReview));
  assert.equal(f.session.review.phase,'cancelled');
});

test('changed Search settings require another explicit Send and use the approved setting during the request',async()=>{
  const f=fixture({local:{groundingEnabled:false}});const id=await prepare(f);
  f.local.groundingEnabled=true;
  const send={type:'SEND_REVIEW',id,selected:[],mode:'verify_claims',groundingEnabled:false};
  assert.match((await f.send(send)).error,/Search settings changed/);
  assert.equal(f.requests.length,0);assert.equal(f.session.review.phase,'preview');
  const approved=await f.dispatch({...send,groundingEnabled:true});
  f.local.groundingEnabled=false;
  f.panelContext.approved=approved;
  vm.runInContext('runReview(approved.id,approved.prompt,approved)',f.panelContext);await tick();
  assert.deepEqual(JSON.parse(f.requests[0].options.body).tools,[{google_search:{}}]);
  assert.equal(f.session.review.groundingEnabled,true);
  await finish(f,0,JSON.stringify(claimReview));
});

test('worker validates verification output against the saved answer and grounding evidence',async()=>{
  for(const invalid of [
    {...claimReview,claims:[{...claimReview.claims[0],quote:'not the selected answer'}]},
    {...claimReview,claims:[{...claimReview.claims[0],sources:['https://invented.example/']}]},
  ]) {
    const f=fixture({local:{groundingEnabled:true}});const id=await prepare(f);
    await f.dispatch({type:'SEND_REVIEW',id,selected:[],mode:'verify_claims',groundingEnabled:true});
    await f.dispatch({type:'API_REVIEW_RESULT',id,mode:'review',result:{review:invalid,grounding:{metadata:[groundMetadata]}}});
    assert.equal(f.session.review.phase,'error');assert.equal(f.session.review.result,undefined);
    assert.equal(f.requests.length,0);
  }
});
