// Offsets refer to the original answer's UTF-16 code units. Never normalize it.
// Split at every boundary so overlapping claims share a highlight without losing
// either claim. Repeated exact quotes highlight every occurrence, including overlaps.
function matchClaimQuotes(answer, claims) {
  const boundaries = new Map([[0, {start: [], end: []}], [answer.length, {start: [], end: []}]]);
  const unmatched = [];
  const boundary = offset => {
    if (!boundaries.has(offset)) boundaries.set(offset, {start: [], end: []});
    return boundaries.get(offset);
  };
  const splitsSurrogate = offset => offset > 0 && offset < answer.length
    && /[\uD800-\uDBFF]/.test(answer[offset - 1]) && /[\uDC00-\uDFFF]/.test(answer[offset]);
  claims.forEach((claim, index) => {
    const quote = claim?.quote;
    let found = false;
    if (typeof quote === 'string' && quote.length > 0) {
      for (let start = answer.indexOf(quote); start !== -1; start = answer.indexOf(quote, start + 1)) {
        const end = start + quote.length;
        if (splitsSurrogate(start) || splitsSurrogate(end)) continue;
        boundary(start).start.push(index);
        boundary(end).end.push(index);
        found = true;
      }
    }
    if (!found) unmatched.push(index);
  });
  const offsets = [...boundaries.keys()].sort((a,b) => a-b);
  const active = new Map(), segments = [];
  for (let i = 0; i < offsets.length - 1; i++) {
    const start = offsets[i], end = offsets[i + 1], changes = boundaries.get(start);
    // Counts preserve a claim whose repeated occurrences overlap each other.
    for (const index of changes.end) {
      const count = active.get(index) - 1;
      if (count) active.set(index, count); else active.delete(index);
    }
    for (const index of changes.start) active.set(index, (active.get(index) || 0) + 1);
    segments.push({start, end, claimIndices: [...active.keys()].sort((a,b) => a-b)});
  }
  return {segments, unmatched};
}

function renderClaimResult(parent, answer, result) {
  const text = (container, tag, value, className) => {
    const node = document.createElement(tag);
    node.textContent = value;
    if (className) node.className = className;
    container.append(node);
    return node;
  };
  const verdictOf = claim => ['supported','contradicted','unverified'].includes(claim.verdict) ? claim.verdict : 'unverified';
  const safeSource = value => {
    if (typeof value !== 'string' || value.length > 4096 || !/^https?:\/\//.test(value)
        || /[\s\u0000-\u001f\u007f\\]/.test(value)) return false;
    try {
      const url = new URL(value);
      return ['http:','https:'].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password;
    } catch { return false; }
  };
  function claimCard(container, claim, index) {
    const card = document.createElement('article'); card.className = 'claim-card';
    card.dataset.verdict = verdictOf(claim);
    text(card, 'h4', `Claim ${index + 1} · ${verdictOf(claim)}`);
    text(card, 'blockquote', claim.quote);
    text(card, 'p', claim.explanation);
    const sources = [...new Set((claim.sources || []).filter(safeSource))];
    if (sources.length) {
      const list = document.createElement('ul'); list.className = 'claim-sources';
      for (const url of sources) {
        const item = document.createElement('li');
        const link = text(item, 'a', url);
        link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        list.append(item);
      }
      card.append(list);
    } else text(card, 'p', 'No sources available.', 'empty-note');
    container.append(card);
  }
  const section = document.createElement('section'); section.className = 'review-section claim-review';
  text(section, 'h2', 'Claim verification');
  text(section, 'p', result.summary, 'review-summary');
  const legend = document.createElement('p'); legend.className = 'claim-legend';
  for (const verdict of ['supported','contradicted','unverified']) {
    text(legend, 'span', verdict, 'claim-label').dataset.verdict = verdict;
  }
  section.append(legend);
  text(section, 'p', 'Click a highlight to read its claims and sources. Unverified means uncertain, not incorrect. Shared highlights show all overlapping claims; their color uses contradicted, then unverified, then supported. Repeated quotes are highlighted at every exact match.', 'help');
  text(section, 'h3', 'Answer reviewed');
  const copy = document.createElement('div'); copy.className = 'claim-answer';
  const details = document.createElement('section'); details.className = 'claim-details';
  details.id = 'claim-details'; details.hidden = true; details.setAttribute('aria-live', 'polite');
  const buttons = [];
  const {segments, unmatched} = matchClaimQuotes(answer, result.claims);
  for (const segment of segments) {
    const quote = answer.slice(segment.start, segment.end);
    if (!segment.claimIndices.length) { copy.append(document.createTextNode(quote)); continue; }
    const button = text(copy, 'button', quote, 'claim-highlight'); button.type = 'button';
    const verdicts = segment.claimIndices.map(index => verdictOf(result.claims[index]));
    button.dataset.verdict = ['contradicted','unverified','supported'].find(value => verdicts.includes(value));
    button.title = segment.claimIndices.map(index => `Claim ${index + 1}: ${verdictOf(result.claims[index])}`).join('; ');
    button.setAttribute('aria-label', `${quote} — ${button.title}. Show explanation and sources.`);
    button.setAttribute('aria-controls', details.id);
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => {
      for (const item of buttons) item.setAttribute('aria-pressed', String(item === button));
      details.replaceChildren(); details.hidden = false;
      text(details, 'h3', segment.claimIndices.length > 1 ? 'Claims in this highlight' : 'Claim details');
      for (const index of segment.claimIndices) claimCard(details, result.claims[index], index);
      const close = text(details, 'button', 'Close claim details', 'secondary'); close.type = 'button';
      close.addEventListener('click', () => {
        details.hidden = true; button.setAttribute('aria-pressed', 'false'); button.focus();
      });
    });
    buttons.push(button);
  }
  section.append(copy, details);
  if (!result.claims.length) text(section, 'p', 'No factual claims were extracted.', 'empty-note');
  if (unmatched.length) {
    const fallback = document.createElement('section'); fallback.className = 'unmatched-claims';
    text(fallback, 'h3', `Claims not located in the answer · ${unmatched.length}`);
    text(fallback, 'p', 'These quotes could not be matched exactly. Their reviews are shown here without a highlight.', 'help');
    for (const index of unmatched) claimCard(fallback, result.claims[index], index);
    section.append(fallback);
  }
  parent.append(section);
}
