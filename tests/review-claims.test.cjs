const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({URL});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/shared/review.js'),'utf8'),context);
const run = (expression,values={}) => { Object.assign(context,values); return vm.runInContext(expression,context); };
const answer = 'Canberra is the capital of Australia. Sydney is the largest city.';
const sample = {source:'chatgpt.com',question:'Describe two Australian cities.',reply:answer,history:[
  {role:'user',text:'INCLUDED CONTEXT'}, {role:'assistant',text:'OMITTED CONTEXT'},
]};
const claim = (overrides={}) => ({id:'claim-1',quote:'Canberra is the capital of Australia.',verdict:'unverified',
  explanation:'No verification evidence was supplied.',sources:[],...overrides});
const review = claims => ({claims:claims ?? [claim()],summary:'The claim needs verification.'});
const parse = (value,source=answer) => run('parseReview(raw,{mode:"verify_claims",answer:source})',{
  raw:typeof value==='string'?value:JSON.stringify(value),source,
});

test('verify_claims prompt uses the requested contract and preserves selected input exactly',()=>{
  const prompt=run('buildReviewPrompt(sample,[0],{mode:"verify_claims"})',{sample});
  const payload=JSON.parse(prompt.split('\nINPUT DATA\n')[1]);
  assert.equal(payload.answer_to_review,answer);
  assert.deepEqual(payload.earlier_messages,[sample.history[0]]);
  assert.ok(!prompt.includes('OMITTED CONTEXT'));
  assert.match(prompt,/exact, nonempty, contiguous substring/);
  assert.match(prompt,/Preserve every character/);
  assert.match(prompt,/Do not invent sources, URLs/);
  assert.match(prompt,/Use unverified when unsure/);
  assert.match(prompt,/sources: \[\]/);
  assert.match(prompt,/without supplied or retrieved evidence, label claims unverified/);
  assert.match(prompt,/untrusted material/);
  assert.match(prompt,/Do not output confidence percentages/);
  const schema=run('getReviewResponseSchema("verify_claims")');
  assert.deepEqual(Object.keys(schema.properties).sort(),['claims','summary']);
  assert.deepEqual([...schema.properties.claims.items.required].sort(),['explanation','id','quote','sources','verdict']);
  assert.equal(schema.additionalProperties,false);
  assert.equal(schema.properties.claims.items.additionalProperties,false);
});

test('prompt validation rejects invalid contexts, selections, and unknown modes',()=>{
  assert.throws(()=>run('buildReviewPrompt(sample,[9],{mode:"verify_claims"})'));
  assert.throws(()=>run('buildReviewPrompt(sample,[0,0],{mode:"verify_claims"})'));
  assert.throws(()=>run('buildReviewPrompt({...sample,reply:""},[],{mode:"verify_claims"})'));
  assert.throws(()=>run('buildReviewPrompt(sample,[],{mode:"other"})'));
  assert.throws(()=>run('getReviewResponseSchema("other")'));
  assert.equal(run('parseReview("{}",{mode:"other"})'),null);
});

test('valid claim labels and URL arrays round-trip without altering quotes or explanations',()=>{
  const value=review([
    claim({verdict:'supported',sources:['https://example.org/evidence']}),
    claim({id:'claim-2',quote:'Sydney is the largest city.',verdict:'contradicted',
      explanation:'Synthetic evidence conflicts with this assertion.',sources:['http://example.org/conflict']}),
    claim({id:'claim-3',sources:['https://example.org/inconclusive']}),
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(parse(value))),value);
  assert.ok(parse('```json\n'+JSON.stringify(value)+'\n```'));
  assert.ok(parse(review([]),'I prefer the blue design.'));
});

test('quotes must come from the answer verbatim, not the question, context, or a paraphrase',()=>{
  for(const quote of ['Canberra is Australia’s capital.','canberra is the capital of Australia.',
    'Canberra  is the capital of Australia.','Canberra is the capital... Sydney is the largest city.',
    sample.question,'INCLUDED CONTEXT','', '   ']) {
    assert.equal(parse(review([claim({quote})])),null,JSON.stringify(quote));
  }
  assert.equal(run('parseReview(raw,{mode:"verify_claims"})',{raw:JSON.stringify(review())}),null);
  assert.equal(parse(review(),''),null);
  assert.equal(parse(review(),null),null);
});

test('JSON escapes, Unicode, line breaks, repeated quotes, and overlaps retain exact substring semantics',()=>{
  const source='She said "hello".\nCafé 😀 is open. Café 😀 is open.';
  const values=review([
    claim({quote:'She said "hello".\nCafé 😀 is open.'}),
    claim({id:'claim-2',quote:'Café 😀 is open.'}),
    claim({id:'claim-3',quote:'Café 😀 is open.'}),
    claim({id:'claim-4',quote:'😀'}),
  ]);
  const parsed=parse(values,source);assert.ok(parsed);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)),values);
  assert.equal(parse(review([claim({quote:'She said "hello". Café 😀 is open.'})]),source),null);
  assert.equal(parse(review([claim({quote:'Cafe\u0301'})]),source),null);
  for(const quote of ['\ud83d','\ude00'])assert.equal(parse(review([claim({quote})]),source),null);
});

test('duplicate IDs, wrong shapes, unsupported labels, missing fields, and empty explanations fail closed',()=>{
  assert.equal(parse(review([claim(),claim()])),null);
  for(const overrides of [{id:''},{id:'  '},{id:' claim-1 '},{id:1},{verdict:'correct'},
    {explanation:''},{explanation:'   '},{explanation:null},{sources:null},{sources:'https://example.org'},
    {quote:5},{confidence:0.99},{span:{start:0,end:1}}]) {
    assert.equal(parse(review([claim(overrides)])),null,JSON.stringify(overrides));
  }
  for(const field of ['id','quote','verdict','explanation','sources']){
    const item=claim();delete item[field];assert.equal(parse(review([item])),null,field);
  }
  for(const value of [null,[],{}, {claims:[]},{summary:'text'},{claims:{},summary:'text'},
    {claims:[null],summary:'text'}, {claims:[],summary:''},{claims:[],summary:' '},
    {claims:[],summary:4},{claims:[],summary:'text',verdict:'correct'}])assert.equal(parse(value),null);
  for(const raw of ['not JSON','{"claims":[','Here is the review: {}'])assert.equal(parse(raw),null);
});

test('unsupported evidence must stay unverified, and source links must be safe HTTP(S) URLs',()=>{
  for(const verdict of ['supported','contradicted'])assert.equal(parse(review([claim({verdict})])),null);
  for(const url of ['javascript:alert(1)','data:text/html,test','file:///tmp/example','ftp://example.org',
    '/relative','//example.org','https://','https://user:password@example.org','https://example.org/with space',
    'https://example.org/\npath','https:\\example.org',' https://example.org','https://example.org\\path']) {
    assert.equal(parse(review([claim({sources:[url]})])),null,url);
  }
  assert.equal(parse(review([claim({sources:[7]})])),null);
  assert.equal(parse(review([claim({sources:['https://example.org','https://example.org']})])),null);
  assert.ok(parse(review([claim({sources:['https://example.org/path?name=two%20words#section']})])));
  // A syntactically valid URL is not proof of real evidence. Grounding is a later integration.
});

test('bounded outputs reject oversized responses and arrays without silently truncating claims',()=>{
  assert.ok(parse(review(Array.from({length:50},(_,i)=>claim({id:String(i)})))));
  assert.equal(parse(review(Array.from({length:51},(_,i)=>claim({id:String(i)})))),null);
  assert.ok(parse(review([claim({sources:Array.from({length:10},(_,i)=>`https://example.org/${i}`)})])));
  assert.equal(parse(review([claim({sources:Array.from({length:11},(_,i)=>`https://example.org/${i}`)})])),null);
  for(const overrides of [{id:'a'.repeat(129)},{explanation:'a'.repeat(4001)},
    {sources:['https://example.org/'+ 'a'.repeat(4096)]}])assert.equal(parse(review([claim(overrides)])),null);
  assert.equal(parse({...review(),summary:'a'.repeat(2001)}),null);
  assert.equal(parse(' '.repeat(80001)),null);
  assert.equal(parse(review(),'a'.repeat(8001)),null);
});

test('ordinary review mode and existing callers keep the v1 prompt, schema, and output',()=>{
  const original={verdict:'correct',summary:'A sound answer.',issues:[],missing_points:[],strengths:['Clear.']};
  const prompt=run('buildReviewPrompt(sample,[])',{sample});
  assert.match(prompt,/careful, skeptical reviewer/);assert.ok(!prompt.includes('factual-claim verifier'));
  assert.equal(run('getReviewResponseSchema() === REVIEW_RESPONSE_SCHEMA'),true);
  assert.equal(run('getReviewResponseSchema("review") === REVIEW_RESPONSE_SCHEMA'),true);
  assert.deepEqual(JSON.parse(JSON.stringify(run('parseReview(raw)',{raw:JSON.stringify(original)}))),original);
  assert.equal(run('parseReview(raw)',{raw:JSON.stringify(review())}),null);
  assert.equal(parse(original),null);
});
