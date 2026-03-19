/* ─── CONFIG ──────────────────────────────────────────────── */
const SUBMIT_ENDPOINT = '/submit-lead';
const CHECKOUT_SESSION_ENDPOINT = '/create-checkout-session';
const CHECKOUT_CONFIRM_ENDPOINT = '/confirm-checkout';
const COOKIE_CONSENT_KEY = 'lex_cookie_consent_v1';
const THEME_PREFERENCE_KEY = 'lex_theme_preference_v1';
const PRIVACY_POLICY_VERSION = '2026-03';

function trackGtagEvent(name, params = {}) {
  if (typeof window.gtag !== 'function') return;
  window.gtag('event', name, params);
}

function trackVirtualPageView() {
  if (typeof window.gtag !== 'function') return;
  window.gtag('event', 'page_view', {
    page_location: window.location.href,
    page_path: `${window.location.pathname}${window.location.hash || ''}`,
    page_title: document.title,
  });
}

function getSystemThemePreference() {
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
  return 'dark';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
}

function updateThemeToggleLabel(button, theme) {
  if (!button) return;
  const nextTheme = theme === 'light' ? 'dark' : 'light';
  const label = nextTheme === 'light' ? 'Activar modo claro' : 'Activar modo oscuro';
  button.setAttribute('aria-label', label);
  button.setAttribute('title', label);
}

function initThemeToggle() {
  const button = document.getElementById('theme-toggle');
  if (!button) return;

  const storedTheme = localStorage.getItem(THEME_PREFERENCE_KEY);
  const hasStoredTheme = storedTheme === 'light' || storedTheme === 'dark';
  const initialTheme = hasStoredTheme ? storedTheme : getSystemThemePreference();
  applyTheme(initialTheme);
  updateThemeToggleLabel(button, initialTheme);

  button.addEventListener('click', () => {
    const currentTheme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const nextTheme = currentTheme === 'light' ? 'dark' : 'light';
    applyTheme(nextTheme);
    localStorage.setItem(THEME_PREFERENCE_KEY, nextTheme);
    updateThemeToggleLabel(button, nextTheme);
  });

  if (!hasStoredTheme && window.matchMedia) {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const syncWithSystem = event => {
      const latestStored = localStorage.getItem(THEME_PREFERENCE_KEY);
      if (latestStored === 'light' || latestStored === 'dark') return;
      const nextTheme = event.matches ? 'light' : 'dark';
      applyTheme(nextTheme);
      updateThemeToggleLabel(button, nextTheme);
    };
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', syncWithSystem);
    } else if (typeof media.addListener === 'function') {
      media.addListener(syncWithSystem);
    }
  }
}

/* ─── CALCULATOR TABS ─────────────────────────────────────── */
document.querySelectorAll('.calc-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const type = tab.dataset.tab;
    document.querySelectorAll('.calc-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.calc-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`panel-${type}`).classList.add('active');
    document.getElementById('calc-result').classList.add('hidden');
  });
});

/* ─── BANCO FIELD TOGGLE ──────────────────────────────────── */
function toggleBancoFields() {
  const tipoField = document.getElementById('banco-tipo');
  if (!tipoField) return;
  const tipo = tipoField.value;
  document.querySelectorAll('.banco-field').forEach(f => f.classList.add('hidden'));
  document.getElementById('campo-hipoteca').classList.remove('hidden');

  if (tipo === 'suelo' || tipo === 'irph') {
    document.getElementById('campo-suelo-anios').classList.remove('hidden');
    document.getElementById('campo-suelo-cuota').classList.remove('hidden');
    document.getElementById('campo-hipoteca').classList.add('hidden');
  } else if (tipo === 'comision') {
    document.getElementById('campo-comision').classList.remove('hidden');
    document.getElementById('campo-hipoteca').classList.add('hidden');
  }
}

function initNavScrollEffect() {
  const nav = document.getElementById('main-nav');
  if (!nav) return;
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 20);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
}

/* ─── CALCULATORS ─────────────────────────────────────────── */
function calcDeuda() {
  const importe = parseFloat(document.getElementById('deuda-importe').value) || 0;
  const meses = parseInt(document.getElementById('deuda-meses').value) || 0;
  const docs = document.getElementById('deuda-docs').value;

  if (importe <= 0) { alert('Introduce el importe de la deuda'); return; }

  // Intereses legales: ~3% anual (tipo legal dinero 2024)
  const interes = importe * 0.03 * (meses / 12);
  // Costas procesales estimadas (monitorio)
  const costas = Math.min(importe * 0.1, 600);
  let total = importe + interes + costas;

  let probabilidad, nota;
  if (docs === 'si') {
    probabilidad = 'Alta';
    nota = `Importe principal: ${fmt(importe)} + intereses legales: ${fmt(interes)} + costas estimadas: ${fmt(costas)}. Con documentación completa, la probabilidad de éxito es alta.`;
  } else if (docs === 'parcial') {
    total *= 0.85;
    probabilidad = 'Media';
    nota = `Estimación orientativa con documentación parcial. Te ayudaremos a completar el expediente.`;
  } else {
    total *= 0.6;
    probabilidad = 'A evaluar';
    nota = `Sin documentación, la viabilidad depende del caso. Analízalo con nosotros gratuitamente.`;
  }

  showResult(total, `Probabilidad de éxito: ${probabilidad} · ${nota}`);
}

function calcBanco() {
  const tipo = document.getElementById('banco-tipo').value;
  let total = 0;
  let nota = '';

  if (tipo === 'gastos') {
    const hipoteca = parseFloat(document.getElementById('banco-hipoteca').value) || 0;
    if (hipoteca <= 0) { alert('Introduce el importe de la hipoteca'); return; }
    // Gastos hipotecarios típicos: ~1.5-2% del capital (notaría, registro, gestoría, AJD)
    total = hipoteca * 0.018;
    nota = `Estimación de gastos hipotecarios recuperables (notaría, registro, gestoría) para una hipoteca de ${fmt(hipoteca)}. Porcentaje medio del 1,8% sobre capital.`;

  } else if (tipo === 'suelo') {
    const anios = parseInt(document.getElementById('banco-anios').value) || 0;
    const cuota = parseFloat(document.getElementById('banco-cuota').value) || 0;
    if (anios <= 0 || cuota <= 0) { alert('Introduce los años y cuota mensual'); return; }
    // Diferencia estimada con cláusula suelo: ~8-12% de cuota mensual durante el período
    total = cuota * 12 * anios * 0.10;
    nota = `Diferencia estimada entre lo pagado con cláusula suelo y el tipo legal correspondiente, durante ${anios} años con cuota de ${fmt(cuota)}/mes. Esta cifra puede variar significativamente según el tipo suelo y el Euribor aplicable en cada período.`;

  } else if (tipo === 'irph') {
    const anios = parseInt(document.getElementById('banco-anios').value) || 0;
    const cuota = parseFloat(document.getElementById('banco-cuota').value) || 0;
    if (anios <= 0 || cuota <= 0) { alert('Introduce los años y cuota mensual'); return; }
    // Exceso IRPH vs Euribor+1: ~15% de cuota media anual
    total = cuota * 12 * anios * 0.15;
    nota = `Exceso estimado pagado por IRPH respecto a Euribor + 1% durante ${anios} años. Requiere análisis del cuadro de amortización para cifra exacta.`;

  } else if (tipo === 'comision') {
    const comision = parseFloat(document.getElementById('banco-comision').value) || 0;
    if (comision <= 0) { alert('Introduce la comisión de apertura'); return; }
    total = comision;
    nota = `La comisión de apertura es directamente el importe recuperable si el tribunal la declara abusiva. Hay jurisprudencia favorable del TJUE.`;
  }

  showResult(total, nota);
}

function calcMulta() {
  const importe = parseFloat(document.getElementById('multa-importe').value) || 0;
  const motivo = document.getElementById('multa-motivo').value;

  if (importe <= 0) { alert('Introduce el importe de la multa'); return; }

  let pct, nota;
  if (motivo === 'fuerte') {
    pct = 1.0;
    nota = `Con pruebas claras, existe alta probabilidad de anulación total de la multa de ${fmt(importe)}.`;
  } else if (motivo === 'posible') {
    pct = 0.6;
    nota = `Con motivos probables, estimamos un 60% de probabilidad de anular la sanción. Analizamos el expediente sin coste.`;
  } else {
    pct = 0.3;
    nota = `Sin base clara conocida, realizamos un análisis gratuito del expediente para determinar la viabilidad real del recurso.`;
  }

  showResult(importe * pct, nota);
}

function showResult(amount, note) {
  document.getElementById('result-amount').textContent = fmt(amount);
  document.getElementById('result-note').textContent = note;
  const el = document.getElementById('calc-result');
  el.classList.remove('hidden');
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function fmt(n) {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
}

/* ─── FORM HELPERS ────────────────────────────────────────── */
function setClaimType(type) {
  const sel = document.getElementById('tipo-reclamacion');
  if (sel) sel.value = type;
}

function prefillFromCalc() {
  const activeTab = document.querySelector('.calc-tab.active');
  if (activeTab) setClaimType(activeTab.dataset.tab);
}

/* ─── LEAD FORM SUBMISSION ────────────────────────────────── */
function requiresUpfrontPayment(tipo) {
  return tipo === 'deuda' || tipo === 'multa';
}

async function submitLead(event) {
  event.preventDefault();

  const form = document.getElementById('lead-form');
  const submitBtn = document.getElementById('submit-btn');
  const submitText = document.getElementById('submit-text');
  const submitLoading = document.getElementById('submit-loading');
  const successEl = document.getElementById('form-success');
  const errorEl = document.getElementById('form-error');

  // Gather data
  const data = {
    nombre: document.getElementById('nombre').value.trim(),
    email: document.getElementById('email').value.trim(),
    telefono: document.getElementById('telefono').value.trim(),
    tipo: document.getElementById('tipo-reclamacion').value,
    descripcion: document.getElementById('descripcion').value.trim(),
    privacidadAceptada: document.getElementById('privacidad').checked,
    comercialAceptada: document.getElementById('comercial').checked,
    consentimientoTimestamp: new Date().toISOString(),
    versionPolitica: PRIVACY_POLICY_VERSION,
  };

  const tipoLabel = {
    deuda: 'Reclamación de deuda impagada',
    banco: 'Cláusulas bancarias abusivas',
    multa: 'Impugnación de multa',
    otro: 'Consulta general',
  }[data.tipo] || data.tipo;

  // Loading state
  submitBtn.disabled = true;
  submitText.classList.add('hidden');
  submitLoading.classList.remove('hidden');
  successEl.classList.add('hidden');
  errorEl.classList.add('hidden');

  try {
    if (requiresUpfrontPayment(data.tipo)) {
      const checkout = await createCheckoutSession(data, tipoLabel);
      trackGtagEvent('begin_checkout', { event_category: 'formulario', event_label: data.tipo });
      window.location.href = checkout.checkoutUrl;
      return;
    }

    await createPaperclipLead(data, tipoLabel);
    trackGtagEvent('generate_lead', { event_category: 'formulario', event_label: data.tipo });
    form.reset();
    successEl.classList.remove('hidden');
    successEl.querySelector('p').textContent = 'Hemos recibido su solicitud y nos pondremos en contacto con usted en 24-48 horas laborables. Sus datos serán tratados conforme a la Política de Privacidad.';
    form.classList.add('hidden');
  } catch (err) {
    console.error('Lead submission error:', err);
    errorEl.classList.remove('hidden');
  } finally {
    submitBtn.disabled = false;
    submitText.classList.remove('hidden');
    submitLoading.classList.add('hidden');
  }
}

async function createPaperclipLead(data, tipoLabel) {
  const res = await fetch(SUBMIT_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...data, tipoLabel }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function createCheckoutSession(data, tipoLabel) {
  const res = await fetch(CHECKOUT_SESSION_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...data, tipoLabel }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function confirmCheckout(leadToken, sessionId) {
  const res = await fetch(CHECKOUT_CONFIRM_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leadToken, sessionId }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function handleCheckoutReturn() {
  const params = new URLSearchParams(window.location.search);
  const status = params.get('checkout');
  if (!status) return;

  const form = document.getElementById('lead-form');
  const successEl = document.getElementById('form-success');
  const errorEl = document.getElementById('form-error');
  const successText = successEl?.querySelector('p');

  if (status === 'cancel') {
    if (errorEl) errorEl.classList.remove('hidden');
    if (form) form.classList.remove('hidden');
    const cleanUrl = `${window.location.pathname}${window.location.hash || ''}`;
    window.history.replaceState({}, document.title, cleanUrl);
    return;
  }

  if (status !== 'success') return;

  const leadToken = params.get('lead') || '';
  const sessionId = params.get('session_id') || '';
  if (!leadToken || !sessionId) return;

  if (errorEl) errorEl.classList.add('hidden');
  if (successEl) successEl.classList.remove('hidden');
  if (successText) successText.textContent = 'Pago recibido. Estamos validando tu transacción...';
  if (form) form.classList.add('hidden');

  try {
    const result = await confirmCheckout(leadToken, sessionId);
    trackGtagEvent('purchase', {
      event_category: 'formulario',
      transaction_id: sessionId,
      value: result?.identifier ? 1 : 0,
      currency: 'EUR',
    });
    trackGtagEvent('generate_lead', { event_category: 'formulario', event_label: 'checkout_paid' });
    if (successText) {
      successText.textContent = 'Pago confirmado y caso recibido. Te contactaremos en 24-48 horas laborables.';
    }
    const cleanUrl = `${window.location.pathname}${window.location.hash || ''}`;
    window.history.replaceState({}, document.title, cleanUrl);
  } catch (err) {
    console.error('Checkout confirmation error:', err);
    if (successEl) successEl.classList.add('hidden');
    if (errorEl) errorEl.classList.remove('hidden');
  }
}

/* ─── INIT ────────────────────────────────────────────────── */
function initScrollAnimations() {
  const animatedEls = document.querySelectorAll('[data-animate]');
  if (!animatedEls.length) return;
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    animatedEls.forEach((el) => observer.observe(el));
  } else {
    animatedEls.forEach((el) => el.classList.add('is-visible'));
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initThemeToggle();
  initNavScrollEffect();
  initScrollAnimations();
  toggleBancoFields();
  initCookieBanner();
  handleCheckoutReturn();
  trackVirtualPageView();
  window.addEventListener('popstate', trackVirtualPageView);
  window.addEventListener('hashchange', trackVirtualPageView);
});

function initCookieBanner() {
  const banner = document.getElementById('cookie-banner');
  const acceptBtn = document.getElementById('cookie-accept');
  const rejectBtn = document.getElementById('cookie-reject');
  if (!banner || !acceptBtn || !rejectBtn) return;

  const existing = localStorage.getItem(COOKIE_CONSENT_KEY);
  if (!existing) {
    banner.classList.remove('hidden');
  }

  acceptBtn.addEventListener('click', () => {
    localStorage.setItem(COOKIE_CONSENT_KEY, JSON.stringify({
      analytics: true,
      timestamp: new Date().toISOString(),
      version: '2026-03',
    }));
    banner.classList.add('hidden');
  });

  rejectBtn.addEventListener('click', () => {
    localStorage.setItem(COOKIE_CONSENT_KEY, JSON.stringify({
      analytics: false,
      timestamp: new Date().toISOString(),
      version: '2026-03',
    }));
    banner.classList.add('hidden');
  });
}

function initWhatsappFloat() {
  const button = document.getElementById('whatsapp-float');
  if (!button) return;

  const desktopMedia = window.matchMedia('(min-width: 769px)');
  const updateVisibility = () => {
    if (!desktopMedia.matches) {
      button.classList.add('is-visible');
      return;
    }
    button.classList.toggle('is-visible', window.scrollY > 200);
  };

  updateVisibility();
  window.addEventListener('scroll', updateVisibility, { passive: true });
  if (typeof desktopMedia.addEventListener === 'function') {
    desktopMedia.addEventListener('change', updateVisibility);
  } else if (typeof desktopMedia.addListener === 'function') {
    desktopMedia.addListener(updateVisibility);
  }
}

document.addEventListener('DOMContentLoaded', initWhatsappFloat);
