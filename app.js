/* ─── CONFIG ──────────────────────────────────────────────── */
const SUBMIT_ENDPOINT = '/submit-lead';
const CHECKOUT_SESSION_ENDPOINT = '/create-checkout-session';
const CHECKOUT_CONFIRM_ENDPOINT = '/confirm-checkout';
const COOKIE_CONSENT_KEY = 'lex_cookie_consent_v1';
const PRIVACY_POLICY_VERSION = '2026-03';
const CONTACT_PHONE_DISPLAY = '+34 900 000 000';
const IDEMPOTENCY_WINDOW_MS = 60 * 1000;
const CSRF_INPUT_NAME = 'csrfToken';

let leadSubmissionInFlight = false;
let currentLeadIdempotency = null;

function readCookie(name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : '';
}

function getCsrfToken() {
  const input = document.querySelector(`input[name="${CSRF_INPUT_NAME}"]`);
  const inputToken = input?.value?.trim() || '';
  return inputToken || readCookie('lex_csrf_token') || '';
}

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

function trackAdsLeadConversion() {
  const tracking = window.__LEX_TRACKING || {};
  const sendTo = typeof tracking.adsConversionSendTo === 'string' ? tracking.adsConversionSendTo.trim() : '';
  if (!sendTo || typeof window.gtag !== 'function') return;
  window.gtag('event', 'conversion', {
    send_to: sendTo,
    value: Number(tracking.adsConversionValue) || 49.0,
    currency: tracking.adsConversionCurrency || 'EUR',
  });
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
  const onScrollThrottled = rafThrottle(onScroll);
  onScroll();
  window.addEventListener('scroll', onScrollThrottled, { passive: true });
}

/* ─── CALCULATORS ─────────────────────────────────────────── */
function calcDeuda() {
  const importe = parseFloat(document.getElementById('deuda-importe').value) || 0;
  const meses = parseInt(document.getElementById('deuda-meses').value) || 0;
  const docs = document.getElementById('deuda-docs').value;

  if (importe <= 0) { hideResult(); return; }

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
    if (hipoteca <= 0) { hideResult(); return; }
    // Gastos hipotecarios típicos: ~1.5-2% del capital (notaría, registro, gestoría, AJD)
    total = hipoteca * 0.018;
    nota = `Estimación de gastos hipotecarios recuperables (notaría, registro, gestoría) para una hipoteca de ${fmt(hipoteca)}. Porcentaje medio del 1,8% sobre capital.`;

  } else if (tipo === 'suelo') {
    const anios = parseInt(document.getElementById('banco-anios').value) || 0;
    const cuota = parseFloat(document.getElementById('banco-cuota').value) || 0;
    if (anios <= 0 || cuota <= 0) { hideResult(); return; }
    // Diferencia estimada con cláusula suelo: ~8-12% de cuota mensual durante el período
    total = cuota * 12 * anios * 0.10;
    nota = `Diferencia estimada entre lo pagado con cláusula suelo y el tipo legal correspondiente, durante ${anios} años con cuota de ${fmt(cuota)}/mes. Esta cifra puede variar significativamente según el tipo suelo y el Euribor aplicable en cada período.`;

  } else if (tipo === 'irph') {
    const anios = parseInt(document.getElementById('banco-anios').value) || 0;
    const cuota = parseFloat(document.getElementById('banco-cuota').value) || 0;
    if (anios <= 0 || cuota <= 0) { hideResult(); return; }
    // Exceso IRPH vs Euribor+1: ~15% de cuota media anual
    total = cuota * 12 * anios * 0.15;
    nota = `Exceso estimado pagado por IRPH respecto a Euribor + 1% durante ${anios} años. Requiere análisis del cuadro de amortización para cifra exacta.`;

  } else if (tipo === 'comision') {
    const comision = parseFloat(document.getElementById('banco-comision').value) || 0;
    if (comision <= 0) { hideResult(); return; }
    total = comision;
    nota = `La comisión de apertura es directamente el importe recuperable si el tribunal la declara abusiva. Hay jurisprudencia favorable del TJUE.`;
  }

  showResult(total, nota);
}

function calcMulta() {
  const importe = parseFloat(document.getElementById('multa-importe').value) || 0;
  const motivo = document.getElementById('multa-motivo').value;

  if (importe <= 0) { hideResult(); return; }

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

function hideResult() {
  document.getElementById('calc-result')?.classList.add('hidden');
}

function fmt(n) {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function rafThrottle(fn) {
  let ticking = false;
  return (...args) => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      fn(...args);
    });
  };
}

function debounce(fn, waitMs) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), waitMs);
  };
}

function initBankLeadMagnetCalculator() {
  const root = document.getElementById('bank-lead-calculator');
  if (!root) return;

  const typeInput = document.getElementById('bank-calc-type');
  const yearInput = document.getElementById('bank-calc-year');
  const bankInput = document.getElementById('bank-calc-entity');
  const amountInput = document.getElementById('bank-calc-amount');
  const resultBox = document.getElementById('bank-lead-result');

  const summaryEl = document.getElementById('bank-calc-summary');
  const totalEl = document.getElementById('bank-calc-total');
  const gastosEl = document.getElementById('bank-calc-gastos');
  const sueloEl = document.getElementById('bank-calc-suelo');
  const irphEl = document.getElementById('bank-calc-irph');
  const noteEl = document.getElementById('bank-calc-note');
  const ctaEl = document.getElementById('bank-calc-cta');

  if (!typeInput || !yearInput || !bankInput || !amountInput || !resultBox) return;

  const formatRange = (min, max) => `${fmt(min)} – ${fmt(max)}`;
  const RECOVERY_BANDS = {
    gastos: { min: 1500, max: 4000 },
    suelo: { min: 3000, max: 15000 },
    irph: { min: 5000, max: 20000 },
  };
  const bankRiskFactor = (rawName) => {
    const value = String(rawName || '').toLowerCase();
    if (!value) return 1;
    if (value.includes('santander') || value.includes('bbva') || value.includes('caixa')) return 1.08;
    if (value.includes('sabadell') || value.includes('bankia') || value.includes('kutxa')) return 1.04;
    return 1;
  };

  const renderNow = () => {
    const mortgageType = typeInput.value;
    const signedYear = parseInt(yearInput.value, 10);
    const bankName = bankInput.value.trim();
    const principal = parseFloat(amountInput.value);

    if (!mortgageType || !bankName || !Number.isFinite(signedYear) || !Number.isFinite(principal) || principal < 30000) {
      resultBox.classList.add('hidden');
      return;
    }

    const currentYear = new Date().getFullYear();
    const minYear = 1990;
    const maxYear = currentYear;
    const ageFactor = clamp((currentYear - signedYear) / 16, 0.35, 1);
    const entityFactor = bankRiskFactor(bankName);
    const variableMortgage = mortgageType === 'variable';
    const amountFactor = clamp((principal - 80000) / 260000, 0, 1);
    const weightedFactor = clamp((ageFactor * 0.45) + (amountFactor * 0.45) + ((entityFactor - 1) * 5 * 0.1), 0, 1);

    if (Number.isFinite(minYear)) yearInput.min = String(minYear);
    if (Number.isFinite(maxYear)) yearInput.max = String(maxYear);
    if (signedYear < minYear || signedYear > maxYear) {
      resultBox.classList.add('hidden');
      return;
    }

    const gastosBandWidth = RECOVERY_BANDS.gastos.max - RECOVERY_BANDS.gastos.min;
    const gastosMin = clamp(
      RECOVERY_BANDS.gastos.min + (gastosBandWidth * 0.25 * weightedFactor),
      RECOVERY_BANDS.gastos.min,
      RECOVERY_BANDS.gastos.max - 350
    );
    const gastosMax = clamp(
      gastosMin + 900 + (gastosBandWidth * 0.45 * weightedFactor),
      gastosMin + 300,
      RECOVERY_BANDS.gastos.max
    );

    let sueloMin = 0;
    let sueloMax = 0;
    let irphMin = 0;
    let irphMax = 0;
    let note = 'Resultado orientativo sujeto a revisión documental (escritura y cuadro de amortización).';

    if (variableMortgage && signedYear <= 2013) {
      const sueloBandWidth = RECOVERY_BANDS.suelo.max - RECOVERY_BANDS.suelo.min;
      const irphBandWidth = RECOVERY_BANDS.irph.max - RECOVERY_BANDS.irph.min;
      sueloMin = clamp(
        RECOVERY_BANDS.suelo.min + (sueloBandWidth * (0.18 + (weightedFactor * 0.35))),
        RECOVERY_BANDS.suelo.min,
        RECOVERY_BANDS.suelo.max - 1200
      );
      sueloMax = clamp(
        sueloMin + 1800 + (sueloBandWidth * (0.28 + (weightedFactor * 0.25))),
        sueloMin + 1000,
        RECOVERY_BANDS.suelo.max
      );
      irphMin = clamp(
        RECOVERY_BANDS.irph.min + (irphBandWidth * (0.16 + (weightedFactor * 0.3))),
        RECOVERY_BANDS.irph.min,
        RECOVERY_BANDS.irph.max - 1500
      );
      irphMax = clamp(
        irphMin + 2200 + (irphBandWidth * (0.26 + (weightedFactor * 0.24))),
        irphMin + 1200,
        RECOVERY_BANDS.irph.max
      );
      note = 'Hipoteca variable pre-2014: suele haber mayor potencial en cláusula suelo e IRPH.';
    } else if (variableMortgage) {
      const recentFactor = clamp(weightedFactor * 0.6, 0, 0.6);
      sueloMin = clamp(RECOVERY_BANDS.suelo.min * 0.2 * recentFactor, 0, RECOVERY_BANDS.suelo.min * 0.4);
      sueloMax = clamp(
        sueloMin + 1000 + (RECOVERY_BANDS.suelo.max - RECOVERY_BANDS.suelo.min) * (0.08 + recentFactor),
        1200,
        RECOVERY_BANDS.suelo.max * 0.65
      );
      irphMin = clamp(RECOVERY_BANDS.irph.min * 0.18 * recentFactor, 0, RECOVERY_BANDS.irph.min * 0.35);
      irphMax = clamp(
        irphMin + 1400 + (RECOVERY_BANDS.irph.max - RECOVERY_BANDS.irph.min) * (0.1 + recentFactor),
        1600,
        RECOVERY_BANDS.irph.max * 0.6
      );
      note = 'Hipoteca variable reciente: suele concentrarse en gastos y posibles diferenciales aplicados.';
    } else {
      note = 'Hipoteca fija: la recuperación potencial suele concentrarse en gastos de formalización y otras cláusulas contractuales.';
    }

    const totalMin = gastosMin + sueloMin + irphMin;
    const totalMax = gastosMax + sueloMax + irphMax;

    summaryEl.textContent = `${bankName} · ${signedYear} · ${fmt(principal)}`;
    gastosEl.textContent = formatRange(gastosMin, gastosMax);
    sueloEl.textContent = sueloMax > 0 ? formatRange(sueloMin, sueloMax) : 'No aplica según los datos introducidos';
    irphEl.textContent = irphMax > 0 ? formatRange(irphMin, irphMax) : 'No aplica según los datos introducidos';
    totalEl.textContent = formatRange(totalMin, totalMax);
    noteEl.textContent = note;
    resultBox.classList.remove('hidden');

    if (ctaEl) {
      ctaEl.dataset.calcSummary = `Hipoteca ${mortgageType} firmada en ${signedYear} con ${bankName}. Estimación orientativa: ${formatRange(totalMin, totalMax)}.`;
    }
  };

  const render = debounce(renderNow, 300);

  [typeInput, yearInput, bankInput, amountInput].forEach((input) => {
    input.addEventListener('input', render);
    input.addEventListener('change', render);
  });

  if (ctaEl) {
    ctaEl.addEventListener('click', () => {
      const modalDescription = document.getElementById('modal-descripcion');
      if (!modalDescription) return;
      const summary = ctaEl.dataset.calcSummary || '';
      if (summary) modalDescription.value = summary;
    });
  }
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

function inferClaimTypeFromPath(pathname) {
  const route = String(pathname || '').toLowerCase();
  if (route.startsWith('/recurrir-multas') || route.includes('/multa')) return 'multa';
  if (route.startsWith('/clausulas-bancarias') || route.includes('/hipoteca') || route.includes('/clausula')) return 'banco';
  if (route.startsWith('/reclamacion-deudas') || route.includes('/monitorio') || route.includes('/deuda')) return 'deuda';
  return 'otro';
}

function ensureContactLinks() {
  const contactHref = '/contacto/';

  const navLinks = document.querySelector('.nav-links');
  if (navLinks && !navLinks.querySelector('a[href="/contacto/"], a[href="/contacto"]')) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = contactHref;
    a.textContent = 'Contacto';
    li.appendChild(a);
    navLinks.appendChild(li);
  }

  const navMobile = document.querySelector('.nav-mobile-inner');
  if (navMobile && !navMobile.querySelector('a[href="/contacto/"], a[href="/contacto"]')) {
    const a = document.createElement('a');
    a.href = contactHref;
    a.textContent = 'Contacto';
    const mobilePrimaryBtn = navMobile.querySelector('a.btn');
    if (mobilePrimaryBtn) {
      navMobile.insertBefore(a, mobilePrimaryBtn);
    } else {
      navMobile.appendChild(a);
    }
  }

  document.querySelectorAll('.footer-links').forEach((footerLinks) => {
    if (footerLinks.querySelector('a[href="/contacto/"], a[href="/contacto"]')) return;
    const a = document.createElement('a');
    a.href = contactHref;
    a.textContent = 'Contacto';
    footerLinks.appendChild(a);
  });
}

/* ─── LEAD FORM SUBMISSION ────────────────────────────────── */
function requiresUpfrontPayment(tipo) {
  return tipo === 'deuda' || tipo === 'multa';
}

function generateIdempotencyKey() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  const randomChunk = Math.random().toString(36).slice(2, 12);
  return `legacy-${Date.now()}-${randomChunk}`;
}

function getLeadIdempotencyKey() {
  const now = Date.now();
  if (currentLeadIdempotency && (now - currentLeadIdempotency.createdAtMs) < IDEMPOTENCY_WINDOW_MS) {
    return currentLeadIdempotency.key;
  }
  const key = generateIdempotencyKey();
  currentLeadIdempotency = {
    key,
    createdAtMs: now,
  };
  return key;
}

async function submitLead(event) {
  event.preventDefault();
  if (leadSubmissionInFlight) return;
  leadSubmissionInFlight = true;

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
    idempotencyKey: getLeadIdempotencyKey(),
    csrfToken: getCsrfToken(),
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
    trackAdsLeadConversion();
    currentLeadIdempotency = null;
    form.reset();
    successEl.classList.remove('hidden');
    successEl.querySelector('p').textContent = 'Hemos recibido su solicitud y nos pondremos en contacto con usted en 24-48 horas laborables. Sus datos serán tratados conforme a la Política de Privacidad.';
    form.classList.add('hidden');
  } catch (err) {
    console.error('Lead submission error:', err);
    errorEl.classList.remove('hidden');
  } finally {
    leadSubmissionInFlight = false;
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
    body: JSON.stringify({ leadToken, sessionId, csrfToken: getCsrfToken() }),
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
    trackAdsLeadConversion();
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

function createContactModalElement() {
  const modal = document.createElement('div');
  modal.id = 'contact-modal';
  modal.className = 'contact-modal hidden';
  modal.setAttribute('aria-hidden', 'true');
  modal.innerHTML = `
    <div class="contact-modal-backdrop" data-contact-modal-close></div>
    <div class="contact-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="contact-modal-title">
      <button type="button" class="contact-modal-close" aria-label="Cerrar formulario" data-contact-modal-close>
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <line x1="4" y1="4" x2="16" y2="16"></line>
          <line x1="16" y1="4" x2="4" y2="16"></line>
        </svg>
      </button>
      <div class="contact-modal-body">
        <p class="eyebrow">Consulta rápida</p>
        <h2 id="contact-modal-title">Cuéntanos tu caso y te orientamos hoy mismo</h2>
        <p class="contact-modal-sub">Te respondemos en menos de 24 horas laborables.</p>

        <div class="modal-trust" aria-hidden="true">
          <span class="modal-trust-item">
            <span class="trust-icon-wrap"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>
            <span>Gratuito</span>
          </span>
          <span class="modal-trust-item">
            <span class="trust-icon-wrap"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>
            <span>Confidencial</span>
          </span>
          <span class="modal-trust-item">
            <span class="trust-icon-wrap trust-icon-wrap--accent"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></span>
            <span>Respuesta en 24h</span>
          </span>
        </div>

        <form class="contacto-form contact-modal-form" id="modal-lead-form">
          <input type="hidden" name="${CSRF_INPUT_NAME}" value="${getCsrfToken()}" />
          <div class="form-row">
            <div class="field">
              <label for="modal-nombre">Nombre</label>
              <input type="text" id="modal-nombre" name="nombre" placeholder="Tu nombre" required />
            </div>
            <div class="field">
              <label for="modal-email">Email</label>
              <input type="email" id="modal-email" name="email" placeholder="tu@email.com" required />
            </div>
          </div>

          <div class="field">
            <label for="modal-telefono">Teléfono</label>
            <input type="tel" id="modal-telefono" name="telefono" placeholder="+34 600 000 000" />
          </div>

          <div class="field">
            <label for="modal-tipo-reclamacion">¿Sobre qué quieres consultar?</label>
            <select id="modal-tipo-reclamacion" name="tipo">
              <option value="otro">Consulta general</option>
              <option value="deuda">Reclamación de deuda impagada</option>
              <option value="banco">Cláusulas bancarias abusivas</option>
              <option value="multa">Impugnación de multa / sanción</option>
            </select>
          </div>

          <div class="field">
            <label for="modal-descripcion">Cuéntanos brevemente tu situación (opcional)</label>
            <textarea id="modal-descripcion" name="descripcion" rows="3" placeholder="Importe, entidad o administración implicada, y en qué punto está el caso."></textarea>
          </div>

          <div class="field checkbox-field">
            <label class="checkbox-label">
              <input type="checkbox" id="modal-privacidad" required />
              <span>He leído y acepto la <a href="/politica-privacidad" target="_blank" rel="noopener noreferrer">Política de Privacidad</a>.</span>
            </label>
          </div>

          <button type="submit" class="btn btn-primary btn-full" id="modal-submit-btn">
            <span id="modal-submit-text">Quiero que analicen mi caso</span>
            <span id="modal-submit-loading" class="hidden">Enviando…</span>
          </button>

          <p class="contact-modal-link">
            ¿Prefieres completar el formulario detallado?
            <a href="/contacto/">Ir a la página de contacto</a>
          </p>

          <div id="modal-form-success" class="form-success hidden">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            <div>
              <strong>¡Recibido!</strong>
              <p>Solicitud recibida. Si te urge, llámanos al ${CONTACT_PHONE_DISPLAY}.</p>
            </div>
          </div>

          <div id="modal-form-error" class="form-error hidden">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <span>Error al enviar. Escríbenos a <a href="mailto:info@lexreclama.es">info@lexreclama.es</a></span>
          </div>
        </form>
      </div>
    </div>
  `;
  return modal;
}

async function submitModalLead(event) {
  event.preventDefault();
  if (leadSubmissionInFlight) return;
  leadSubmissionInFlight = true;

  const form = document.getElementById('modal-lead-form');
  const submitBtn = document.getElementById('modal-submit-btn');
  const submitText = document.getElementById('modal-submit-text');
  const submitLoading = document.getElementById('modal-submit-loading');
  const successEl = document.getElementById('modal-form-success');
  const errorEl = document.getElementById('modal-form-error');

  if (!form || !submitBtn || !submitText || !submitLoading || !successEl || !errorEl) {
    leadSubmissionInFlight = false;
    return;
  }

  const data = {
    nombre: document.getElementById('modal-nombre')?.value.trim() || '',
    email: document.getElementById('modal-email')?.value.trim() || '',
    telefono: document.getElementById('modal-telefono')?.value.trim() || '',
    tipo: document.getElementById('modal-tipo-reclamacion')?.value || 'otro',
    descripcion: document.getElementById('modal-descripcion')?.value.trim() || '',
    privacidadAceptada: !!document.getElementById('modal-privacidad')?.checked,
    comercialAceptada: false,
    consentimientoTimestamp: new Date().toISOString(),
    versionPolitica: PRIVACY_POLICY_VERSION,
    idempotencyKey: getLeadIdempotencyKey(),
    csrfToken: getCsrfToken(),
  };

  const tipoLabel = {
    deuda: 'Reclamación de deuda impagada',
    banco: 'Cláusulas bancarias abusivas',
    multa: 'Impugnación de multa',
    otro: 'Consulta general',
  }[data.tipo] || 'Consulta general';

  submitBtn.disabled = true;
  submitText.classList.add('hidden');
  submitLoading.classList.remove('hidden');
  successEl.classList.add('hidden');
  errorEl.classList.add('hidden');

  try {
    await createPaperclipLead(data, tipoLabel);
    trackGtagEvent('generate_lead', { event_category: 'modal_contacto', event_label: data.tipo });
    trackAdsLeadConversion();
    currentLeadIdempotency = null;
    form.reset();
    successEl.classList.remove('hidden');
  } catch (err) {
    console.error('Modal lead submission error:', err);
    errorEl.classList.remove('hidden');
  } finally {
    leadSubmissionInFlight = false;
    submitBtn.disabled = false;
    submitText.classList.remove('hidden');
    submitLoading.classList.add('hidden');
  }
}

function initContactModal() {
  const triggerSelector = [
    'a[href="#contacto"]',
    'a[href="/#contacto"]',
    'a[href="/index.html#contacto"]',
    'a[data-open-contact-modal="true"]',
  ].join(', ');
  const triggers = Array.from(document.querySelectorAll(triggerSelector));
  if (!triggers.length) return;

  const modal = createContactModalElement();
  document.body.appendChild(modal);

  let lastFocusedTrigger = null;

  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

  const closeModal = () => {
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('contact-modal-open');
    lastFocusedTrigger?.focus();
  };

  const openModal = (tipo, triggerEl) => {
    lastFocusedTrigger = triggerEl || document.activeElement;
    const typeInput = document.getElementById('modal-tipo-reclamacion');
    const successEl = document.getElementById('modal-form-success');
    const errorEl = document.getElementById('modal-form-error');
    const form = document.getElementById('modal-lead-form');
    if (typeInput) typeInput.value = tipo || inferClaimTypeFromPath(window.location.pathname);
    if (successEl) successEl.classList.add('hidden');
    if (errorEl) errorEl.classList.add('hidden');
    if (form && form.classList.contains('hidden')) form.classList.remove('hidden');
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('contact-modal-open');
    document.getElementById('modal-nombre')?.focus();
  };

  modal.querySelectorAll('[data-contact-modal-close]').forEach((element) => {
    element.addEventListener('click', closeModal);
  });

  document.addEventListener('keydown', (event) => {
    if (modal.classList.contains('hidden')) return;
    if (event.key === 'Escape') { closeModal(); return; }
    if (event.key === 'Tab') {
      const focusable = Array.from(modal.querySelectorAll(FOCUSABLE));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey) {
        if (document.activeElement === first) { event.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
  });

  document.getElementById('modal-lead-form')?.addEventListener('submit', submitModalLead);

  triggers.forEach((trigger) => {
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      const targetTipo = trigger.getAttribute('data-claim-type') || inferClaimTypeFromPath(window.location.pathname);
      openModal(targetTipo, trigger);
    });
  });
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
  initNavScrollEffect();
  ensureContactLinks();
  initBankLeadMagnetCalculator();
  initContactModal();
  initScrollAnimations();
  initScrollProgress();
  initCounters();
  initLiveCalc();
  initCalcButtons();
  initFormValidation();
  toggleBancoFields();
  initCookieBanner();
  initWhatsappFloat();
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
  const updateVisibilityThrottled = rafThrottle(updateVisibility);

  updateVisibility();
  window.addEventListener('scroll', updateVisibilityThrottled, { passive: true });
  if (typeof desktopMedia.addEventListener === 'function') {
    desktopMedia.addEventListener('change', updateVisibility);
  } else if (typeof desktopMedia.addListener === 'function') {
    desktopMedia.addListener(updateVisibility);
  }
}

/* ─── SCROLL PROGRESS ────────────────────────────────────── */
function initScrollProgress() {
  const bar = document.getElementById('scroll-progress');
  if (!bar) return;
  function update() {
    const scrolled = document.documentElement.scrollTop;
    const total = document.documentElement.scrollHeight - document.documentElement.clientHeight;
    bar.style.width = total > 0 ? (scrolled / total * 100) + '%' : '0%';
  }
  window.addEventListener('scroll', rafThrottle(update), { passive: true });
  update();
}

/* ─── ANIMATED COUNTERS ──────────────────────────────────── */
function initCounters() {
  const els = document.querySelectorAll('[data-count-to]');
  if (!els.length) return;
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const el = entry.target;
      const target = +el.dataset.countTo;
      const prefix = el.dataset.prefix || '';
      const suffix = el.dataset.suffix || '';
      const dur = 1400;
      const start = performance.now();
      function tick(now) {
        const p = Math.min((now - start) / dur, 1);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = prefix + Math.round(eased * target) + suffix;
        if (p < 1) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
      observer.unobserve(el);
    });
  }, { threshold: 0.6 });
  els.forEach(el => observer.observe(el));
}

/* ─── CALCULATOR BUTTONS ─────────────────────────────────── */
function initCalcButtons() {
  const wire = (id, event, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(event, fn);
  };
  wire('area-link-banco', 'click', () => setClaimType('banco'));
  wire('area-link-deuda', 'click', () => setClaimType('deuda'));
  wire('area-link-multa', 'click', () => setClaimType('multa'));
  wire('btn-calc-deuda', 'click', calcDeuda);
  wire('btn-calc-banco', 'click', calcBanco);
  wire('btn-calc-multa', 'click', calcMulta);
  wire('calc-cta-link', 'click', prefillFromCalc);
  wire('banco-tipo', 'change', toggleBancoFields);
}

/* ─── LIVE CALCULATOR ────────────────────────────────────── */
function initLiveCalc() {
  function addLive(ids, primaryId, calcFn) {
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', () => {
        const primary = document.getElementById(primaryId);
        if (primary && parseFloat(primary.value) > 0) calcFn();
        else hideResult();
      });
    });
  }
  addLive(['deuda-importe', 'deuda-meses', 'deuda-docs'], 'deuda-importe', calcDeuda);
  addLive(['banco-tipo', 'banco-hipoteca', 'banco-anios', 'banco-cuota', 'banco-comision'], 'banco-hipoteca', calcBanco);
  addLive(['multa-importe', 'multa-tipo', 'multa-motivo'], 'multa-importe', calcMulta);
}

/* ─── FORM INLINE VALIDATION ─────────────────────────────── */
function initFormValidation() {
  const form = document.getElementById('lead-form');
  if (!form) return;
  form.addEventListener('submit', submitLead);

  const descripcionInput = document.getElementById('descripcion');
  const isDescriptionRequired = !!(descripcionInput && descripcionInput.required);

  const rules = [
    { id: 'nombre',           validate: v => v.trim().length >= 2,                       msg: 'Introduce tu nombre' },
    { id: 'email',            validate: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()), msg: 'Email no válido' },
    { id: 'tipo-reclamacion', validate: v => v !== '',                                    msg: 'Selecciona el tipo de reclamación' },
    { id: 'descripcion',      validate: v => !isDescriptionRequired || v.trim().length >= 10, msg: 'Cuéntanos un poco más (mínimo 10 caracteres)' },
  ];

  rules.forEach(({ id, validate, msg }) => {
    const input = document.getElementById(id);
    if (!input) return;
    const field = input.closest('.field');
    if (!field) return;

    // Add error message element
    const errEl = document.createElement('span');
    errEl.className = 'field-error-msg';
    errEl.textContent = msg;
    field.appendChild(errEl);

    function check() {
      const valid = validate(input.value);
      field.classList.toggle('field-valid', valid);
      field.classList.toggle('field-error', !valid);
    }

    input.addEventListener('blur', () => {
      if (!input.value) { field.classList.remove('field-valid', 'field-error'); return; }
      check();
    });
    input.addEventListener('input', () => {
      if (field.classList.contains('field-error') || field.classList.contains('field-valid')) check();
    });
  });
}
