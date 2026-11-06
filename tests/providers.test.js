const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mergeProviders, publicProviders, saveProviders, loadProviders, claudeOptions, assertProviderChanges, canPersistKeys } = require('../src/providers');

const profile = (patch = {}) => ({
  id: 'glm', name: 'GLM', baseUrl: 'https://api.z.ai/api/anthropic',
  apiKey: 'test-provider-secret', authType: 'token', models: ['glm-test', 'glm-fast'], defaultModel: 'glm-test', ...patch,
});

test('editing a profile preserves its key unless explicitly replaced or removed', () => {
  const original = profile();
  const visible = publicProviders([original]);
  assert.equal(visible[0].apiKey, undefined);
  assert.equal(visible[0].hasApiKey, true);
  assert(!JSON.stringify(visible).includes('test-provider-secret'));
  const renamed = mergeProviders([{ ...visible[0], name: 'Работа' }], [original]);
  assert.equal(renamed[0].apiKey, 'test-provider-secret');
  assert.equal(mergeProviders([{ ...visible[0], apiKey: 'replacement' }], [original])[0].apiKey, 'replacement');
  assert.equal(mergeProviders([{ ...visible[0], apiKey: '' }], [original])[0].apiKey, '');
  assert.equal(original.name, 'GLM');
});

test('profile secrets are sealed on disk and unavailable encryption never writes plaintext', () => {
  const sealed = saveProviders([profile()], (value) => Buffer.from(value).toString('base64'));
  assert(!JSON.stringify(sealed).includes('test-provider-secret'));
  assert.equal(sealed[0].apiKey, undefined);
  assert.equal(loadProviders(sealed, (value) => Buffer.from(value, 'base64').toString())[0].apiKey, 'test-provider-secret');
  const temporary = saveProviders([profile()], () => null);
  assert(!JSON.stringify(temporary).includes('test-provider-secret'));
  assert.equal(loadProviders(temporary, () => '')[0].apiKey, '');
});

test('Linux basic_text backend is treated as unavailable secure storage', () => {
  assert.equal(canPersistKeys({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' }), false);
  assert.equal(canPersistKeys({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret' }), true);
  assert.equal(canPersistKeys({ isEncryptionAvailable: () => true }), true);
  assert.equal(canPersistKeys({ isEncryptionAvailable: () => false }), false);
});

test('a temporarily locked keyring preserves ciphertext through saves and profile edits', () => {
  const stored = saveProviders([profile()], (value) => Buffer.from(value).toString('base64'));
  const locked = loadProviders(stored, () => '');
  assert.equal(locked[0].apiKey, '');
  const edited = mergeProviders([{ ...publicProviders(locked)[0], name: 'Renamed' }], locked);
  const saved = saveProviders(edited, () => null);
  assert.equal(saved[0].apiKeySealed, stored[0].apiKeySealed);
  assert.equal(publicProviders(edited)[0].apiKeySealed, undefined);
  const reopened = loadProviders(saved, (value) => Buffer.from(value, 'base64').toString());
  assert.equal(reopened[0].apiKey, 'test-provider-secret');
  const removed = mergeProviders([{ ...publicProviders(locked)[0], apiKey: '' }], locked);
  assert.equal(saveProviders(removed, () => null)[0].apiKeySealed, undefined);
});

test('invalid addresses, duplicate IDs and invalid model lists are rejected', () => {
  for (const baseUrl of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:secret@example.com', 'https://api.example.com?key=secret', '']) {
    assert.throws(() => mergeProviders([profile({ baseUrl })], []), /адрес|URL/i);
  }
  assert.throws(() => mergeProviders([profile(), profile()], []), /идентификатор/i);
  assert.throws(() => mergeProviders([profile({ models: [] })], []), /модел/i);
  assert.throws(() => mergeProviders([profile({ defaultModel: 'absent' })], []), /модел/i);
  assert.throws(() => mergeProviders([profile({ authType: 'oauth' })], []), /авторизац/i);
  const local = mergeProviders([profile({ baseUrl: 'http://localhost:8080/v1/' })], []);
  assert.equal(local[0].baseUrl, 'http://localhost:8080/v1');
});

test('native Claude keeps existing model, effort and login configuration', () => {
  const options = claudeOptions({}, { claudeModel: 'opus', claudeEffort: 'high' });
  assert.equal(options.providerId, '');
  assert.equal(options.model, 'opus');
  assert.equal(options.effort, 'high');
  assert.deepEqual(options.env, {});
  assert.deepEqual(options.settings, {});
  assert.equal(options.sessionKey, '');
});

test('a custom provider overrides conflicting credentials and all internal model aliases', () => {
  const options = claudeOptions({ providers: [profile()] }, { claudeProvider: 'glm', claudeModel: 'glm-fast', claudeEffort: 'max' });
  assert.equal(options.providerId, 'glm');
  assert.equal(options.model, 'glm-fast');
  assert.equal(options.effort, '');
  assert.equal(options.env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');
  assert.equal(options.env.ANTHROPIC_AUTH_TOKEN, 'test-provider-secret');
  for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_CUSTOM_HEADERS']) assert.equal(options.env[name], '');
  for (const name of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) assert.equal(options.env[name], 'glm-fast');
  assert.deepEqual(options.settings.env, options.env);
  assert.equal(options.settings.apiKeyHelper, '');
  assert(!options.sessionKey.includes('test-provider-secret'));
  const keyed = claudeOptions({ providers: [profile({ authType: 'apiKey', supportsEffort: true })] }, { claudeProvider: 'glm', claudeEffort: 'high' });
  assert.equal(keyed.env.ANTHROPIC_API_KEY, 'test-provider-secret');
  assert.equal(keyed.env.ANTHROPIC_AUTH_TOKEN, '');
  assert.equal(keyed.effort, 'high');
});

test('missing profiles, keys and unsupported models fail instead of using Anthropic', () => {
  assert.throws(() => claudeOptions({}, { claudeProvider: 'removed' }), /профиль/i);
  assert.throws(() => claudeOptions({ providers: [profile({ apiKey: '' })] }, { claudeProvider: 'glm' }), /ключ/i);
  assert.throws(() => claudeOptions({ providers: [profile()] }, { claudeProvider: 'glm', claudeModel: 'opus' }), /модел/i);
});

test('editing or removing a profile used by a running agent is rejected', () => {
  const previous = [profile()];
  const runs = [{ agent: 'claude', msg: { providerId: 'glm' } }];
  assert.throws(() => assertProviderChanges(previous, [profile({ baseUrl: 'https://other.example.com' })], runs), /заверш|останов/i);
  assert.throws(() => assertProviderChanges(previous, [], runs), /заверш|останов/i);
  assert.doesNotThrow(() => assertProviderChanges(previous, [profile(), profile({ id: 'another' })], runs));
});
