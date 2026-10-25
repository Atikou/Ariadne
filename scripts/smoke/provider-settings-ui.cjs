module.exports = async ({ evaluate, wait, check }) => {
  await evaluate("localStorage.setItem('ariadne.settings.category.v1','agent'); window.__uiFixture.show('provider-settings')");
  await wait("document.querySelectorAll('.provider-disclosure').length === 4");
  await evaluate("document.querySelectorAll('.provider-disclosure')[1].click()");
  await wait("!!document.querySelector('.provider-settings-card.is-expanded .provider-check-button')");
  await check('exact integer token capacities including the collapsed 200000-token provider are valid', "document.querySelector('form').checkValidity()");
  await check('remote health uses the configured model identity', "document.querySelector('.provider-settings-card.is-expanded .provider-health').textContent.includes('模型可用')");
  await evaluate("document.querySelector('.provider-settings-card.is-expanded .provider-check-button').click()");
  await wait("document.querySelector('.provider-check-result')?.textContent.includes('检测通过')");
  await check('single-provider check dispatches the saved model instead of cloud-provider alias', "JSON.stringify(window.__providerSettingsFixture.checks) === JSON.stringify(['configured-deepseek'])");
  await evaluate(`(() => {
    const input=document.querySelector('.provider-settings-card.is-expanded input[aria-label="模型名称"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'custom-deepseek-model');
    input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  await evaluate("document.querySelector('.provider-settings-card.is-expanded .provider-check-button').click()");
  await wait("document.querySelector('.provider-check-result')?.textContent.includes('请先保存')");
  await check('unsaved model changes cannot check or disable the old binding', 'window.__providerSettingsFixture.checks.length === 1 && window.__providerSettingsFixture.writes.length === 0');
  await evaluate("document.querySelector('.settings-floating-actions button').click()");
  await wait('window.__providerSettingsFixture.writes.length === 1');
  await evaluate("document.querySelector('.provider-settings-card.is-expanded .provider-check-button').click()");
  await wait('window.__providerSettingsFixture.checks.length === 2');
  await check('changing the API model preserves the connection identity', "window.__providerSettingsFixture.checks[1] === 'configured-deepseek'");
  await evaluate("window.__providerSettingsFixture.unavailable.push('configured-openai'); document.querySelector('.provider-list-heading button').click()");
  await wait("document.querySelector('.provider-check-result')?.textContent.includes('1 个可用，1 个已关闭')");
  await check('bulk checks use both saved model IDs and disable only the failed provider', `(() => {
    const f=window.__providerSettingsFixture;
    return JSON.stringify(f.checks.slice(2).sort()) === JSON.stringify(['configured-deepseek','configured-openai'])
      && !document.querySelector('[aria-label="启用 OpenAI"]').checked
      && document.querySelector('[aria-label="启用 DeepSeek"]').checked;
  })()`);
  await evaluate("document.querySelector('.provider-settings-list .local-model-root-add').click()");
  await wait("document.querySelectorAll('.provider-settings-card').length === 5");
  await evaluate(`(() => {
    const card=[...document.querySelectorAll('.provider-settings-card')].at(-1);
    for (const [name,value] of [['连接名称','备用连接'],['API 地址','https://backup.example/v1'],['模型名称','custom-deepseek-model'],['API Key','fixture-only-secret']]) {
      const input=card.querySelector('input[aria-label="'+name+'"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);
      input.dispatchEvent(new Event('input',{bubbles:true}));
    }
  })()`);
  await evaluate("document.querySelector('.settings-floating-actions button').click()");
  await wait("window.__providerSettingsFixture.writes.some(r=>r.operations.some(o=>o.kind==='provider.add'))");
  await check('new connection stores independent endpoint key and model', `(() => {
    const op=window.__providerSettingsFixture.writes.flatMap(r=>r.operations).find(o=>o.kind==='provider.add');
    return op.provider.model==='custom-deepseek-model' && op.provider.modelId!== 'configured-deepseek'
      && op.provider.baseUrl==='https://backup.example/v1' && op.apiKey==='fixture-only-secret';
  })()`);
  await evaluate("[...document.querySelectorAll('.provider-settings-card')].at(-1).querySelector('.provider-check-button').click()");
  await wait('window.__providerSettingsFixture.checks.length === 5');
  await evaluate("[...document.querySelectorAll('.provider-settings-card')].at(-1).querySelector('.provider-settings-body > button').click()");
  await evaluate("document.querySelector('.settings-floating-actions button').click()");
  await wait("window.__providerSettingsFixture.writes.some(r=>r.operations.some(o=>o.kind==='provider.remove'))");
  await check('deleting one connection retains the other connection with the same API model', "document.querySelectorAll('.provider-settings-card').length === 4 && document.querySelector('[data-provider-id=deepseek] input[aria-label=模型名称]').value === 'custom-deepseek-model'");
};
