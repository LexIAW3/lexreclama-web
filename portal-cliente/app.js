const storageKey = 'lex_portal_session_token';
const state = {
  caseId: '',
  expiresAtMs: 0,
  timer: null,
  activeCase: null,
};

const el = {
  loginStep: document.querySelector('#login-step'),
  codeStep: document.querySelector('#code-step'),
  appStep: document.querySelector('#portal-app'),
  loginForm: document.querySelector('#login-form'),
  codeForm: document.querySelector('#code-form'),
  messageForm: document.querySelector('#message-form'),
  caseInput: document.querySelector('#case-id'),
  codeInput: document.querySelector('#code-input'),
  loginError: document.querySelector('#login-error'),
  codeError: document.querySelector('#code-error'),
  codeHelp: document.querySelector('#code-help'),
  countdown: document.querySelector('#countdown'),
  caseList: document.querySelector('#case-list'),
  detail: document.querySelector('#case-detail'),
  detailTitle: document.querySelector('#detail-title'),
  detailStatus: document.querySelector('#detail-status'),
  detailUpdated: document.querySelector('#detail-updated'),
  detailSteps: document.querySelector('#detail-steps'),
  detailMessages: document.querySelector('#detail-messages'),
  messageInput: document.querySelector('#message-input'),
  messageStatus: document.querySelector('#message-status'),
  backToLogin: document.querySelector('#back-to-login'),
  logoutBtn: document.querySelector('#logout-btn'),
};

function readCsrfToken() {
  const cookie = document.cookie
    .split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith('lex_csrf_token='));
  if (cookie) return decodeURIComponent(cookie.slice('lex_csrf_token='.length));
  return '';
}

async function api(path, options = {}) {
  const opts = { method: 'GET', headers: {}, ...options };
  if (opts.body && opts.headers['Content-Type'] === undefined) {
    opts.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (res.ok === false) {
    throw new Error(data.error || 'Error de servidor');
  }
  return data;
}

function showStep(step) {
  el.loginStep.hidden = step !== 'login';
  el.codeStep.hidden = step !== 'code';
  el.appStep.hidden = step !== 'app';
}

function clearErrors() {
  el.loginError.hidden = true;
  el.codeError.hidden = true;
  el.messageStatus.textContent = '';
}

function setError(target, msg) {
  target.textContent = msg;
  target.hidden = !msg;
}

function formatCountdown(msLeft) {
  if (msLeft <= 0) return 'Valido 00:00';
  const total = Math.floor(msLeft / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `Valido ${m}:${s}`;
}

function startCountdown(expiresAtMs) {
  if (state.timer !== null) window.clearInterval(state.timer);
  state.expiresAtMs = expiresAtMs;
  el.countdown.textContent = formatCountdown(expiresAtMs - Date.now());
  state.timer = window.setInterval(() => {
    const left = state.expiresAtMs - Date.now();
    el.countdown.textContent = formatCountdown(left);
    if (left <= 0 && state.timer !== null) {
      window.clearInterval(state.timer);
      state.timer = null;
    }
  }, 1000);
}

function renderCaseDetail(c) {
  state.activeCase = c;
  el.detail.hidden = false;
  el.detailTitle.textContent = `${c.identifier} · ${c.title}`;
  el.detailStatus.textContent = c.statusLabel;
  el.detailUpdated.textContent = `Ultima actualizacion: ${new Date(c.updatedAt).toLocaleString('es-ES')}`;
  el.detailSteps.innerHTML = '';
  c.steps.forEach((step) => {
    const li = document.createElement('li');
    li.textContent = step;
    el.detailSteps.appendChild(li);
  });
  el.detailMessages.innerHTML = '';
  c.messages.forEach((m) => {
    const li = document.createElement('li');
    li.textContent = `${m.author}: ${m.body}`;
    el.detailMessages.appendChild(li);
  });
}

function renderCases(cases) {
  el.caseList.innerHTML = '';
  cases.forEach((c) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'case-card';
    card.innerHTML = `<strong>${c.identifier}</strong><div>${c.title}</div><span class="badge">${c.statusLabel}</span>`;
    card.addEventListener('click', () => renderCaseDetail(c));
    el.caseList.appendChild(card);
  });
  if (cases.length > 0) renderCaseDetail(cases[0]);
}

async function loadSession() {
  const token = localStorage.getItem(storageKey);
  if (token === null || token === '') return false;
  try {
    const data = await api('/api/portal/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    renderCases(data.cases || []);
    showStep('app');
    return true;
  } catch {
    localStorage.removeItem(storageKey);
    return false;
  }
}

el.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors();
  state.caseId = String(el.caseInput.value || '').trim().toUpperCase();
  try {
    const data = await api('/api/portal/request-code', {
      method: 'POST',
      body: JSON.stringify({ caseId: state.caseId, csrfToken: readCsrfToken() }),
    });
    el.codeHelp.textContent = `Enviamos un codigo a ${data.maskedEmail}.`;
    startCountdown(Date.now() + (data.expiresInSec * 1000));
    showStep('code');
    el.codeInput.focus();
  } catch (err) {
    setError(el.loginError, err.message);
  }
});

el.codeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors();
  const code = String(el.codeInput.value || '').trim();
  try {
    const data = await api('/api/portal/verify-code', {
      method: 'POST',
      body: JSON.stringify({ caseId: state.caseId, code, csrfToken: readCsrfToken() }),
    });
    localStorage.setItem(storageKey, data.token);
    await loadSession();
  } catch (err) {
    setError(el.codeError, err.message);
  }
});

el.messageForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.activeCase === null) return;
  const token = localStorage.getItem(storageKey) || '';
  const message = String(el.messageInput.value || '').trim();
  if (message === '') return;
  try {
    await api(`/api/portal/cases/${encodeURIComponent(state.activeCase.identifier)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message, csrfToken: readCsrfToken() }),
    });
    el.messageInput.value = '';
    el.messageStatus.textContent = 'Mensaje enviado. Te responderemos en 24-48h.';
    await loadSession();
  } catch (err) {
    el.messageStatus.textContent = err.message;
  }
});

el.backToLogin.addEventListener('click', () => {
  clearErrors();
  showStep('login');
});

el.logoutBtn.addEventListener('click', async () => {
  const token = localStorage.getItem(storageKey);
  if (token) {
    await api('/api/portal/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ csrfToken: readCsrfToken() }),
    }).catch(() => null);
  }
  localStorage.removeItem(storageKey);
  showStep('login');
});

loadSession().then((ok) => {
  if (ok === false) showStep('login');
});
