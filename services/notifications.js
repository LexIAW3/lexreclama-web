'use strict';

/**
 * Notification service: Brevo (email/CRM) + WhatsApp Business API.
 * Factory function injects config and shared utilities.
 */

function isValidEmailAddress(email) {
  const value = String(email || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Normaliza un número de teléfono español al formato E.164 (+34XXXXXXXXX).
 * Devuelve null si el número no es válido o no se puede normalizar.
 */
function normalizePhoneForWhatsApp(raw) {
  if (!raw) return null;
  // Strip spaces, dashes, dots, parentheses
  let digits = String(raw).replace(/[\s\-().+]/g, '');
  if (!digits) return null;
  // If already has country code (e.g. 0034... or 34...)
  if (digits.startsWith('0034')) digits = digits.slice(4);
  else if (digits.startsWith('34') && digits.length === 11) digits = digits.slice(2);
  // Spanish mobile/landline: 9 digits starting with 6, 7, 8 or 9
  if (!/^[6789]\d{8}$/.test(digits)) return null;
  return `34${digits}`;
}

function extractClientEmail(issue) {
  const description = String(issue?.description || '');
  const emailLine = description.match(/\*\*Email:\*\*\s*([^\s<]+)/i);
  if (emailLine && emailLine[1]) return emailLine[1].trim().toLowerCase();
  const genericMatch = description.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (genericMatch && genericMatch[0]) return genericMatch[0].trim().toLowerCase();
  return '';
}

function createNotificationService({
  brevoApiKey,
  brevoListId,
  brevoLeadMagnetTemplateId,
  brevoApiBase,
  leadMagnetDownloadUrl,
  whatsappBusinessToken,
  whatsappPhoneNumberId,
  whatsappTemplateName,
  whatsappTemplateLang,
  fetchWithTimeout,
  escapeHtml,
  detectTestLeadReason,
}) {
  async function subscribeContactInBrevo(payload) {
    if (!brevoApiKey) throw new Error('BREVO_API_KEY no configurada');

    const attributes = {};
    if (payload.nombre) attributes.NOMBRE = payload.nombre;
    if (payload.tipoReclamacion) attributes.TIPO_RECLAMACION = payload.tipoReclamacion;
    if (payload.leadMagnet === 'guia-bancaria') attributes.SOURCE = 'lead-magnet';
    attributes.PRIVACIDAD_ACEPTADA = 'true';
    attributes.CONSENTIMIENTO_TIMESTAMP = payload.consentimientoTimestamp;
    attributes.VERSION_POLITICA = payload.versionPolitica;

    const body = {
      email: payload.email,
      updateEnabled: true,
    };
    if (Object.keys(attributes).length > 0) body.attributes = attributes;
    if (Number.isInteger(brevoListId) && brevoListId > 0) {
      body.listIds = [brevoListId];
    }

    const brevoRes = await fetchWithTimeout(`${brevoApiBase}/contacts`, {
      method: 'POST',
      headers: {
        'api-key': brevoApiKey,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (brevoRes.ok) return;

    let brevoErr = {};
    try {
      brevoErr = await brevoRes.json();
    } catch {
      brevoErr = {};
    }
    const brevoMessage = String(brevoErr?.message || '').toLowerCase();
    const duplicateError = brevoRes.status === 400 && brevoMessage.includes('already exist');
    if (duplicateError) return;
    throw new Error(brevoErr?.message || `Brevo HTTP ${brevoRes.status}`);
  }

  async function sendLeadMagnetEmail(payload) {
    if (!brevoApiKey) throw new Error('BREVO_API_KEY no configurada');
    if (payload.leadMagnet !== 'guia-bancaria') return;

    const body = {
      sender: { name: 'LexReclama', email: 'info@lexreclama.es' },
      to: [{ email: payload.email }],
    };

    if (Number.isInteger(brevoLeadMagnetTemplateId) && brevoLeadMagnetTemplateId > 0) {
      body.templateId = brevoLeadMagnetTemplateId;
      body.params = {
        NOMBRE: payload.nombre || 'cliente',
        DOWNLOAD_URL: leadMagnetDownloadUrl,
      };
    } else {
      body.subject = 'Tu guía gratuita para reclamar cláusulas bancarias';
      body.htmlContent = [
        `<p>Hola ${escapeHtml(payload.nombre || 'cliente')},</p>`,
        '<p>Gracias por solicitar la guía gratuita de LexReclama.</p>',
        `<p><a href="${escapeHtml(leadMagnetDownloadUrl)}" target="_blank" rel="noopener noreferrer"><strong>Descargar guía en PDF</strong></a></p>`,
        '<p>Si quieres, también podemos revisar tu caso sin coste y sin compromiso.</p>',
        '<p>Equipo LexReclama<br/>info@lexreclama.es</p>',
      ].join('');
      body.textContent = [
        `Hola ${payload.nombre || 'cliente'},`,
        '',
        'Gracias por solicitar la guia gratuita de LexReclama.',
        `Descargala aqui: ${leadMagnetDownloadUrl}`,
        '',
        'Si quieres, tambien podemos revisar tu caso sin coste y sin compromiso.',
        '',
        'Equipo LexReclama',
        'info@lexreclama.es',
      ].join('\n');
    }

    const res = await fetchWithTimeout(`${brevoApiBase}/smtp/email`, {
      method: 'POST',
      headers: {
        'api-key': brevoApiKey,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return;
    let brevoErr = {};
    try {
      brevoErr = await res.json();
    } catch {
      brevoErr = {};
    }
    throw new Error(brevoErr?.message || `Brevo email HTTP ${res.status}`);
  }

  async function sendPortalCodeEmail(email, caseId, code) {
    if (!brevoApiKey) return false;
    const body = {
      sender: { name: 'LexReclama', email: 'info@lexreclama.es' },
      to: [{ email }],
      subject: `Código de acceso para ${caseId}`,
      htmlContent: `<p>Tu codigo de acceso para <strong>${escapeHtml(caseId)}</strong> es:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${escapeHtml(code)}</p><p>Caduca en 10 minutos y solo se puede usar una vez.</p>`,
      textContent: `Tu codigo de acceso para ${caseId} es: ${code}\n\nCaduca en 10 minutos y solo se puede usar una vez.`,
    };
    const res = await fetchWithTimeout(`${brevoApiBase}/smtp/email`, {
      method: 'POST',
      headers: {
        'api-key': brevoApiKey,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    return res.ok;
  }

  async function sendLeadConfirmationEmail(leadData, identifier) {
    const email = String(leadData?.email || '').trim().toLowerCase();
    if (!brevoApiKey) return false;
    if (!isValidEmailAddress(email)) return false;
    if (detectTestLeadReason(leadData)) return false;

    const caseIdentifier = String(identifier || 'tu expediente').trim();
    const subject = `Tu reclamación en LexReclama — Referencia ${caseIdentifier}`;
    const htmlContent = [
      `<p>Hola ${escapeHtml(leadData?.nombre || 'cliente')},</p>`,
      `<p>Hemos recibido correctamente tu reclamación (<strong>${escapeHtml(leadData?.tipoLabel || 'Consulta legal')}</strong>).</p>`,
      `<p>Tu referencia de expediente es <strong>${escapeHtml(caseIdentifier)}</strong>.</p>`,
      '<p>Puedes seguir el estado de tu caso en el portal cliente: <a href="https://app.lexreclama.es">https://app.lexreclama.es</a></p>',
      '<p>Plazo estimado para análisis inicial: <strong>3-5 días hábiles</strong>.</p>',
      '<p>Gracias por confiar en LexReclama.</p>',
      '<p>El equipo de LexReclama<br/>info@lexreclama.es</p>',
    ].join('');

    const textContent = [
      `Hola ${leadData?.nombre || 'cliente'},`,
      '',
      `Hemos recibido correctamente tu reclamación (${leadData?.tipoLabel || 'Consulta legal'}).`,
      `Tu referencia de expediente es: ${caseIdentifier}`,
      '',
      'Puedes seguir el estado de tu caso en el portal cliente:',
      'https://app.lexreclama.es',
      '',
      'Plazo estimado para análisis inicial: 3-5 días hábiles.',
      '',
      'Gracias por confiar en LexReclama.',
      'El equipo de LexReclama',
      'info@lexreclama.es',
    ].join('\n');

    const body = {
      sender: { name: 'LexReclama', email: 'info@lexreclama.es' },
      to: [{ email }],
      subject,
      htmlContent,
      textContent,
    };

    const res = await fetchWithTimeout(`${brevoApiBase}/smtp/email`, {
      method: 'POST',
      headers: {
        'api-key': brevoApiKey,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    return res.ok;
  }

  /**
   * Envía el mensaje de acompañamiento de WhatsApp Business (Paso 2 del flujo de contacto).
   * Usa Meta WhatsApp Business Cloud API con el template pre-aprobado.
   * No lanza excepciones — registra el error y devuelve false en caso de fallo.
   */
  async function sendWhatsAppWelcome(leadData) {
    if (!whatsappBusinessToken || !whatsappPhoneNumberId) return false;
    const to = normalizePhoneForWhatsApp(leadData?.telefono);
    if (!to) return false;
    if (detectTestLeadReason(leadData)) return false;

    const nombre = String(leadData?.nombre || 'cliente').trim();
    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: whatsappTemplateName,
        language: { code: whatsappTemplateLang },
        components: [
          {
            type: 'body',
            parameters: [{ type: 'text', text: nombre }],
          },
        ],
      },
    };

    try {
      const res = await fetchWithTimeout(
        `https://graph.facebook.com/v22.0/${whatsappPhoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${whatsappBusinessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      );
      if (res.ok) return true;
      const err = await res.json().catch(() => ({}));
      console.error(`[whatsapp] send failed for +${to}: HTTP ${res.status} — ${err?.error?.message || 'unknown'}`);
      return false;
    } catch (err) {
      console.error(`[whatsapp] send exception for +${to}: ${err.message}`);
      return false;
    }
  }

  return {
    subscribeContactInBrevo,
    sendLeadMagnetEmail,
    sendPortalCodeEmail,
    sendLeadConfirmationEmail,
    sendWhatsAppWelcome,
  };
}

module.exports = { createNotificationService, isValidEmailAddress, normalizePhoneForWhatsApp, extractClientEmail };
