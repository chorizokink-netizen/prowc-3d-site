// Lightweight entry: reads config + URL params, shows the poster and loads the heavy 3D code
// only when the viewer scrolls into view (IntersectionObserver works inside iframes too).
const $ = (id) => document.getElementById(id);
const app = $('app');

export function showError(text, retry) {
  app.classList.remove('is-loading');
  $('loader').hidden = true;
  $('error-text').textContent = text;
  $('error').hidden = false;
  const btn = $('error-retry');
  btn.hidden = !retry;
  btn.onclick = retry ? () => { $('error').hidden = true; retry(); } : null;
}

const MSG_CONFIG = 'Не удалось загрузить настройки просмотра. Проверьте подключение к интернету и обновите страницу.';
const MSG_CODE = 'Не удалось запустить 3D-просмотр. Обновите страницу или откройте её в другом браузере.';

function readParams(cfg) {
  const p = new URLSearchParams(location.search);
  const pick = (v, list, def) => (list.includes(v) ? v : def);
  const ids = cfg.modules.map((m) => m.id);
  const fin = (cfg.finishes || []).map((f) => f.id);
  const hasLocation = !!(cfg.backgrounds && cfg.backgrounds.location && cfg.backgrounds.location.file);
  return {
    module: pick((p.get('module') || '').toUpperCase(), ids, ids.includes(cfg.defaultModule) ? cfg.defaultModule : ids[0]),
    finish: pick((p.get('finish') || '').toUpperCase(), fin, cfg.defaultFinish || fin[0]),
    ui: pick(p.get('ui'), ['full', 'min', 'none'], 'full'),
    bg: pick(p.get('bg'), hasLocation ? ['studio', 'location'] : ['studio'], 'studio'),
    view: pick(p.get('view'), ['outside', 'top', 'door'], 'outside'),
    preview: p.get('preview') === '1',
  };
}

async function main() {
  let cfg;
  try {
    const r = await fetch('config.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    cfg = await r.json();
    if (!Array.isArray(cfg.modules) || !cfg.modules.length) throw new Error('no modules');
  } catch (e) {
    console.warn('config', e);
    showError(MSG_CONFIG, main);
    return;
  }
  const state = readParams(cfg);
  if (state.ui === 'none') app.classList.add('ui-none');
  const mod = cfg.modules.find((m) => m.id === state.module);
  if (cfg.title) document.title = cfg.title;
  const bg = cfg.backgrounds && cfg.backgrounds.studio && cfg.backgrounds.studio.color;
  if (bg) document.documentElement.style.setProperty('--bg', bg);
  if (mod.poster) {
    const poster = $('poster');
    poster.onerror = () => poster.removeAttribute('src');
    poster.src = mod.poster;
  }

  let started = false;
  const start = async () => {
    if (started) return;
    started = true;
    io && io.disconnect();
    app.classList.remove('is-idle');
    app.classList.add('is-loading');
    $('loader').hidden = false;
    try {
      const { startViewer } = await import('./viewer.js');
      await startViewer(cfg, state, { showError });
    } catch (e) {
      console.error(e);
      started = false;
      showError(MSG_CODE, start);
    }
  };
  let io = null;
  if ('IntersectionObserver' in window) {
    io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) start(); }, { rootMargin: '200px 0px' });
    io.observe(app);
  } else start();
}

main();
