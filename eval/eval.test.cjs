const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {loadCases,loadRuntime,runEvaluation}=require('./run-eval.js');
const {scoreResults,markdownReport,matchPrediction}=require('./score.js');
const fixture=loadCases();
const url='https://example.org/synthetic-evidence';
function prediction(quote,verdict='contradicted',id='p1') {
  return {id,quote,verdict,explanation:'Synthetic evidence for the test.',sources:verdict==='unverified'?[]:[url]};
}
function record(item,claims) {
  return {id:item.id,status:'ok',result:{review:{claims,summary:'Synthetic review.'},
    grounding:{enabled:true,status:'grounded',sources:[url],metadata:[]}}};
}
function results(records=[]) {
  return {version:1,fixtureSha256:fixture.sha256,model:'test-model',status:'complete',groundingEnabled:true,cases:records};
}

test('exactly 25 cases cover all requested categories with valid gold spans',()=>{
  assert.equal(fixture.cases.length,25);
  const counts={};for(const item of fixture.cases) counts[item.category]=(counts[item.category]||0)+1;
  assert.deepEqual(counts,{correct_fact:6,planted_fact:6,correct_math:2,wrong_math:4,correct_code:2,buggy_code:5});
  assert.ok(fixture.cases.some(item=>item.ground_truth.claims.some(c=>c.is_wrong) && item.ground_truth.claims.some(c=>!c.is_wrong)));
});

test('a perfect result catches every wrong claim without false alarms',()=>{
  const saved=results(fixture.cases.map(item=>record(item,item.ground_truth.claims.map((gold,i)=>prediction(gold.quote,gold.is_wrong?'contradicted':'supported',String(i))))));
  const {totals}=scoreResults(fixture,saved);
  assert.equal(totals.caught,totals.wrong);assert.equal(totals.falseAlarms,0);
  assert.equal(totals.omitted,0);assert.equal(totals.covered,totals.wrong+totals.correct);
  assert.match(markdownReport(fixture,saved),/100\.0%/);
});

test('duplicate predictions count once, incorrect flags create false alarms, and abstentions miss catches',()=>{
  const correct=fixture.cases[0],wrong=fixture.cases[6];
  const saved=results([
    record(correct,[prediction(correct.ground_truth.claims[0].quote,'contradicted','a'),prediction(correct.ground_truth.claims[0].quote,'contradicted','b')]),
    record(wrong,[prediction(wrong.ground_truth.claims[0].quote,'unverified')]),
  ]);
  const {totals}=scoreResults(fixture,saved);
  assert.equal(totals.falseAlarms,1);assert.equal(totals.caught,0);assert.equal(totals.unverified,1);
  assert.equal(totals.notRun,23);assert.equal(totals.omitted,totals.wrong+totals.correct-2);
  assert.match(markdownReport(fixture,saved),/Incomplete\/failed run/);
});

test('broad mixed quotes are ambiguous; accepted code anchors match the annotated behavior',()=>{
  const mixed=fixture.cases[6];assert.deepEqual(matchPrediction(mixed,prediction(mixed.answer)),[0,1]);
  const saved=results([record(mixed,[prediction(mixed.answer)])]);
  assert.equal(scoreResults(fixture,saved).totals.ambiguousPredictions,1);
  assert.equal(scoreResults(fixture,saved).totals.caught,0);
  const code=fixture.cases.find(item=>item.id==='code-04');
  assert.deepEqual(matchPrediction(code,prediction('return items[len(items)]')),[0]);
});

test('invalid quotes or ungrounded sources fail; fixture changes and duplicate records are rejected',()=>{
  const item=fixture.cases[0];
  for(const claims of [[prediction('not in the answer')],[{...prediction(item.answer),sources:['https://not-grounded.example/']}]]) {
    const {totals}=scoreResults(fixture,results([record(item,claims)]));
    assert.equal(totals.invalidOutputs,1);assert.equal(totals.falseAlarms,0);
  }
  assert.throws(()=>scoreResults(fixture,{...results(),fixtureSha256:'changed'}),/hash mismatch/);
  const r=record(item,[]);assert.throws(()=>scoreResults(fixture,results([r,r])),/duplicate/);
});

test('zero truth denominators print N/A',()=>{
  const small={...fixture,cases:[fixture.cases[0]]};
  const report=markdownReport(small,results([record(small.cases[0],[])]));
  assert.match(report,/Catch rate \(wrong claims contradicted\) \| N\/A/);
});

test('runner uses the real prompt/client, excludes gold data, and saves grounded results',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'second-look-eval-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const item=fixture.cases[0],requests=[];
  const runtime=loadRuntime({apiKey:'test-only',fetchImpl:async (requestUrl,options)=>{
    requests.push({requestUrl,body:JSON.parse(options.body)});
    const result={claims:[prediction(item.answer,'supported')],summary:'Synthetic review.'};
    return new Response('data: '+JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify(result)}]},finishReason:'STOP',
      groundingMetadata:{groundingChunks:[{web:{uri:url,title:'Synthetic source'}}]}}]})+'\n\n',
      {status:200,headers:{'Content-Type':'text/event-stream'}});
  }});
  const output=path.join(dir,'results.json');
  const result=await runEvaluation({fixture:{...fixture,cases:[item]},runtime,model:runtime.model,grounding:true,output,intervalMs:0,log:()=>{}});
  assert.equal(result.status,'complete');assert.equal(requests.length,1);
  const prompt=requests[0].body.contents[0].parts[0].text;
  const input=JSON.parse(prompt.split('\nINPUT DATA\n')[1]);
  assert.deepEqual(input,{question:item.question,answer_to_review:item.answer,earlier_messages:[]});
  assert.doesNotMatch(prompt,/ground_truth|is_wrong|accepted_quotes|test-only/);
  assert.deepEqual(requests[0].body.tools,[{google_search:{}}]);
  const saved=JSON.parse(fs.readFileSync(output,'utf8'));
  assert.equal(saved.cases[0].result.review.claims[0].verdict,'supported');
  assert.deepEqual(saved.cases[0].result.grounding.sources,[url]);
  assert.doesNotMatch(fs.readFileSync(output,'utf8'),/test-only|apiKey|x-goog-api-key/);
});

test('quota failure saves partial output, stops without retrying, and hides raw errors',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'second-look-eval-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let requests=0,status;
  const runtime=loadRuntime({apiKey:'test-only',fetchImpl:async()=>{
    requests++;status=429;return new Response(JSON.stringify({error:{message:'private provider details'}}),{status});
  }});
  const output=path.join(dir,'results.json');
  const result=await runEvaluation({fixture,runtime,model:runtime.model,grounding:true,output,intervalMs:0,log:()=>{},httpStatus:()=>status});
  assert.equal(requests,1);assert.equal(result.status,'stopped');assert.equal(result.cases[0].httpStatus,429);
  assert.equal(result.cases.filter(item=>item.status==='not_run').length,24);
  assert.doesNotMatch(fs.readFileSync(output,'utf8'),/test-only|private provider details/);
});

test('conflicting predictions and unmatched extracted text are visible in the report',()=>{
  const item=fixture.cases[0],code=fixture.cases.find(c=>c.id==='code-01');
  const saved=results([
    record(item,[prediction(item.answer,'supported','a'),prediction(item.answer,'contradicted','b')]),
    record(code,[prediction('def square(n):','unverified')]),
  ]);
  const {totals}=scoreResults(fixture,saved);
  assert.equal(totals.conflicts,1);assert.equal(totals.falseAlarms,1);assert.equal(totals.unmatchedPredictions,1);
  assert.deepEqual(matchPrediction(item,{quote:''}),[]);
});

test('an interrupted run preserves not-run cases without sending data',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'second-look-eval-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const controller=new AbortController();controller.abort();
  const result=await runEvaluation({fixture,runtime:{sourceHashes:{},generateGeminiReview(){throw new Error('must not run');}},
    model:'test-model',grounding:true,output:path.join(dir,'results.json'),signal:controller.signal,log:()=>{}});
  assert.equal(result.status,'interrupted');assert.equal(result.cases.filter(c=>c.status==='not_run').length,25);
});
