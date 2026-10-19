#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createHash} = require('node:crypto');
const {setTimeout: delay} = require('node:timers/promises');
const ROOT = path.resolve(__dirname, '..');
const hash = text => createHash('sha256').update(text).digest('hex');

function loadCases(file = path.join(__dirname, 'cases.json')) {
  const raw = fs.readFileSync(file, 'utf8');
  const fixture = JSON.parse(raw);
  if (fixture.version !== 1 || !Array.isArray(fixture.cases) || fixture.cases.length !== 25) {
    throw new Error('Expected fixture version 1 with exactly 25 cases.');
  }
  const ids = new Set();
  for (const item of fixture.cases) {
    if (typeof item.id !== 'string' || !item.id || ids.has(item.id)
        || typeof item.category !== 'string' || typeof item.question !== 'string' || !item.question.trim()
        || typeof item.answer !== 'string' || !item.answer.trim() || item.answer.length > 8000
        || !Array.isArray(item.ground_truth?.claims) || !item.ground_truth.claims.length) {
      throw new Error('Invalid evaluation case.');
    }
    ids.add(item.id);
    const claimIds = new Set();
    for (const claim of item.ground_truth.claims) {
      if (typeof claim.id !== 'string' || !claim.id || claimIds.has(claim.id)
          || typeof claim.is_wrong !== 'boolean' || typeof claim.explanation !== 'string' || !claim.explanation
          || typeof claim.quote !== 'string' || !claim.quote.trim()
          || !Number.isInteger(claim.start) || !Number.isInteger(claim.end) || claim.start < 0
          || claim.end <= claim.start || claim.end > item.answer.length
          || item.answer.slice(claim.start,claim.end) !== claim.quote
          || !Array.isArray(claim.accepted_quotes)
          || !claim.accepted_quotes.every(quote => typeof quote === 'string' && quote.trim() && item.answer.includes(quote))) {
        throw new Error('Invalid ground-truth claim or anchor.');
      }
      claimIds.add(claim.id);
    }
  }
  return {...fixture, sha256: hash(raw)};
}

// Load the actual extension code, rather than maintaining a second prompt/client.
// Only repository code executes in the VM; fixture answers are ordinary data.
function loadRuntime({apiKey = '', model, grounding = true, fetchImpl = globalThis.fetch} = {}) {
  const files = ['src/shared/settings.js','src/shared/review.js','src/background/gemini.js'];
  const sources = files.map(file => fs.readFileSync(path.join(ROOT,file),'utf8'));
  const context = vm.createContext({URL,AbortController,TextDecoder,setTimeout,clearTimeout,
    fetch: fetchImpl,
    chrome: {storage: {local: {get: async defaults => ({...defaults, provider:'google', apiKey,
      ...(model ? {model} : {}), groundingEnabled:grounding})}}},
  });
  sources.forEach((source,index) => vm.runInContext(source,context,{filename:files[index]}));
  const api = vm.runInContext('({generateGeminiReview,parseReview,isValidGeminiModel,model:SETTINGS_DEFAULTS.model})',context);
  return {...api, sourceHashes:Object.fromEntries(files.map((file,index) => [file,hash(sources[index])]))};
}

function saveResults(file, value) {
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value,null,2)+'\n', {mode:0o600});
  fs.renameSync(temporary,file);
}

async function runEvaluation({fixture, runtime, model, grounding, output, intervalMs = 4000,
  signal, log = console.log, httpStatus = () => undefined}) {
  const results = {version:1,fixtureVersion:fixture.version,fixtureSha256:fixture.sha256,
    sourceHashes:runtime.sourceHashes,model,mode:'verify_claims',groundingEnabled:grounding,
    startedAt:new Date().toISOString(),finishedAt:null,status:'running',
    cases:fixture.cases.map(item => ({id:item.id,status:'not_run'}))};
  saveResults(output,results);
  for (let index=0; index<fixture.cases.length; index++) {
    if (signal?.aborted) {results.status='interrupted'; break;}
    if (index && intervalMs) {
      try {await delay(intervalMs,undefined,{signal});}
      catch {results.status='interrupted'; break;}
    }
    const item = fixture.cases[index], record=results.cases[index], started=Date.now();
    log(`[${index+1}/${fixture.cases.length}] ${item.id}`);
    try {
      // Never send ground truth, annotations, IDs, explanations, or expected labels.
      const result = await runtime.generateGeminiReview({source:'chatgpt.com',question:item.question,
        reply:item.answer,history:[]},[],{mode:'verify_claims',groundingEnabled:grounding,
        maxOutputTokens:8192,headerTimeout:90000,signal});
      record.status='ok'; record.result=result;
    } catch {
      // No raw exceptions, provider messages, headers, or environment values persist.
      record.status=signal?.aborted ? 'cancelled' : 'error';
      const status=httpStatus();
      if (Number.isInteger(status) && status >= 400 && status <= 599) record.httpStatus=status;
      record.error=signal?.aborted ? 'Run interrupted.' : status === 429 ? 'Rate limit or quota reached.'
        : status >= 400 ? 'Provider request failed.' : 'No valid review returned (validation, timeout, or network failure).';
      if (signal?.aborted) results.status='interrupted';
      else if ([400,401,403,404,429].includes(status)) results.status='stopped';
      log(`${item.id}: ${record.error}`);
    }
    record.durationMs=Date.now()-started;
    saveResults(output,results);
    if (results.status !== 'running') break;
  }
  if (results.status === 'running') results.status=results.cases.every(item=>item.status==='ok') ? 'complete' : 'complete_with_errors';
  results.finishedAt=new Date().toISOString();
  saveResults(output,results);
  return results;
}

async function main() {
  if (!process.env.GEMINI_API_KEY?.trim()) throw new Error('Set GEMINI_API_KEY in your environment first.');
  if (process.argv.length > 2) throw new Error('No command-line arguments are needed. See eval/README.md for environment options.');
  const groundingValue=process.env.EVAL_GROUNDING ?? 'true';
  if (!['true','false'].includes(groundingValue)) throw new Error('EVAL_GROUNDING must be true or false.');
  const grounding=groundingValue==='true';
  const intervalMs=Number(process.env.EVAL_DELAY_MS ?? 4000);
  if (!Number.isInteger(intervalMs) || intervalMs<0 || intervalMs>60000) throw new Error('EVAL_DELAY_MS must be an integer from 0 to 60000.');
  let lastHttpStatus;
  const runtime=loadRuntime({apiKey:process.env.GEMINI_API_KEY.trim(),model:process.env.GEMINI_MODEL,grounding,
    fetchImpl:async (...args)=>{
      lastHttpStatus=undefined;
      const response=await fetch(...args); lastHttpStatus=response.status; return response;
    }});
  const model=process.env.GEMINI_MODEL || runtime.model;
  if (!runtime.isValidGeminiModel(model)) throw new Error('GEMINI_MODEL must be a valid Gemini model ID.');
  if (grounding && !/^gemini-[34][.-]/.test(model)) throw new Error('This client requires a Gemini 3 or 4 model for structured output with Search.');
  const controller=new AbortController(), interrupt=()=>controller.abort();
  process.on('SIGINT',interrupt);
  try {
    const result=await runEvaluation({fixture:loadCases(),runtime,model,grounding,intervalMs,
      output:path.join(__dirname,'results.json'),signal:controller.signal,httpStatus:()=>lastHttpStatus});
    console.log(`Saved eval/results.json (${result.status}). Run node eval/score.js to score it.`);
    if (result.status !== 'complete') process.exitCode=1;
  } finally {process.removeListener('SIGINT',interrupt);}
}
if (require.main === module) main().catch(error=>{
  // Only known configuration errors are printable; never print unexpected stacks.
  const safe=/^(Set GEMINI_API_KEY|No command-line|EVAL_|GEMINI_MODEL|This client requires)/.test(error.message);
  console.error(safe ? error.message : 'Evaluation could not start or save results. Check the fixture and file permissions.');
  process.exitCode=1;
});
module.exports={loadCases,loadRuntime,runEvaluation,saveResults};
