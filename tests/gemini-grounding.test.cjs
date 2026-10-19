const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/example';
const answer = 'Paris is the capital of France.';
const contextData = {source:'chatgpt.com', question:'What is the capital of France?', reply:answer, history:[]};
const review = (sources = [source], verdict = 'supported') => ({claims:[{
  id:'c1', quote:answer, verdict, explanation:'The source identifies Paris as the capital.', sources,
}], summary:'The claim is supported.'});
const event = candidate => ({candidates:[candidate]});
const metadata = urls => ({groundingChunks:urls.map(uri => ({web:{uri,title:'Source'}}))});

function fixture({enabled=true, model='gemini-3.5-flash-lite', value=review(), events, partial=false, status=200}={}) {
  const requests=[], timers=new Set();
  const ctx=vm.createContext({AbortController,TextDecoder,URL,
    chrome:{storage:{local:{get:async defaults=>({...defaults, provider:'google',model,apiKey:'fake-test-key',groundingEnabled:enabled})}}},
    setTimeout(fn, ms) { assert.ok([25000,90000].includes(ms)); const t=setTimeout(fn,1000);timers.add(t);return t; },
    clearTimeout(t) {timers.delete(t);clearTimeout(t);},
    async fetch(url,options) {
      requests.push({url,options,body:JSON.parse(options.body)});
      const streamEvents=events || [event({content:{parts:[{text:JSON.stringify(value)}]},finishReason:'STOP',groundingMetadata:metadata([source])})];
      const bytes=new TextEncoder().encode(streamEvents.map(e=>'data: '+JSON.stringify(e)+'\r\n\r\n').join(''));
      let cursor=0;
      return {ok:status===200,status,
        json:async()=>({candidates:[{finishReason:'STOP',content:{parts:[{text:'OK'}]}}]}),
        body:new ReadableStream({pull(controller) {
          if(cursor===bytes.length){controller.close();return;}
          const end=partial?cursor+1:bytes.length;
          controller.enqueue(bytes.slice(cursor,end));cursor=end;
        }})};
    },
    contextData,
  });
  for(const file of ['src/shared/settings.js','src/shared/review.js','src/background/gemini.js'])
    vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),ctx);
  return {requests,timers,run:(expression='generateGeminiReview(contextData,[],{mode:"verify_claims"})')=>vm.runInContext(expression,ctx)};
}
const plain = value => JSON.parse(JSON.stringify(value));

test('verify claims enables the documented REST tool and keeps the strict schema and sources',async()=>{
  const f=fixture();const result=await f.run();
  assert.deepEqual(f.requests[0].body.tools,[{google_search:{}}]);
  assert.equal(f.requests[0].body.generationConfig.responseMimeType,'application/json');
  assert.deepEqual(f.requests[0].body.generationConfig.responseJsonSchema.required,['claims','summary']);
  assert.match(f.requests[0].body.contents[0].parts[0].text,/Use Google Search/);
  assert.deepEqual(plain(result.review),review());
  assert.deepEqual(plain(result.grounding.sources),[source]);
  assert.equal(result.grounding.status,'grounded');
  assert.equal(f.timers.size,0);
});

test('grounding is limited to verify claims even when saved on',async()=>{
  for(const expression of [
    'generateGeminiText("test")',
    'generateGeminiText("test",{connectionTest:true})',
    'generateGeminiText("test",{connectionTest:true,mode:"verify_claims"})',
    'generateGeminiText("test",{schema:REVIEW_RESPONSE_SCHEMA})',
  ]) {
    const f=fixture();await f.run(expression);
    assert.equal(f.requests[0].body.tools,undefined);
    assert.doesNotMatch(f.requests[0].body.contents[0].parts[0].text,/Use Google Search/);
  }
});

test('disabled or malformed saved toggle never enables search or claims independent verification',async()=>{
  for(const enabled of [false,null,'true',1]) {
    const f=fixture({enabled});const result=await f.run();
    assert.equal(f.requests[0].body.tools,undefined);
    assert.equal(result.grounding.status,'disabled');
    assert.deepEqual(plain(result.grounding.sources),[]);
    assert.equal(result.review.claims[0].verdict,'unverified');
    assert.deepEqual(plain(result.review.claims[0].sources),[]);
  }
});

test('grounding metadata survives split UTF-8, metadata-only events, and events after STOP',async()=>{
  const meta={...metadata([source]),webSearchQueries:['capital of France'],
    groundingSupports:[{segment:{text:'Paris'},groundingChunkIndices:[0]}],
    searchEntryPoint:{renderedContent:'<div>inert suggestions</div>'}};
  const f=fixture({partial:true,events:[
    event({content:{parts:[{thought:true,text:'ignore'},{text:JSON.stringify(review())}]},finishReason:'STOP'}),
    event({groundingMetadata:meta}),
    event({groundingMetadata:metadata([source,'https://example.org/café'])}),
  ]});
  const result=await f.run();
  assert.deepEqual(plain(result.grounding.sources),[source,'https://example.org/café']);
  assert.deepEqual(plain(result.grounding.metadata[0]),meta);
  assert.equal(result.review.claims[0].verdict,'supported');
});

for(const [name,groundingMetadata] of [
  ['missing',undefined], ['empty',{}], ['queries only',{webSearchQueries:['query']}],
  ['no web sources',{groundingChunks:[{retrievedContext:{uri:source}}]}],
  ['unsafe URLs',metadata(['javascript:alert(1)','data:text/plain,test','https://user:password@example.org',
    'https://example.org/a b','https://example.org/\\evil','https://','https://example.org/\n'])],
]) test('no-source handling: '+name,async()=>{
  const f=fixture({events:[event({content:{parts:[{text:JSON.stringify(review())}]},finishReason:'STOP',groundingMetadata})]});
  const result=await f.run();
  assert.equal(result.grounding.status,'no_sources');
  assert.deepEqual(plain(result.grounding.sources),[]);
  assert.equal(result.review.claims[0].verdict,'unverified');
  assert.deepEqual(plain(result.review.claims[0].sources),[]);
  assert.match(result.review.summary,/no usable sources/);
  assert.equal(f.requests.length,1);
});

test('unverified output with no citations and no factual claims are valid results',async()=>{
  for(const value of [review([],'unverified'),{claims:[],summary:'No factual claims.'}]) {
    const f=fixture({events:[event({content:{parts:[{text:JSON.stringify(value)}]},finishReason:'STOP'})]});
    const result=await f.run();assert.equal(result.review.claims.length,value.claims.length);
  }
});

test('invented citations are removed without assigning unrelated provider sources to the claim',async()=>{
  const f=fixture({value:review(['https://invented.example/fake'],'contradicted')});
  const result=await f.run();
  assert.deepEqual(plain(result.grounding.sources),[source]);
  assert.deepEqual(plain(result.review.claims[0].sources),[]);
  assert.equal(result.review.claims[0].verdict,'unverified');
  assert.match(result.review.summary,/remain unverified/);
});

test('claim-specific citations stay separate and exact quotes remain validated',async()=>{
  const value=review([source,'https://invented.example/fake']);
  const result=await fixture({value}).run();
  assert.deepEqual(plain(result.review.claims[0].sources),[source]);
  assert.equal(result.review.claims[0].verdict,'supported');
  value.claims[0].quote='Paraphrased claim';
  await assert.rejects(fixture({value}).run(),/invalid review/);
});

test('unsupported models fail before fetching, while disabled grounding still works',async()=>{
  const f=fixture({model:'gemini-2.5-flash'});
  await assert.rejects(f.run(),/requires a Gemini 3 or 4 model/);
  assert.equal(f.requests.length,0);assert.equal(f.timers.size,0);
  await fixture({model:'gemini-2.5-flash',enabled:false}).run();
});

test('grounding failures do not silently retry without Search',async()=>{
  const f=fixture({status:400});
  await assert.rejects(f.run(),/Google rejected/);
  assert.equal(f.requests.length,1);assert.equal(f.timers.size,0);
});

test('unknown mode is rejected without fetching',async()=>{
  const f=fixture();
  await assert.rejects(f.run('generateGeminiResponse("test",{mode:"typo"})'),/Unknown review mode/);
  assert.equal(f.requests.length,0);
});
