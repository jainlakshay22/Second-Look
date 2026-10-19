const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root=path.resolve(__dirname,'..');
async function fixture(saved={}) {
  const storage={apiKey:'fake-key',...saved},elements=new Map(),writes=[],messages=[];
  const ctx=vm.createContext({setTimeout,clearTimeout,
    document:{querySelector(selector) {
      if(!elements.has(selector))elements.set(selector,{value:'',checked:false,dataset:{},listeners:{},
        addEventListener(name,fn){this.listeners[name]=fn;},reportValidity:()=>true});
      return elements.get(selector);
    }},
    chrome:{storage:{local:{
      get:async defaults=>({...defaults,...storage}),
      setAccessLevel:async()=>{},
      set:async changes=>{writes.push({...changes});Object.assign(storage,changes);},
      remove:async key=>{delete storage[key];},
    }},runtime:{sendMessage:async message=>{messages.push(message);return {ok:true};}}},
  });
  for(const file of ['selectors.js','src/shared/settings.js','src/options/options.js'])
    vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),ctx);
  await new Promise(resolve=>setImmediate(resolve));
  const selectors=vm.runInContext('SETTINGS_SELECTORS',ctx);
  const fields=Object.fromEntries(Object.entries(selectors).map(([name,selector])=>[name,elements.get(selector)]));
  return {fields,storage,writes,messages,submit:()=>fields.form.listeners.submit({preventDefault(){}})};
}
test('grounding defaults off and only saved boolean true checks the toggle',async()=>{
  for(const value of [undefined,false,'true',true]) {
    const f=await fixture(value===undefined?{}:{groundingEnabled:value});
    assert.equal(f.fields.groundingEnabled.checked,value===true);
    assert.equal(f.writes.length,0);assert.equal(f.messages.length,0);
  }
});
test('grounding toggle persists on and off, preserving the saved key without sending a request',async()=>{
  const f=await fixture();
  for(const enabled of [true,false]) {
    f.fields.groundingEnabled.checked=enabled;
    await f.submit();
    assert.equal(f.storage.groundingEnabled,enabled);
    assert.equal(f.storage.apiKey,'fake-key');
    assert.equal(f.fields.apiKey.value,'');
  }
  assert.equal(f.messages.length,0);
  const reloaded=await fixture(f.storage);
  assert.equal(reloaded.fields.groundingEnabled.checked,false);
});
test('connection test remains the small test message even with grounding enabled',async()=>{
  const f=await fixture({groundingEnabled:true});
  await f.fields.testConnection.listeners.click();
  assert.equal(f.messages.length,1);
  assert.deepEqual(Object.keys(f.messages[0]),['type']);
  assert.equal(f.messages[0].type,'TEST_GEMINI_CONNECTION');
});
