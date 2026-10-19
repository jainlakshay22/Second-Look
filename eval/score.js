#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {loadCases,loadRuntime}=require('./run-eval.js');

function occurrences(answer,quote) {
  const spans=[];
  for(let start=answer.indexOf(quote); start!==-1; start=answer.indexOf(quote,start+1)) spans.push({start,end:start+quote.length});
  return spans;
}

function matchPrediction(item,prediction) {
  if (typeof prediction.quote !== 'string' || !prediction.quote.length) return [];
  const spans=occurrences(item.answer,prediction.quote);
  const matches=[];
  item.ground_truth.claims.forEach((gold,index)=>{
    const anchors=[{start:gold.start,end:gold.end},...gold.accepted_quotes.flatMap(quote=>occurrences(item.answer,quote))];
    // Containment is deliberately conservative: no normalization, fuzzy search,
    // model-generated ID matching, or substring-overlap-only matching.
    if (spans.some(span=>anchors.some(anchor=>(span.start<=anchor.start && span.end>=anchor.end)
      || (anchor.start<=span.start && anchor.end>=span.end)))) matches.push(index);
  });
  return matches;
}

function scoreResults(fixture,results) {
  if (results.version!==1 || results.fixtureSha256!==fixture.sha256 || !Array.isArray(results.cases)) {
    throw new Error('Result format or fixture hash mismatch. Use the original cases.json or rerun the evaluation.');
  }
  const known=new Set(fixture.cases.map(item=>item.id)), records=new Map();
  for(const record of results.cases) {
    if (!known.has(record.id) || records.has(record.id) || !['ok','error','cancelled','not_run'].includes(record.status)) throw new Error('Unknown, duplicate, or invalid result case.');
    records.set(record.id,record);
  }
  const {parseReview}=loadRuntime();
  const totals={wrong:0,correct:0,caught:0,falseAlarms:0,covered:0,omitted:0,unverified:0,
    correctUnverified:0,wrongSupported:0,unmatchedPredictions:0,ambiguousPredictions:0,conflicts:0,
    failedCases:0,notRun:0,invalidOutputs:0};
  const rows=[];
  for(const item of fixture.cases) {
    const record=records.get(item.id), gold=item.ground_truth.claims;
    const assigned=gold.map(()=>new Set());
    let status=record?.status || 'not_run';
    if (status==='ok') {
      const review=parseReview(JSON.stringify(record.result?.review),{mode:'verify_claims',answer:item.answer});
      const sources=record.result?.grounding?.sources;
      if (!review || !Array.isArray(sources) || !review.claims.every(claim=>claim.sources.every(url=>sources.includes(url)))) {
        status='invalid';totals.invalidOutputs++;
      } else for(const prediction of review.claims) {
        const matches=matchPrediction(item,prediction);
        if (!matches.length) totals.unmatchedPredictions++;
        else if (matches.length>1) totals.ambiguousPredictions++;
        else assigned[matches[0]].add(prediction.verdict);
      }
    }
    if (status==='not_run') totals.notRun++;
    else if (status!=='ok') totals.failedCases++;
    const row={id:item.id,status,wrong:0,correct:0,caught:0,falseAlarms:0,omitted:0,unverified:0};
    gold.forEach((claim,index)=>{
      const labels=assigned[index];
      const truth=claim.is_wrong?'wrong':'correct';totals[truth]++;row[truth]++;
      if (!labels.size) {totals.omitted++;row.omitted++;return;}
      totals.covered++;
      if (labels.size>1) totals.conflicts++;
      // Any contradiction counts, but each gold claim contributes at most once.
      if (labels.has('contradicted')) {
        const metric=claim.is_wrong?'caught':'falseAlarms'; totals[metric]++;row[metric]++;
      } else if (labels.has('supported')) {
        if (claim.is_wrong) totals.wrongSupported++;
      } else {totals.unverified++;row.unverified++;if (!claim.is_wrong) totals.correctUnverified++;}
    });
    rows.push(row);
  }
  return {totals,rows};
}
const ratio=(count,total)=>total ? `${count}/${total} (${(100*count/total).toFixed(1)}%)` : 'N/A';
const cell=value=>String(value??'').replace(/[|\r\n<>]/g,' ');
function markdownReport(fixture,results) {
  const {totals:t,rows}=scoreResults(fixture,results);
  const lines=[`Model: ${cell(results.model)} · Started: ${cell(results.startedAt)} · Run: ${cell(results.status)}`,
    `Fixture version: ${fixture.version} · Grounding: ${results.groundingEnabled ? 'on':'off'}`,''];
  if (t.failedCases || t.notRun) lines.push('**Incomplete/failed run:** missing and failed cases count as omissions. These are not complete-run performance estimates.','');
  lines.push('| Metric | Result |','| --- | ---: |',
    `| Catch rate (wrong claims contradicted) | ${ratio(t.caught,t.wrong)} |`,
    `| False-alarm rate (correct claims contradicted) | ${ratio(t.falseAlarms,t.correct)} |`,
    `| Extraction coverage | ${ratio(t.covered,t.wrong+t.correct)} |`,
    `| Omitted gold claims | ${t.omitted} |`,`| Unverified gold claims | ${t.unverified} |`,
    `| Correct claims marked unverified | ${t.correctUnverified} |`,`| Wrong claims marked supported | ${t.wrongSupported} |`,
    `| Unmatched / ambiguous predictions | ${t.unmatchedPredictions} / ${t.ambiguousPredictions} |`,
    `| Gold claims with conflicting predictions | ${t.conflicts} |`,
    `| Failed cases / not run | ${t.failedCases} / ${t.notRun} |`,`| Invalid review/source outputs | ${t.invalidOutputs} |`,'',
    '| Case | Status | Errors caught | False alarms | Unverified | Omitted |',
    '| --- | --- | ---: | ---: | ---: | ---: |');
  for(const row of rows) lines.push(`| ${cell(row.id)} | ${row.status} | ${ratio(row.caught,row.wrong)} | ${ratio(row.falseAlarms,row.correct)} | ${row.unverified} | ${row.omitted} |`);
  return lines.join('\n')+'\n';
}
if (require.main===module) {
  try {
    const fixture=loadCases();
    const results=JSON.parse(fs.readFileSync(path.join(__dirname,'results.json'),'utf8'));
    console.log(markdownReport(fixture,results));
  } catch(error) {
    console.error(error.code==='ENOENT' ? 'No eval/results.json found. Run node eval/run-eval.js first.' : 'Could not score results. Check the JSON, fixture hash, and case IDs.');
    process.exitCode=1;
  }
}
module.exports={scoreResults,matchPrediction,markdownReport};
