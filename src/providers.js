// Профили Anthropic-совместимых API для движка Claude Code.
// Каталог и формы используют этот модуль; только главный процесс получает apiKey.
const NATIVE_MODELS = [
  { id: '', name: 'По умолчанию', description: 'Модель из настроек Claude Code' },
  { id: 'opus', name: 'Opus', description: 'Для сложных задач' },
  { id: 'sonnet', name: 'Sonnet', description: 'На каждый день' },
  { id: 'haiku', name: 'Haiku', description: 'Быстрая и экономная' },
];

const GLM_TEMPLATE = {
  name: 'GLM · Z.ai', baseUrl: 'https://api.z.ai/api/anthropic', authType: 'token',
  models: ['glm-5.3', 'glm-5.3-flash'], defaultModel: 'glm-5.3', supportsEffort: false,
};

function canPersistKeys(storage) {
  return storage.isEncryptionAvailable() && (!storage.getSelectedStorageBackend || storage.getSelectedStorageBackend() !== 'basic_text');
}

function publicProviders(providers = []) {
  return providers.map(({ apiKey, apiKeySealed, hasApiKey, ...p }) => ({ ...p, hasApiKey: !!apiKey }));
}

function mergeProviders(next, previous = []) {
  if (!Array.isArray(next) || next.length > 50) throw new Error('Список профилей должен содержать не более 50 записей');
  const ids = new Set();
  return next.map((input) => {
    if (!input || typeof input !== 'object') throw new Error('Некорректный профиль');
    const { id } = input;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id) || ids.has(id)) throw new Error('Некорректный или повторяющийся идентификатор профиля');
    ids.add(id);
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, 80) : '';
    if (!name) throw new Error('Укажите название профиля');
    let url;
    try { url = new URL(input.baseUrl); } catch { throw new Error('Укажите полный адрес API (URL)'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Адрес API должен быть HTTP(S) URL без пароля, параметров и фрагмента');
    if (!['token', 'apiKey'].includes(input.authType)) throw new Error('Неизвестный способ авторизации');
    if (!Array.isArray(input.models) || !input.models.length || input.models.length > 100 || input.models.some((m) => typeof m !== 'string' || !m.trim() || m.length > 200 || /[\r\n\x00]/.test(m))) throw new Error('Укажите список моделей (не более 100)');
    const models = [...new Set(input.models.map((m) => m.trim()))];
    const defaultModel = input.defaultModel || models[0];
    if (!models.includes(defaultModel)) throw new Error('Модель по умолчанию должна быть в списке моделей');
    const old = previous.find((p) => p.id === id);
    if ('apiKey' in input && (typeof input.apiKey !== 'string' || /[\r\n\x00]/.test(input.apiKey))) throw new Error('Некорректный API-ключ');
    const apiKey = 'apiKey' in input ? input.apiKey.trim() : (old && old.apiKey) || '';
    return { id, name, baseUrl: url.href.replace(/\/+$/, ''), authType: input.authType, models, defaultModel, supportsEffort: input.supportsEffort === true, apiKey,
      ...(!('apiKey' in input) && old && old.apiKeySealed ? { apiKeySealed: old.apiKeySealed } : {}),
    };
  });
}

function saveProviders(providers = [], seal) {
  return providers.map(({ apiKey, apiKeySealed, hasApiKey, ...p }) => {
    const sealed = (apiKey && seal(apiKey)) || apiKeySealed;
    return { ...p, ...(sealed ? { apiKeySealed: sealed } : {}) };
  });
}

function loadProviders(providers = [], open) {
  return mergeProviders(providers).map((p, index) => {
    const apiKeySealed = providers[index].apiKeySealed;
    return { ...p, apiKey: apiKeySealed ? open(apiKeySealed) || '' : '', ...(apiKeySealed ? { apiKeySealed } : {}) };
  });
}

function assertProviderChanges(previous, next, runs) {
  for (const run of runs) {
    const id = run.agent === 'claude' && run.msg.providerId;
    if (!id) continue;
    if (JSON.stringify(previous.find((p) => p.id === id)) !== JSON.stringify(next.find((p) => p.id === id))) {
      throw new Error('Дождитесь завершения Claude Code или остановите его перед изменением используемого профиля');
    }
  }
}

function providerModels(providers = [], id = '') {
  if (!id) return NATIVE_MODELS;
  const p = providers.find((x) => x.id === id);
  return p ? [
    { id: '', name: 'По умолчанию', description: p.defaultModel },
    ...p.models.map((model) => ({ id: model, name: model })),
  ] : [{ id: '', name: 'Профиль удалён', description: 'Выберите другой профиль' }];
}

function claudeOptions(settings, chosen = {}) {
  const providerId = chosen.claudeProvider || '';
  if (!providerId) return { providerId: '', providerName: 'Claude', model: chosen.claudeModel || '', effort: chosen.claudeEffort || '', env: {}, settings: {}, sessionKey: '' };
  const p = (settings.providers || []).find((x) => x.id === providerId);
  if (!p) throw new Error('Профиль модели удалён. Выберите другой профиль в шапке чата');
  if (!p.apiKey) throw new Error(`У профиля «${p.name}» нет API-ключа. Добавьте его в Настройки → Агенты`);
  const model = chosen.claudeModel || p.defaultModel;
  if (!p.models.includes(model)) throw new Error(`Модель «${model}» отсутствует в профиле «${p.name}». Выберите модель заново`);
  const env = {
    ANTHROPIC_BASE_URL: p.baseUrl,
    ANTHROPIC_AUTH_TOKEN: p.authType === 'token' ? p.apiKey : '',
    ANTHROPIC_API_KEY: p.authType === 'apiKey' ? p.apiKey : '',
    CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '', CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '',
    CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_USE_VERTEX: '', CLAUDE_CODE_USE_FOUNDRY: '',
    ANTHROPIC_CUSTOM_HEADERS: '',
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model, CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  return {
    providerId, providerName: p.name, model, effort: p.supportsEffort ? chosen.claudeEffort || '' : '', env,
    settings: { env, model, apiKeyHelper: '' },
    sessionKey: JSON.stringify([p.id, p.baseUrl, p.authType]),
  };
}

module.exports = { GLM_TEMPLATE, NATIVE_MODELS, publicProviders, mergeProviders, saveProviders, loadProviders, providerModels, claudeOptions, assertProviderChanges, canPersistKeys };
