(function () {
  'use strict';

  const CLASSIC_URL = 'https://script.google.com/macros/s/AKfycbwauG7QLQ8_6BHFnVjspBmtjN3UE30G7b8GChf4G-onTsmdefLtCOC6JJJXYiMY3IM/exec';
  const KEYS = { url: 'tally.apiUrl', token: 'tally.token', init: 'tally.init.v1' };
  const TOKEN_ERROR = 'El token no es válido. Revísalo en Conexión.';
  const OFFLINE_ERROR = 'Sin conexión. Revisa tu conexión e inténtalo de nuevo.';
  const WRITES = new Set([
    'guardar', 'editarMov', 'borrar', 'ajustarSaldo', 'activarTarjeta',
    'guardarAjustes', 'guardarTasa', 'resolverPendiente',
    'guardarMeta', 'borrarMeta', 'guardarRollover', 'activarResumen'
  ]);
  let dialog, indicator, freshData, connect;
  const connection = new Promise(resolve => { connect = resolve; });
  let firstInit = true;
  let revision = 0;
  let initRequest = 0;
  let pending = 0;
  let status = '';

  function stored(key) {
    try { return localStorage.getItem(key); }
    catch { return null; }
  }

  function serviceUrl(value, token) {
    let url;
    try { url = new URL(value); }
    catch { throw new Error('Escribe una URL del servicio válida.'); }
    const google = url.origin === 'https://script.google.com' &&
      /^\/macros\/s\/[\w-]+\/exec$/.test(url.pathname) && !url.search;
    const local = location.hostname === 'localhost' && url.protocol === 'http:' &&
      url.hostname === 'localhost' && url.pathname === '/api' && /^(\?lat=\d+)?$/.test(url.search);
    if ((!google && !local) || url.username || url.password || url.hash || (token && url.href.includes(token))) {
      throw new Error('Usa la URL /exec de Tally API. Pega el token en su propio campo.');
    }
    return url;
  }

  function savedConnection() {
    const token = stored(KEYS.token);
    if (!token) return null;
    try { return { url: serviceUrl(stored(KEYS.url), token), token }; }
    catch { return null; }
  }

  function setStatus(value) {
    status = value;
    if (!indicator) return;
    indicator.textContent = status;
    indicator.hidden = !status;
  }

  function clearInit() {
    revision++;
    freshData = null;
    setStatus('');
    localStorage.removeItem(KEYS.init);
  }

  async function request(url, options) {
    if (navigator.onLine === false) throw new Error(OFFLINE_ERROR);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch(url.href, {
        ...options, signal: controller.signal, credentials: 'omit',
        cache: 'no-store', referrerPolicy: 'no-referrer'
      });
      if (response.status === 401) throw new Error(TOKEN_ERROR);
      const data = await response.json();
      if (data && data.code === 'unauthorized') throw new Error(TOKEN_ERROR);
      if (!response.ok || !data || data.ok !== true) {
        throw new Error((data && data.error) || 'El servicio no pudo completar la solicitud.');
      }
      return data;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('El servicio tardó demasiado. Inténtalo de nuevo.');
      if (error instanceof SyntaxError) throw new Error('El servicio no devolvió datos de Tally. Revisa la URL en Conexión.');
      if (error instanceof TypeError) throw new Error(OFFLINE_ERROR);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function post(config, fn, args) {
    const data = await request(config.url, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ token: config.token, fn, args })
    });
    return data.result;
  }

  function cachedInit() {
    try {
      const entry = JSON.parse(stored(KEYS.init));
      if (entry && Number.isFinite(entry.date) && entry.data && entry.data.hoy) return entry;
    } catch {}
    return null;
  }

  function sameConnection(config) {
    return stored(KEYS.url) === config.url.href && stored(KEYS.token) === config.token;
  }

  function getInit(config, args) {
    const cached = firstInit ? cachedInit() : null;
    firstInit = false;
    const startedAt = revision;
    const attempt = ++initRequest;
    const current = () => startedAt === revision && attempt === initRequest && sameConnection(config);
    const fresh = post(config, 'getInit', args).then(data => {
      if (data && data.instalar) throw new Error('Configura tu cuenta en Tally clásica antes de conectar esta app.');
      if (!data || !data.hoy) throw new Error('El servicio devolvió datos incompletos de Tally.');
      if (current()) {
        try { localStorage.setItem(KEYS.init, JSON.stringify({ date: Date.now(), data })); }
        catch {} // La app puede seguir funcionando si se agotó el almacenamiento.
        setStatus('');
        freshData = cached ? data : null;
        if (cached) window.dispatchEvent(new CustomEvent('tally:fresh', { detail: data }));
      }
      return data;
    });
    if (!cached) return fresh;
    setStatus('Actualizando…');
    fresh.catch(() => {
      if (current()) {
        const time = new Date(cached.date).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });
        setStatus('Sin conexión · datos de ' + time);
      }
    });
    return cached.data;
  }

  async function call(fn, args) {
    const config = savedConnection() || await connection;
    pending++;
    try {
      if (fn === 'getInit') return await getInit(config, args);
      const result = await post(config, fn, args);
      if (WRITES.has(fn) && sameConnection(config)) {
        try { clearInit(); }
        catch {} // La escritura remota ya quedó confirmada.
      }
      return result;
    } finally {
      pending--;
    }
  }

  function runner(success, failure) {
    return new Proxy({}, {
      get(_, name) {
        if (name === 'withSuccessHandler') return handler => runner(handler, failure);
        if (name === 'withFailureHandler') return handler => runner(success, handler);
        return (...args) => { call(name, args).then(success, failure); };
      }
    });
  }

  function mount() {
    const style = document.createElement('style');
    style.textContent = `
      #tally-connection { box-sizing: border-box; width: min(calc(100% - 32px), 430px);
        max-height: calc(100% - 32px); overflow-y: auto; padding: var(--pad); margin: auto;
        border: 1px solid var(--card-edge); border-radius: var(--radius-sheet);
        background: var(--surface); color: var(--ink); box-shadow: var(--card-shadow); }
      #tally-connection::backdrop { background: var(--backdrop); }
      #tally-connection h2 { margin: 0 0 16px; font-size: 20px; font-weight: 600; }
      #tally-connection form, #tally-connection label { display: grid; gap: 8px; }
      #tally-connection form { gap: 12px; }
      #tally-connection label { color: var(--muted); font-size: 12px; font-weight: 600; }
      #tally-connection a { display: grid; place-items: center; min-height: 44px;
        color: var(--accent-text); font-weight: 500; text-align: center; }
      #settingsConnection { width: 100%; margin-top: 10px; }
      #tally-sync-status:not([hidden]) { position: fixed; z-index: 11; left: 50%;
        top: calc(env(safe-area-inset-top) + var(--top-height)); transform: translateX(-50%);
        padding: 4px 12px; border-radius: var(--radius-pill); background: var(--surface);
        color: var(--ink); box-shadow: var(--control-shadow); font-size: 12px; pointer-events: none; }
    `;
    document.head.append(style);
    indicator = document.createElement('div');
    indicator.id = 'tally-sync-status';
    indicator.setAttribute('role', 'status');
    setStatus(status);
    document.body.append(indicator);

    dialog = document.createElement('dialog');
    dialog.id = 'tally-connection';
    dialog.setAttribute('aria-labelledby', 'tally-connection-title');
    dialog.innerHTML = `
      <h2 id="tally-connection-title">Conexión</h2>
      <form>
        <label>URL del servicio
          <input class="text-input" name="url" type="url" required autocomplete="off" spellcheck="false">
        </label>
        <label>Token
          <input class="text-input" name="token" type="password" required autocomplete="off">
        </label>
        <div class="status error" role="status"></div>
        <button class="primary" type="submit">Conectar</button>
        <button class="secondary" type="button" data-dismiss hidden>Volver a Ajustes</button>
        <button class="secondary" type="button" data-disconnect hidden>Desconectar este teléfono</button>
        <a href="${CLASSIC_URL}">Abrir Tally clásica</a>
      </form>
    `;
    document.body.append(dialog);
    const form = dialog.querySelector('form');
    const message = dialog.querySelector('[role=status]');
    const submit = dialog.querySelector('[type=submit]');
    const dismiss = dialog.querySelector('[data-dismiss]');
    const disconnect = dialog.querySelector('[data-disconnect]');
    const button = document.getElementById('settingsConnection');

    function open(config) {
      message.textContent = '';
      form.elements.url.value = config ? config.url.href : '';
      form.elements.token.value = config ? config.token : '';
      dismiss.hidden = disconnect.hidden = !config;
      dialog.showModal();
    }

    dialog.addEventListener('cancel', event => {
      if (!savedConnection() || submit.disabled) event.preventDefault();
    });
    dismiss.addEventListener('click', () => dialog.close());
    disconnect.addEventListener('click', () => {
      clearInit();
      localStorage.removeItem(KEYS.token);
      localStorage.removeItem(KEYS.url);
      location.reload();
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const previous = savedConnection();
      submit.disabled = dismiss.disabled = disconnect.disabled = true;
      message.textContent = 'Comprobando conexión…';
      try {
        const token = form.elements.token.value.trim();
        if (!token) throw new Error('Escribe el token de Tally API.');
        const url = serviceUrl(form.elements.url.value.trim(), token);
        const health = new URL(url);
        health.searchParams.set('api', '1');
        if ((await request(health, { method: 'GET' })).app !== 'tally') {
          throw new Error('La URL no corresponde al servicio de Tally.');
        }
        await post({ url, token }, 'estadoCola', []);
        const changed = !sameConnection({ url, token });
        if (changed) {
          clearInit();
          localStorage.setItem(KEYS.url, url.href);
          localStorage.setItem(KEYS.token, token);
        }
        form.elements.token.value = '';
        if (previous && changed) location.reload();
        else {
          dialog.close();
          connect({ url, token });
        }
      } catch (error) {
        message.textContent = error.message;
      } finally {
        submit.disabled = dismiss.disabled = disconnect.disabled = false;
      }
    });
    button.addEventListener('click', () => open(savedConnection()));
    const retry = document.getElementById('retryBtn');
    const recover = button.cloneNode(true);
    recover.id = 'tally-recover-connection';
    recover.addEventListener('click', () => open(savedConnection()));
    retry.after(recover);
    dialog.addEventListener('close', () => { form.elements.token.value = ''; });
    const config = savedConnection();
    if (config) connect(config);
    else open(null);
  }

  function registerWorker() {
    if (!('serviceWorker' in navigator)) return;
    const workers = navigator.serviceWorker;
    let controller = workers.controller;
    let updating = false;
    function reloadWhenReady() {
      if (pending || document.querySelector('.sheet-layer:not([hidden]), dialog[open]')) {
        setTimeout(reloadWhenReady, 250);
      } else location.reload();
    }
    workers.addEventListener('controllerchange', () => {
      const previous = controller;
      controller = workers.controller;
      if (previous && controller && previous !== controller && !updating) {
        updating = true;
        reloadWhenReady();
      }
    });
    workers.register('./sw.js', { updateViaCache: 'none' })
      .then(registration => registration.update()).catch(() => {});
  }

  // Cortina local. La passkey no se envía a Apps Script.
  const lockKey = 'tally.lock.credentialId';
  let credentialId = stored(lockKey);
  let unlocked = !credentialId;
  let hiddenAt = null;
  let lockDialog, lockCheckbox, lockStatus, lockButton, lockMessage, unlockRequest;
  let lockSupport;
  const enabled = () => !!credentialId;
  const setCurtain = on => document.documentElement?.classList.toggle('tally-private', on);
  setCurtain(enabled());

  function paintLock() {
    const locked = enabled() && !unlocked;
    setCurtain(locked);
    if (lockCheckbox) lockCheckbox.checked = enabled();
    if (!lockDialog) return;
    if (locked && !lockDialog.open) lockDialog.showModal();
    if (!locked && lockDialog.open) lockDialog.close();
    window.dispatchEvent(new CustomEvent('tally:lock'));
  }

  async function supportsLock() {
    try {
      return !!(navigator.credentials && typeof PublicKeyCredential !== 'undefined' &&
        await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
    } catch { return false; }
  }

  function disableLock() {
    credentialId = null;
    unlocked = true;
    try { localStorage.removeItem(lockKey); } catch {}
    paintLock();
  }

  function challenge() { return crypto.getRandomValues(new Uint8Array(32)); }

  async function enableLock() {
    if (!await (lockSupport || supportsLock())) throw new Error('Este equipo no admite Face ID para Tally.');
    const credential = await navigator.credentials.create({
      publicKey: {
        challenge: challenge(),
        rp: { id: location.hostname, name: 'Tally' },
        user: { id: challenge(), name: 'tally', displayName: 'Tally' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
        attestation: 'none',
        timeout: 60000
      }
    });
    if (!credential?.rawId?.byteLength) throw new Error('No se creó la clave de acceso.');
    const id = btoa(String.fromCharCode(...new Uint8Array(credential.rawId)));
    localStorage.setItem(lockKey, id);
    credentialId = id;
    unlocked = true;
    paintLock();
  }

  function requestUnlock() {
    if (!enabled() || unlocked) return Promise.resolve(true);
    if (unlockRequest) return unlockRequest;
    const id = credentialId;
    unlockRequest = (async () => {
      if (lockButton) lockButton.disabled = true;
      if (lockMessage) lockMessage.textContent = '';
      try {
        if (!await (lockSupport || supportsLock())) {
          disableLock();
          if (lockStatus) lockStatus.textContent = 'El bloqueo se apagó porque Face ID no está disponible.';
          return false;
        }
        const credential = await navigator.credentials.get({
          publicKey: { challenge: challenge(), rpId: location.hostname, userVerification: 'required',
            allowCredentials: [{ id: Uint8Array.from(atob(id), c => c.charCodeAt(0)), type: 'public-key', transports: ['internal'] }],
            timeout: 60000 }
        });
        if (!credential?.rawId?.byteLength || btoa(String.fromCharCode(...new Uint8Array(credential.rawId))) !== id ||
            id !== credentialId) throw new Error('Credencial incorrecta');
        unlocked = true;
        paintLock();
        return true;
      } catch {
        if (lockMessage) lockMessage.textContent = 'No se pudo desbloquear. Intenta otra vez.';
        return false;
      } finally {
        if (lockButton) lockButton.disabled = false;
        unlockRequest = null;
      }
    })();
    return unlockRequest;
  }

  function mountLock() {
    const row = document.getElementById('settingsLockRow');
    lockCheckbox = document.getElementById('settingsLock');
    lockStatus = document.getElementById('settingsLockStatus');
    lockDialog = document.getElementById('tally-lock-screen');
    if (!lockDialog || !lockCheckbox || !row) return;
    lockSupport = supportsLock();
    lockButton = document.getElementById('tally-unlock');
    lockMessage = document.getElementById('tally-unlock-message');
    row.hidden = false;
    lockButton?.addEventListener('click', requestUnlock);
    lockDialog.addEventListener('cancel', event => event.preventDefault());
    lockDialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') event.stopPropagation();
    });
    lockCheckbox.addEventListener('change', async () => {
      lockStatus.textContent = '';
      if (!lockCheckbox.checked) { disableLock(); return; }
      lockCheckbox.checked = false;
      lockCheckbox.disabled = true;
      try { await enableLock(); }
      catch (error) {
        disableLock();
        lockStatus.textContent = error.name === 'Error' ? error.message :
          'No se pudo activar Face ID. Inténtalo de nuevo.';
      } finally { lockCheckbox.disabled = false; }
    });
    paintLock();
    if (enabled()) lockSupport.then(supported => {
      if (supported || !enabled()) return;
      disableLock();
      lockStatus.textContent = 'El bloqueo se apagó porque Face ID no está disponible.';
    });
  }

  function privacyOnReturn() {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (hiddenAt !== null && Date.now() - hiddenAt > 60000 && enabled()) {
      unlocked = false;
      paintLock();
    }
    hiddenAt = null;
  }

  // Mount after the body is parsed. The inline app can call getInit before then.
  document.addEventListener('DOMContentLoaded', mount, { once: true });
  document.addEventListener('DOMContentLoaded', mountLock, { once: true });
  document.addEventListener('visibilitychange', privacyOnReturn);
  window.addEventListener('storage', event => {
    if (event.key === null || event.key === KEYS.token || event.key === KEYS.url) location.reload();
    if (event.key === lockKey) {
      credentialId = stored(lockKey);
      unlocked = !credentialId;
      paintLock();
    }
  });
  window.google = { script: { run: runner() } };
  window.tallyConnection = { isFresh: data => freshData === data, registerWorker };
  window.tallyLock = { enabled, unlocked: () => unlocked, requestUnlock };
})();
