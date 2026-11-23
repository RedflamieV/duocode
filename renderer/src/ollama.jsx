import { useEffect, useState } from 'preact/hooks';

export function OllamaSettings({ settings, onSaved }) {
  const current = settings.ollama;
  const [models, setModels] = useState([]);
  const [engine, setEngine] = useState(current.engine || 'ollama');
  const [route, setRoute] = useState(current.route || 'direct');
  const [gguf, setGGUF] = useState(current.engine === 'llama.cpp' ? current.model : '');
  const [tag, setModel] = useState(current.engine === 'llama.cpp' ? '' : current.model);
  const model = engine === 'llama.cpp' ? gguf : tag;
  const [temperature, setTemperature] = useState(current.temperature);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function refresh() {
    try {
      const names = await window.duo.ollamaModels();
      setModels(names);
      setModel(previous => previous || names[0] || '');
      setError(names.length ? '' : 'Нет установленных моделей. Скачайте модель через ollama pull.');
    } catch (err) { setError(err.message); }
  }
  useEffect(() => { if (engine === 'ollama') refresh(); }, [engine]);
  async function save(enabled) {
    setBusy(true);
    setError('');
    try {
      await window.duo.setSettings({ ollama: { enabled, engine, route, model, temperature: Number(temperature) } });
      await onSaved();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <fieldset class="field" disabled={busy}>
    <legend>Локальная модель</legend>
    <label>Движок <select value={engine} onChange={e => { setEngine(e.target.value); setError(''); }}>
      <option value="ollama">Ollama</option><option value="llama.cpp">llama.cpp</option>
    </select></label>
    <label>Режим чата <select value={route} onChange={e => setRoute(e.target.value)}>
      <option value="direct">Напрямую</option><option value="claude">Claude Code с инструментами MCP</option>
    </select></label>
    {route === 'claude' && <p class="field-hint">Нужны установленный Claude Code и модель с поддержкой вызова инструментов.</p>}
    <label><input type="checkbox"  checked={current.enabled} disabled={!model && !current.enabled}
      onChange={() => save(!current.enabled)} /> Загружать локальную модель</label>
    {engine === 'llama.cpp' ? <>
      <label>Файл GGUF <input value={gguf} onInput={e => setGGUF(e.target.value)} /></label>
      <button class="btn small" onClick={async () => { const file = await window.duo.pickGGUF(); if (file) setGGUF(file); }}>Выбрать файл…</button>
      <p class="field-hint">{route === 'claude' ? 'Установите llama-server с поддержкой Anthropic Messages и добавьте его в PATH.' : 'Для запуска установите Python 3.8+ и пакет llama-cpp-python.'}</p>
    </> : <><label>Модель <select value={model} onChange={e => setModel(e.target.value)}>
      {[...new Set([model, ...models])].filter(Boolean).map(name => <option key={name} value={name}>{name}</option>)}
    </select></label>
    <button class="btn small" onClick={refresh}>Обновить список</button></>}
    {route === 'direct' && <label>Температура <input type="number" min="0" max="2" step="0.1" value={temperature}
      onInput={e => setTemperature(e.target.value)} /></label>}
    <button class="btn small" disabled={!model || temperature === '' || (route === (current.route || 'direct') && engine === (current.engine || 'ollama') && model === current.model && Number(temperature) === current.temperature)}
      onClick={() => save(current.enabled)}>Применить</button>
    {busy && <p role="status">Применяю настройки модели…</p>}
    {error && <p role="alert">{error}</p>}
  </fieldset>;
}
