const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root,'src/sidepanel/claims.js'),'utf8');
const pure = vm.createContext({}); vm.runInContext(source,pure);
const match = (answer, quotes) => {
  pure.answer=answer; pure.claims=quotes.map(quote=>({quote}));
  return JSON.parse(vm.runInContext('JSON.stringify(matchClaimQuotes(answer,claims))',pure));
};
function assertCoverage(answer, quotes, result) {
  assert.equal(result.segments.map(s=>answer.slice(s.start,s.end)).join(''),answer);
  for (let i=0;i<result.segments.length;i++) {
    const segment=result.segments[i];
    assert.equal(segment.start,i ? result.segments[i-1].end : 0);
    assert.ok(segment.end > segment.start);
    for (const index of segment.claimIndices) assert.ok(quotes[index].includes(answer.slice(segment.start,segment.end)));
  }
}

test('exact matching preserves punctuation, whitespace, Unicode, and literal HTML',()=>{
  const answer='<b>Café 😀</b>\n  next';
  const quotes=['Café 😀','\n  next','café 😀','next '];
  const result=match(answer,quotes);
  assert.deepEqual(result.unmatched,[2,3]);
  assert.deepEqual(result.segments.filter(s=>s.claimIndices.length),[
    {start:3,end:10,claimIndices:[0]}, {start:14,end:21,claimIndices:[1]},
  ]);
  assertCoverage(answer,quotes,result);
});

test('partially overlapping claims share a segment and neither is dropped',()=>{
  const answer='abcdef',quotes=['abcd','cdef'];
  const result=match(answer,quotes);
  assert.deepEqual(result,{segments:[
    {start:0,end:2,claimIndices:[0]}, {start:2,end:4,claimIndices:[0,1]}, {start:4,end:6,claimIndices:[1]},
  ],unmatched:[]});
  assertCoverage(answer,quotes,result);
});

test('nested, duplicate, and adjacent quotes keep their independent claim indices',()=>{
  const answer='abcdef!',quotes=['abcdef','bc','bc','!'];
  const result=match(answer,quotes);
  assert.deepEqual(result.segments,[
    {start:0,end:1,claimIndices:[0]}, {start:1,end:3,claimIndices:[0,1,2]},
    {start:3,end:6,claimIndices:[0]}, {start:6,end:7,claimIndices:[3]},
  ]);
  assertCoverage(answer,quotes,result);
});

test('all repeated matches, including self-overlapping occurrences, remain highlighted',()=>{
  const answer='aaaa a',quotes=['aa','a'];
  const result=match(answer,quotes);
  for(const segment of result.segments) {
    assert.deepEqual(segment.claimIndices,segment.start<4?[0,1]:segment.start===4?[]:[1]);
  }
  assertCoverage(answer,quotes,result);
});

test('missing, empty, malformed, and split-surrogate quotes are listed without invented matches',()=>{
  const answer='😀 a',quotes=['absent','',null,'\ud83d','\ude00','😀'];
  const result=match(answer,quotes);
  assert.deepEqual(result.unmatched,[0,1,2,3,4]);
  assert.deepEqual(result.segments[0],{start:0,end:2,claimIndices:[5]});
  assertCoverage(answer,quotes,result);
  assert.deepEqual(match('', ['missing','']),{segments:[],unmatched:[0,1]});
  assert.deepEqual(match('plain',[]),{segments:[{start:0,end:5,claimIndices:[]}],unmatched:[]});
});

// Minimal DOM with a deliberate tripwire: rendering model content as HTML fails.
class Node {
  constructor(tag='#text',text='') {this.tag=tag;this.children=[];this.value=text;this.dataset={};this.attributes={};this.listeners={};}
  set innerHTML(_) {throw new Error('Unsafe HTML insertion');}
  set textContent(value) {this.value=String(value??'');this.children=[];}
  get textContent() {return this.value+this.children.map(child=>child.textContent).join('');}
  append(...nodes) {this.children.push(...nodes);}
  replaceChildren(...nodes) {this.value='';this.children=nodes;}
  setAttribute(name,value) {this.attributes[name]=value;}
  addEventListener(name,listener) {this.listeners[name]=listener;}
  focus() {this.focused=true;}
}
function fixture() {
  const fields=new Map();
  const ctx=vm.createContext({URL,
    document:{createElement:tag=>new Node(tag),createTextNode:text=>new Node('#text',text),
      querySelector(selector) {if(!fields.has(selector)) fields.set(selector,new Node('section'));return fields.get(selector);}},
  });
  vm.runInContext(source,ctx);
  return {ctx,fields,render(answer,claims) {
    ctx.parent=new Node('section'); ctx.answer=answer;ctx.result={claims,summary:'Summary <script>example</script>'};
    vm.runInContext('renderClaimResult(parent,answer,result)',ctx);
    return ctx.parent;
  }};
}
const nodes = node => [node,...node.children.flatMap(nodes)];
const byClass = (root,name) => nodes(root).filter(node=>(node.className||'').split(' ').includes(name));
const claim=(quote,verdict='supported',sources=[])=>({id:quote,quote,verdict,explanation:'Reason <img src=x onerror=alert(1)>',sources});

test('safe answer rendering colors each verdict and click exposes explanation and safe source links',()=>{
  const f=fixture(),answer='<img src=x onerror=alert(1)> supports? uncertain.';
  const root=f.render(answer,[
    claim('<img src=x onerror=alert(1)>','contradicted',['https://example.com/evidence','javascript:alert(1)',
      'data:text/html,<script>x</script>','https://user:pass@example.com/','https://example.com/\\evil']),
    claim('supports?','supported'),claim('uncertain.','unverified'),
  ]);
  const copy=byClass(root,'claim-answer')[0],buttons=byClass(root,'claim-highlight');
  assert.equal(copy.textContent,answer);
  assert.deepEqual(buttons.map(b=>b.dataset.verdict),['contradicted','supported','unverified']);
  assert.ok(nodes(root).every(n=>!['img','script'].includes(n.tag)));
  const details=byClass(root,'claim-details')[0];assert.equal(details.hidden,true);
  buttons[0].listeners.click();assert.equal(details.hidden,false);
  assert.match(details.textContent,/Reason <img/);
  const links=nodes(details).filter(n=>n.tag==='a');
  assert.equal(links.length,1);assert.equal(links[0].href,'https://example.com/evidence');
  assert.equal(links[0].rel,'noopener noreferrer');assert.equal(links[0].target,'_blank');
  assert.equal(buttons[0].attributes['aria-pressed'],'true');
  assert.equal(buttons[0].attributes['aria-controls'],details.id);
  buttons[1].listeners.click();assert.equal(buttons[0].attributes['aria-pressed'],'false');
  assert.match(details.textContent,/No sources available/);
  nodes(details).find(n=>n.tag==='button').listeners.click();
  assert.equal(details.hidden,true);assert.equal(buttons[1].focused,true);
});

test('clicking a shared highlight exposes every overlapping claim with its verdict',()=>{
  const root=fixture().render('abcdef',[claim('abcd'),claim('cdef','contradicted')]);
  const shared=byClass(root,'claim-highlight').find(n=>n.textContent==='cd');
  assert.equal(shared.dataset.verdict,'contradicted');
  assert.match(shared.attributes['aria-label'],/Claim 1: supported; Claim 2: contradicted/);
  shared.listeners.click();
  const cards=byClass(byClass(root,'claim-details')[0],'claim-card');
  assert.equal(cards.length,2);
  assert.match(cards[0].textContent,/Claim 1 · supported/);assert.match(cards[1].textContent,/Claim 2 · contradicted/);
});

test('unmatched claims remain below the answer with explanations and links',()=>{
  const root=fixture().render('Original answer',[claim('missing quote','unverified',['https://example.org/source'])]);
  assert.equal(byClass(root,'claim-highlight').length,0);
  assert.equal(byClass(root,'claim-answer')[0].textContent,'Original answer');
  const fallback=byClass(root,'unmatched-claims')[0];
  assert.match(fallback.textContent,/could not be matched exactly/);
  assert.match(fallback.textContent,/missing quote/);assert.match(fallback.textContent,/Reason <img/);
  assert.equal(nodes(fallback).find(n=>n.tag==='a').href,'https://example.org/source');
});

test('side panel routes claim results to the renderer and replaces stale highlights',async()=>{
  const f=fixture();
  Object.assign(f.ctx,{setInterval:()=>1,clearInterval(){},window:{addEventListener(){}},
    chrome:{storage:{onChanged:{addListener(){}}},runtime:{sendMessage:async()=>({review:null})}}});
  for(const file of ['selectors.js','src/sidepanel/sidepanel.js'])vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),f.ctx);
  await new Promise(resolve=>setImmediate(resolve));
  f.ctx.review={id:'test',phase:'done',context:{reply:'Exact answer'},result:{summary:'Summary',claims:[claim('Exact')]}};
  vm.runInContext('render(review)',f.ctx);
  const result=f.fields.get('#result');
  assert.equal(byClass(result,'claim-highlight').length,1);
  f.ctx.review={...f.ctx.review,id:'new',context:{reply:'New answer'},result:{summary:'No claims',claims:[]}};
  vm.runInContext('render(review)',f.ctx);
  assert.equal(byClass(result,'claim-highlight').length,0);
  assert.equal(byClass(result,'claim-answer')[0].textContent,'New answer');
  assert.match(result.textContent,/No factual claims were extracted/);
});
