const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

function fixture({model = 'gemini-3.8-flash', behavior = 'success'} = {}) {
  const requests = [];
  const timers = new Set();
  const context = vm.createContext({
    AbortController,
    chrome: {storage: {local: {get: async () => ({provider: 'google', model, apiKey: 'fake-test-credential'})}}},
    setTimeout(fn, milliseconds) {
      assert.equal(milliseconds, 25000);
      const timer = setTimeout(fn, 5);
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) {timers.delete(timer); clearTimeout(timer);},
    async fetch(url, options) {
      requests.push({url, options});
      const pending = () => new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('private network detail')));
      });
      if (behavior === 'header-timeout') return pending();
      if (behavior === 'network-error') throw new Error('private network detail');
      return {
        ok: true,
        json: async () => {
          if (behavior === 'body-timeout') return pending();
          if (behavior === 'invalid-json') throw new Error('private response detail');
          return {candidates: [{finishReason: 'STOP', content: {parts: [{thought: true, text: 'ignore'}, {text: 'OK'}]}}]};
        },
      };
    },
  });
  for (const file of ['src/shared/settings.js', 'src/background/gemini.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  }
  return {requests, timers, run: expression => vm.runInContext(expression, context)};
}

test('connection test lowers thinking only for supported models and keeps credentials out of the URL/body', async () => {
  for (const model of ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-4-argon', 'gemini-2.5-flash']) {
    const f = fixture({model});
    assert.equal(await f.run('generateGeminiText("Reply with exactly OK.", {maxOutputTokens:1024, connectionTest:true})'), 'OK');
    const {url, options} = f.requests[0];
    const body = JSON.parse(options.body);
    assert.deepEqual(body.generationConfig.thinkingConfig, model.startsWith('gemini-2.') ? undefined
      : {thinkingLevel: model === 'gemini-3.5-flash-lite' ? 'MINIMAL' : 'LOW'});
    assert.equal(body.generationConfig.maxOutputTokens, 1024);
    assert.equal(options.headers['x-goog-api-key'], 'fake-test-credential');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.ok(!url.includes('fake-test-credential'));
    assert.ok(!options.body.includes('fake-test-credential'));
    assert.equal(f.timers.size, 0);
  }
});

test('normal generation keeps the model default reasoning', async () => {
  const f = fixture();
  await f.run('generateGeminiText("Review this sample")');
  assert.deepEqual(JSON.parse(f.requests[0].options.body).generationConfig, {maxOutputTokens: 4096});
});

for (const [behavior, expected] of [
  ['header-timeout', /No response from Google within 25 seconds/],
  ['body-timeout', /Google responded, but the response did not finish within 25 seconds/],
  ['network-error', /Could not reach Gemini/],
  ['invalid-json', /unreadable response/],
]) {
  test(behavior + ' is accurately classified without leaking details', async () => {
    const f = fixture({behavior});
    await assert.rejects(f.run('generateGeminiText("test")'), error => {
      assert.match(error.message, expected);
      assert.ok(!error.message.includes('private'));
      return true;
    });
    assert.equal(f.timers.size, 0);
  });
}
