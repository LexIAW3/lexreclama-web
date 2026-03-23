const state = {
  caseId:      '',
  expiresAtMs: 0,
  timer:       null,
  activeCase:  null,
  cases:       [],
  activeTab:   'overview',
};

const portalRequestCodeMessage = (caseId, maskedEmail) => (
  maskedEmail
    ? `Hemos enviado un código a ${maskedEmail} para el caso ${caseId}.`
    : `Si el caso ${caseId} existe, recibirás un código en el email registrado.`
);

const el = {
  loginStep:    document.querySelector('#login-step'),
  codeStep:     document.querySelector('#code-step'),
  appStep:      document.querySelector('#portal-app'),
  loginForm:    document.querySelector('#login-form'),
  codeForm:     document.querySelector('#code-form'),
  messageForm:  document.querySelector('#message-form'),
  caseInput:    document.querySelector('#case-id'),
  otpGrid:      document.querySelector('#otp-grid'),
  otpCells:     Array.from(document.querySelectorAll('.otp-cell')),
  loginError:   document.querySelector('#login-error'),
  codeError:    document.querySelector('#code-error'),
  codeHelp:     document.querySelector('#code-help'),
  countdown:    document.querySelector('#countdown'),
  resendBtn:    document.querySelector('#resend-btn'),
  verifyBtn:    document.querySelector('#verify-btn'),
  caseList:     document.querySelector('#case-list'),
  caseEmpty:    document.querySelector('#case-empty'),
  detail:       document.querySelector('#case-detail'),
  detailTitle:  document.querySelector('#detail-title'),
  detailStatus: document.querySelector('#detail-status'),
  detailUpdated:document.querySelector('#detail-updated'),
  detailSteps:  document.querySelector('#detail-steps'),
  detailMessages:document.querySelector('#detail-messages'),
  messageInput: document.querySelector('#message-input'),
  messageToast: document.querySelector('#message-toast'),
  messageError: document.querySelector('#message-error'),
  charCount:    document.querySelector('#char-count'),
  sendBtn:      document.querySelector('#send-btn'),
  detailBack:   document.querySelector('#detail-back'),
  backToLogin:  document.querySelector('#back-to-login'),
  logoutBtn:    document.querySelector('#logout-btn'),
  loading:      document.querySelector('#portal-loading'),
  notice:       document.querySelector('#portal-notice'),
  noticeTitle:  document.querySelector('#notice-title'),
  noticeText:   document.querySelector('#notice-text'),
  nextStep:     document.querySelector('#detail-next-step'),
  detailDocs:   document.querySelector('#detail-documents'),
  detailDocsEmpty: document.querySelector('#detail-documents-empty'),
  detailTabs:   Array.from(document.querySelectorAll('.detail-tab')),
  tabOverview:  document.querySelector('#tab-overview'),
  tabDocuments: document.querySelector('#tab-documents'),
  tabMessages:  document.querySelector('#tab-messages'),
};

/* ─── Helpers ─── */

function readCsrfToken() {
  const cookie = document.cookie
    .split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith('lex_csrf_token='));
  return cookie ? decodeURIComponent(cookie.slice('lex_csrf_token='.length)) : '';
}

async function api(path, options = {}) {
  const opts = { method: 'GET', headers: {}, ...options };
  if (opts.body && opts.headers['Content-Type'] === undefined) {
    opts.headers['Content-Type'] = 'application/json';
  }
  const res  = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error de servidor');
  return data;
}

function showStep(step) {
  el.loginStep.hidden = step !== 'login';
  el.codeStep.hidden  = step !== 'code';
  el.appStep.hidden   = step !== 'app';
}

function clearErrors() {
  el.loginError.hidden = true;
  el.codeError.hidden  = true;
  el.messageError.hidden = true;
  el.messageToast.classList.remove('visible');
}

function setError(target, msg) {
  target.textContent = msg;
  target.hidden = !msg;
}

function friendlyError(err) {
  const message = String(err?.message || '');
  if (/demasiadas solicitudes/i.test(message)) return 'Hemos recibido demasiadas solicitudes. Espera un minuto y vuelve a intentarlo.';
  if (/sesion invalida|expirada/i.test(message)) return 'Tu sesión ha caducado. Vuelve a iniciar sesión.';
  if (/servidor/i.test(message)) return 'No hemos podido conectar con el portal. Inténtalo de nuevo en unos segundos.';
  return message || 'Ha ocurrido un error inesperado.';
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function setLoading(isLoading) {
  if (!el.loading) return;
  el.loading.hidden = !isLoading;
}

function setNotice(title, text) {
  if (!title || !text) {
    el.notice.hidden = true;
    return;
  }
  el.noticeTitle.textContent = title;
  el.noticeText.textContent = text;
  el.notice.hidden = false;
}

function setActiveTab(tab) {
  state.activeTab = tab;
  const isOverview = tab === 'overview';
  const isDocuments = tab === 'documents';
  const isMessages = tab === 'messages';
  el.tabOverview.hidden = !isOverview;
  el.tabDocuments.hidden = !isDocuments;
  el.tabMessages.hidden = !isMessages;
  el.detailTabs.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
}

/* ─── Badge color mapping ─── */

const badgeMap = [
  { match: /en\s*curso/i,       cls: 'badge--en-curso' },
  { match: /resuelto/i,         cls: 'badge--resuelto' },
  { match: /pendiente/i,        cls: 'badge--pendiente' },
  { match: /error|cancelado/i,  cls: 'badge--error' },
];

function badgeClass(label) {
  const found = badgeMap.find((r) => r.match.test(label));
  return found ? found.cls : '';
}

/* ─── OTP grid ─── */

function getOtpValue() {
  return el.otpCells.map((c) => c.value).join('');
}

function updateVerifyBtn() {
  el.verifyBtn.disabled = getOtpValue().length < 6;
}

function initOtpCells() {
  el.otpCells.forEach((cell, i) => {
    cell.addEventListener('input', (e) => {
      // Accept only digits; strip non-numeric
      const digit = e.target.value.replace(/\D/g, '').slice(-1);
      cell.value = digit;
      if (digit && i < el.otpCells.length - 1) {
        el.otpCells[i + 1].focus();
      }
      updateVerifyBtn();
    });

    cell.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && cell.value === '' && i > 0) {
        el.otpCells[i - 1].focus();
        el.otpCells[i - 1].value = '';
        updateVerifyBtn();
      }
    });

    // Handle paste on first cell: spread digits across cells
    cell.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '');
      el.otpCells.forEach((c, idx) => {
        c.value = text[idx] || '';
      });
      const last = Math.min(text.length, el.otpCells.length) - 1;
      if (last >= 0) el.otpCells[last].focus();
      updateVerifyBtn();
    });
  });
}

function clearOtp() {
  el.otpCells.forEach((c) => { c.value = ''; });
  updateVerifyBtn();
}

/* ─── Countdown ─── */

function formatCountdown(msLeft) {
  if (msLeft <= 0) return '00:00';
  const total = Math.floor(msLeft / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function startCountdown(expiresAtMs) {
  if (state.timer !== null) window.clearInterval(state.timer);
  state.expiresAtMs = expiresAtMs;

  let resendUnlocked = false;
  el.resendBtn.disabled = true;

  const tick = () => {
    const left = state.expiresAtMs - Date.now();
    el.countdown.textContent = `Válido ${formatCountdown(left)}`;
    el.countdown.classList.toggle('urgent', left > 0 && left < 120_000);

    if (left <= 0) {
      window.clearInterval(state.timer);
      state.timer = null;
      el.countdown.textContent = 'El código ha caducado.';
      el.countdown.classList.add('urgent');
      el.verifyBtn.hidden = true;
      if (!resendUnlocked) {
        el.resendBtn.disabled = false;
        resendUnlocked = true;
      }
    } else if (left <= 60_000 && !resendUnlocked) {
      el.resendBtn.disabled = false;
      resendUnlocked = true;
    }
  };

  tick();
  state.timer = window.setInterval(tick, 1000);
}

/* ─── Render ─── */

const STEP_ORDER = ['Recibido', 'En revisión', 'En negociación', 'Resolución', 'Cobro'];

function renderSteps(steps, activeLabel) {
  el.detailSteps.innerHTML = '';
  const labels = steps.length > 0 ? steps : STEP_ORDER;
  let activeSeen = false;
  labels.forEach((step) => {
    const li = document.createElement('li');
    li.textContent = step;
    const isDone   = !activeSeen && step !== activeLabel;
    const isActive = step === activeLabel || (!activeLabel && !activeSeen && step === labels[0]);
    if (isDone && !isActive)   li.classList.add('step--done');
    if (isActive) { li.classList.add('step--active'); activeSeen = true; }
    el.detailSteps.appendChild(li);
  });
}

function renderMessages(messages) {
  el.detailMessages.innerHTML = '';
  if (!messages || messages.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'Aún no hay mensajes.';
    li.style.color = 'var(--muted)';
    el.detailMessages.appendChild(li);
    return;
  }
  messages.forEach((m) => {
    const li = document.createElement('li');
    if (m.fromClient) li.classList.add('msg--client');
    const author = document.createElement('span');
    author.className = 'msg-author';
    author.textContent = `${m.author} · ${new Date(m.createdAt || m.date).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}`;
    const body = document.createElement('span');
    body.className = 'msg-body';
    body.textContent = m.body;
    li.appendChild(author);
    li.appendChild(body);
    el.detailMessages.appendChild(li);
  });
}

function renderDocuments(documents) {
  el.detailDocs.innerHTML = '';
  const docs = Array.isArray(documents) ? documents : [];
  if (docs.length === 0) {
    el.detailDocsEmpty.hidden = false;
    return;
  }

  el.detailDocsEmpty.hidden = true;
  docs.forEach((doc) => {
    const li = document.createElement('li');
    const meta = document.createElement('div');
    meta.className = 'doc-meta';
    const name = document.createElement('span');
    name.className = 'doc-name';
    name.textContent = doc.name || 'Documento';
    const info = document.createElement('span');
    info.className = 'doc-info';
    const when = doc.createdAt
      ? new Date(doc.createdAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' })
      : 'Fecha no disponible';
    info.textContent = `${when} · ${formatBytes(doc.size)} · ${doc.mimeType || 'Archivo'}`;
    meta.append(name, info);

    const link = document.createElement('a');
    link.className = 'doc-link';
    link.href = doc.url || '#';
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Descargar';

    li.append(meta, link);
    el.detailDocs.appendChild(li);
  });
}

function updatePortalNotice(c) {
  if (!c) {
    setNotice('', '');
    return;
  }
  const totalMessages = Array.isArray(c.messages) ? c.messages.length : 0;
  const hasPendingDocs = !Array.isArray(c.documents) || c.documents.length === 0;
  if (hasPendingDocs) {
    setNotice('Pendiente de documentación', 'Tu expediente sigue en curso. Te avisaremos aquí cuando subamos nuevos documentos.');
    return;
  }
  if (totalMessages > 0) {
    setNotice('Canal abierto con tu gestor', 'Puedes escribirnos desde la pestaña Mensajes. Respondemos en 24-48h laborables.');
    return;
  }
  setNotice('', '');
}

function renderCaseDetail(c) {
  state.activeCase = c;
  el.detail.hidden = false;
  el.detailTitle.textContent = `${c.identifier} · ${c.title}`;

  // Status badge
  el.detailStatus.innerHTML = '';
  const badge = document.createElement('span');
  badge.className = `badge ${badgeClass(c.statusLabel)}`;
  badge.textContent = c.statusLabel;
  el.detailStatus.appendChild(badge);

  el.detailUpdated.textContent = `Última actualización: ${new Date(c.updatedAt).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' })}`;

  renderSteps(c.steps || [], c.activeStep || null);
  renderMessages(c.messages || []);
  renderDocuments(c.documents || []);
  el.nextStep.textContent = c.nextAction || 'Revisando documentación y preparando el siguiente avance del expediente.';
  updatePortalNotice(c);
  setActiveTab(state.activeTab || 'overview');

  el.messageInput.value = '';
  el.charCount.textContent = '0';
  el.sendBtn.disabled = true;
  clearErrors();
}

function renderCases(cases) {
  el.caseList.innerHTML = '';
  state.cases = Array.isArray(cases) ? cases : [];

  if (state.cases.length === 0) {
    el.caseEmpty.hidden = false;
    el.detail.hidden    = true;
    setNotice('', '');
    return;
  }

  el.caseEmpty.hidden = true;
  state.cases.forEach((c) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'case-card';

    const updated = new Date(c.updatedAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });

    const spanId   = document.createElement('span');
    spanId.className = 'case-id';
    spanId.textContent = c.identifier;

    const spanBadge = document.createElement('span');
    spanBadge.className = `badge ${badgeClass(c.statusLabel)}`;
    spanBadge.textContent = c.statusLabel;

    const pTitle = document.createElement('p');
    pTitle.className = 'case-title';
    pTitle.textContent = c.title;

    const pMeta = document.createElement('p');
    pMeta.className = 'case-meta';
    pMeta.textContent = `Actualizado el ${updated}`;

    card.append(spanId, spanBadge, pTitle, pMeta);
    card.addEventListener('click', () => {
      renderCaseDetail(c);
      Array.from(el.caseList.querySelectorAll('.case-card')).forEach((node) => node.classList.remove('active'));
      card.classList.add('active');
      card.setAttribute('aria-selected', 'true');
    });
    el.caseList.appendChild(card);
  });

  renderCaseDetail(state.cases[0]);
  const firstCard = el.caseList.querySelector('.case-card');
  if (firstCard) {
    firstCard.classList.add('active');
    firstCard.setAttribute('aria-selected', 'true');
  }
}

/* ─── Session ─── */

async function loadSession() {
  setLoading(true);
  try {
    const data = await api('/api/portal/me');
    renderCases(data.cases || []);
    showStep('app');
    return true;
  } catch {
    return false;
  } finally {
    setLoading(false);
  }
}

/* ─── Event: textarea char counter ─── */

el.messageInput.addEventListener('input', () => {
  const len = el.messageInput.value.length;
  el.charCount.textContent = len;
  el.sendBtn.disabled = len === 0;
});

/* ─── Event: Login form ─── */

el.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors();
  const btn = event.submitter || el.loginForm.querySelector('button[type="submit"]');
  btn.disabled = true;
  state.caseId = String(el.caseInput.value || '').trim().toUpperCase();
  try {
    const data = await api('/api/portal/request-code', {
      method: 'POST',
      body: JSON.stringify({ caseId: state.caseId, csrfToken: readCsrfToken() }),
    });
    el.codeHelp.textContent = portalRequestCodeMessage(state.caseId, data.maskedEmail);
    clearOtp();
    el.verifyBtn.hidden = false;
    startCountdown(Date.now() + (data.expiresInSec * 1000));
    showStep('code');
    el.otpCells[0].focus();
  } catch (err) {
    setError(el.loginError, friendlyError(err));
  } finally {
    btn.disabled = false;
  }
});

/* ─── Event: Code form ─── */

el.codeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors();
  const code = getOtpValue();
  if (code.length < 6) return;
  el.verifyBtn.disabled = true;
  try {
    await api('/api/portal/verify-code', {
      method: 'POST',
      body: JSON.stringify({ caseId: state.caseId, code, csrfToken: readCsrfToken() }),
    });
    await loadSession();
  } catch (err) {
    setError(el.codeError, friendlyError(err));
    clearOtp();
    el.otpCells[0].focus();
    el.verifyBtn.disabled = true;
  }
});

/* ─── Event: Resend ─── */

el.resendBtn.addEventListener('click', async () => {
  el.resendBtn.disabled = true;
  clearErrors();
  try {
    const data = await api('/api/portal/request-code', {
      method: 'POST',
      body: JSON.stringify({ caseId: state.caseId, csrfToken: readCsrfToken() }),
    });
    el.codeHelp.textContent = portalRequestCodeMessage(state.caseId, data.maskedEmail);
    clearOtp();
    el.verifyBtn.hidden = false;
    startCountdown(Date.now() + (data.expiresInSec * 1000));
    el.otpCells[0].focus();
  } catch (err) {
    setError(el.codeError, friendlyError(err));
    el.resendBtn.disabled = false;
  }
});

/* ─── Event: Message form ─── */

el.messageForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.activeCase) return;
  const message = el.messageInput.value.trim();
  if (!message) return;
  el.sendBtn.disabled = true;
  clearErrors();
  try {
    await api(`/api/portal/cases/${encodeURIComponent(state.activeCase.identifier)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ message, csrfToken: readCsrfToken() }),
    });
    el.messageInput.value  = '';
    el.charCount.textContent = '0';
    el.messageToast.classList.add('visible');
    setTimeout(() => el.messageToast.classList.remove('visible'), 3000);
    await loadSession();
  } catch (err) {
    setError(el.messageError, friendlyError(err));
    el.sendBtn.disabled = false;
  }
});

/* ─── Event: Back to case list ─── */

el.detailBack.addEventListener('click', () => {
  el.detail.hidden = true;
  state.activeCase = null;
});

/* ─── Event: Back to login (from 2FA) ─── */

el.backToLogin.addEventListener('click', () => {
  clearErrors();
  if (state.timer !== null) { window.clearInterval(state.timer); state.timer = null; }
  showStep('login');
});

/* ─── Event: Logout ─── */

el.logoutBtn.addEventListener('click', async () => {
  el.logoutBtn.disabled = true;
  await api('/api/portal/logout', {
    method: 'POST',
    body: JSON.stringify({ csrfToken: readCsrfToken() }),
  }).catch(() => null);
  el.logoutBtn.disabled = false;
  showStep('login');
});

el.detailTabs.forEach((btn) => {
  btn.addEventListener('click', () => setActiveTab(btn.dataset.tab || 'overview'));
});

/* ─── Boot ─── */

initOtpCells();
loadSession().then((ok) => { if (!ok) showStep('login'); });
