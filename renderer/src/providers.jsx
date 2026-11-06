import { createContext } from 'preact';
import { useState } from 'preact/hooks';
import { GLM_TEMPLATE, mergeProviders } from '../../src/providers.js';

export const ProvidersContext = createContext([]);

// Ключ уже сохранённого профиля сюда не приходит: пустое поле сохраняет прежний ключ.
export function ProviderSettings({ settings, onSaved }) {
  const profiles = settings.providers || [];
  const [draft, setDraft] = useState(null);
  const [key, setKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const edit = (p) => {
    setDraft({ ...p, modelsText: p.models.join('\n') });
    setKey(''); setClearKey(false); setError('');
  };
  const add = (glm) => edit({
    id: crypto.randomUUID(),
    ...(glm ? GLM_TEMPLATE : { name: '', baseUrl: '', authType: 'token', models: [], defaultModel: '', supportsEffort: false }),
  });
  const change = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const save = async (event) => {
    event.preventDefault();
    setError(''); setSaving(true);
    try {
      const { modelsText, hasApiKey, ...fields } = draft;
      const models = modelsText.split(/\r?\n/).map((m) => m.trim()).filter(Boolean);
      const profile = { ...fields, models, defaultModel: fields.defaultModel || models[0] || '', ...(key.trim() ? { apiKey: key.trim() } : clearKey ? { apiKey: '' } : {}) };
      const next = profiles.some((p) => p.id === profile.id) ? profiles.map((p) => p.id === profile.id ? profile : p) : [...profiles, profile];
      mergeProviders(next); // только проверка формы; существующий ключ сохраняет главный процесс
      await window.duo.setSettings({ providers: next });
      setDraft(null); setKey(''); onSaved();
    } catch (err) {
      setError(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally { setSaving(false); }
  };
  const remove = async (p) => {
    if (!confirm(`Удалить профиль «${p.name}»? В его чатах потребуется выбрать другой профиль.`)) return;
    try {
      await window.duo.setSettings({ providers: profiles.filter((x) => x.id !== p.id) });
      if (draft && draft.id === p.id) setDraft(null);
      onSaved();
    } catch (err) { setError(String(err.message || err)); }
  };
  return (
    <section class="provider-settings">
      <h3>Другие модели через Claude Code</h3>
      <p class="field-hint">Подключите GLM или другой Anthropic-совместимый API. Команды, правки и вызовы Codex выполняет установленный Claude Code. Для своего API-профиля вход в аккаунт Claude не нужен.</p>
      {profiles.map((p) => (
        <div class="provider-card" key={p.id}>
          <div><b>{p.name}</b><small>{p.baseUrl}</small><small>{p.models.join(', ')} · {p.hasApiKey ? 'Ключ задан' : 'Нужен API-ключ'}</small></div>
          <div class="provider-actions">
            <button class="btn small" onClick={() => edit(p)}>Изменить</button>
            <button class="btn small ghost" onClick={() => remove(p)}>Удалить</button>
          </div>
        </div>
      ))}
      {!draft && <div class="provider-actions"><button class="btn small" onClick={() => add(true)}>Добавить GLM · Z.ai</button><button class="btn small" onClick={() => add(false)}>Свой провайдер</button></div>}
      {draft && (
        <form class="provider-form" onSubmit={save}>
          <div class="field"><label for="provider-name">Название профиля</label><input id="provider-name" value={draft.name} onInput={(e) => change({ name: e.target.value })} placeholder="Например, GLM · рабочий" required maxLength={80} /></div>
          <div class="field"><label for="provider-url">Адрес API</label><input id="provider-url" type="url" value={draft.baseUrl} onInput={(e) => change({ baseUrl: e.target.value })} placeholder="https://api.example.com/anthropic" required spellcheck={false} /><div class="field-hint">Базовый адрес Anthropic Messages API, без /v1/messages. OpenAI Chat Completions напрямую не подходит.</div></div>
          <div class="field"><label for="provider-key">API-ключ</label><input id="provider-key" type="password" value={key} onInput={(e) => { setKey(e.target.value); setClearKey(false); }} autoComplete="new-password" placeholder={draft.hasApiKey && !clearKey ? 'Ключ сохранён. Пустое поле оставит его прежним' : 'Ключ провайдера'} spellcheck={false} />
            {draft.hasApiKey && <label class="provider-check"><input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} /> Удалить сохранённый ключ</label>}
            <div class="field-hint">{settings.providerKeyStorage ? 'Ключ сохраняется зашифрованным средствами системы.' : 'Системное шифрование недоступно: ключ действует до закрытия DuoCode и не сохраняется на диск.'} Ключ нужен от выбранного провайдера; подписка Claude его не оплачивает.</div>
          </div>
          <div class="field"><label for="provider-auth">Авторизация</label><select id="provider-auth" value={draft.authType} onChange={(e) => change({ authType: e.target.value })}><option value="token">Bearer token — GLM и большинство шлюзов</option><option value="apiKey">x-api-key</option></select></div>
          <div class="field"><label for="provider-models">Модели — по одной на строку</label><textarea id="provider-models" rows={3} value={draft.modelsText} onInput={(e) => {
            const modelsText = e.target.value;
            const models = modelsText.split(/\r?\n/).map((m) => m.trim());
            change({ modelsText, defaultModel: models.includes(draft.defaultModel) ? draft.defaultModel : '' });
          }} required spellcheck={false} /><div class="field-hint">Точные идентификаторы из кабинета провайдера. Шаблон GLM можно изменить под доступные вам модели.</div></div>
          <div class="field"><label for="provider-default">Модель по умолчанию</label><select id="provider-default" value={draft.defaultModel} onChange={(e) => change({ defaultModel: e.target.value })}><option value="">Первая в списке</option>{[...new Set(draft.modelsText.split(/\r?\n/).map((m) => m.trim()).filter(Boolean))].map((m) => <option key={m} value={m}>{m}</option>)}</select></div>
          <label class="provider-check"><input type="checkbox" checked={draft.supportsEffort} onChange={(e) => change({ supportsEffort: e.target.checked })} /> Провайдер поддерживает уровень размышлений Claude Code</label>
          <div class="provider-actions"><button class="btn" type="submit" disabled={saving}>{saving ? 'Сохранение…' : 'Сохранить профиль'}</button><button class="btn ghost" type="button" disabled={saving} onClick={() => { setDraft(null); setKey(''); setError(''); }}>Отмена</button></div>
        </form>
      )}
      {error && <p class="warn" role="alert">{error}</p>}
    </section>
  );
}
