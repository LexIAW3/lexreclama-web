/**
 * Paperclip API service — crea issues, consulta expedientes y sube documentos al OCR.
 * Inyecta todas las dependencias externas para testabilidad.
 */
const crypto = require('crypto');

// Construye las líneas de descripción vertical según el tipo de reclamación.
function buildVerticalDescription(leadData) {
  const lines = [];
  if (leadData.tipo === 'multa') {
    lines.push('**Datos de la multa:**');
    if (leadData.multa_expediente) lines.push(`- Expediente: ${leadData.multa_expediente}`);
    if (leadData.multa_importe) lines.push(`- Importe: ${leadData.multa_importe} €`);
    if (leadData.multa_fecha) lines.push(`- Fecha notificación: ${leadData.multa_fecha}`);
    if (leadData.multa_tipo_infraccion) lines.push(`- Tipo infracción: ${leadData.multa_tipo_infraccion}`);
    if (leadData.multa_organismo) lines.push(`- Organismo: ${leadData.multa_organismo}`);
  } else if (leadData.tipo === 'banco') {
    lines.push('**Datos bancarios:**');
    if (leadData.banco_tipo_clausula) lines.push(`- Cláusula: ${leadData.banco_tipo_clausula}`);
    if (leadData.banco_nombre) lines.push(`- Banco: ${leadData.banco_nombre}`);
    if (leadData.banco_anio_firma) lines.push(`- Año firma: ${leadData.banco_anio_firma}`);
    if (leadData.banco_cuota_mensual) lines.push(`- Cuota mensual: ${leadData.banco_cuota_mensual} €`);
  } else if (leadData.tipo === 'deuda') {
    lines.push('**Datos de la deuda:**');
    if (leadData.deuda_tipo_deuda) lines.push(`- Tipo: ${leadData.deuda_tipo_deuda}`);
    if (leadData.deuda_importe_reclamado) lines.push(`- Importe: ${leadData.deuda_importe_reclamado} €`);
    if (leadData.deuda_nombre_deudor) lines.push(`- Deudor: ${leadData.deuda_nombre_deudor}`);
    if (leadData.deuda_tiene_contrato) lines.push(`- Contrato/factura: ${leadData.deuda_tiene_contrato === 'si' ? 'Sí' : 'No'}`);
  }
  return lines.length > 1 ? lines : [];
}

function createPaperclipService({
  paperclipApi,
  companyId,
  submitApiKey,
  fetchWithTimeout,
  fetchTimeoutApiMs,
  fetchTimeoutOcrMs,
  gestorAgentId,
  goalId,
  ocrServer,
  ocrSharedSecret,
  sendLeadConfirmationEmail,
  sendWhatsAppWelcome,
  maskEmail,
  recentLeads,
  maxRecentLeads,
}) {
  async function uploadDocumentToOcr(issueId, file) {
    try {
      // Build multipart manually using node's built-in capabilities
      const boundary = `----FormBoundary${crypto.randomBytes(16).toString('hex')}`;
      const CRLF = '\r\n';
      const parts = [
        `--${boundary}${CRLF}`,
        `Content-Disposition: form-data; name="file"; filename="${file.originalname}"${CRLF}`,
        `Content-Type: ${file.mimetype}${CRLF}`,
        CRLF,
      ];
      const bodyStart = Buffer.from(parts.join(''));
      const bodyEnd = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);
      const fullBody = Buffer.concat([bodyStart, file.buffer, bodyEnd]);

      const ocrUrl = new URL(`/api/documents/upload?issueId=${encodeURIComponent(issueId)}`, ocrServer);
      const res = await fetchWithTimeout(ocrUrl.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(fullBody.length),
          ...(ocrSharedSecret ? { 'x-ocr-shared-secret': ocrSharedSecret } : {}),
        },
        body: fullBody,
      }, fetchTimeoutOcrMs);
      if (!res.ok) {
        const err = await res.text().catch(() => '');
        console.warn(`[ocr] upload failed for ${file.originalname}: ${res.status} ${err}`);
        return null;
      }
      return await res.json();
    } catch (err) {
      console.warn(`[ocr] upload error for ${file.originalname}: ${err.message}`);
      return null;
    }
  }

  async function createIssueForLead(leadData, paymentMeta = { paid: false }) {
    const verticalLines = buildVerticalDescription(leadData);
    const issue = {
      title: `Lead: ${leadData.tipoLabel} — ${leadData.nombre}`,
      description: [
        `**Tipo de reclamación:** ${leadData.tipoLabel}`,
        `**Nombre:** ${leadData.nombre}`,
        `**Email:** ${leadData.email}`,
        leadData.telefono ? `**Teléfono:** ${leadData.telefono}` : null,
        `**Consentimiento privacidad:** ${leadData.privacidadAceptada ? 'Sí' : 'No'}`,
        `**Consentimiento comercial:** ${leadData.comercialAceptada ? 'Sí' : 'No'}`,
        `**Timestamp consentimiento:** ${leadData.consentimientoTimestamp}`,
        `**Versión política aceptada:** ${leadData.versionPolitica}`,
        ...(verticalLines.length ? ['', ...verticalLines] : []),
        '',
        '**Descripción del caso:**',
        leadData.descripcion || '(sin descripción)',
        '',
        paymentMeta.paid
          ? `**Pago inicial:** Confirmado (${paymentMeta.amountLabel || 'Stripe Checkout'})`
          : '**Pago inicial:** No requerido',
        paymentMeta.checkoutSessionId ? `**Stripe checkout session:** ${paymentMeta.checkoutSessionId}` : null,
        '',
        '---',
        '*Lead recibido desde la landing page web.*',
      ].filter((line) => line !== null).join('\n'),
      status: 'todo',
      priority: 'medium',
      assigneeAgentId: gestorAgentId,
      goalId,
    };

    const apiRes = await fetchWithTimeout(`${paperclipApi}/api/companies/${companyId}/issues`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${submitApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(issue),
    }, fetchTimeoutApiMs);
    const data = await apiRes.json();
    if (!apiRes.ok) throw new Error(data.error || `HTTP ${apiRes.status}`);

    try {
      const sent = await sendLeadConfirmationEmail(leadData, data.identifier || data.id || 'tu expediente');
      if (!sent) {
        console.warn(`[lead-email] confirmation not sent for ${maskEmail(leadData.email)} (identifier: ${data.identifier || 'n/a'})`);
      }
    } catch (err) {
      console.error(`[lead-email] confirmation failed for ${maskEmail(leadData.email)}: ${err.message}`);
    }

    // Paso 2 del flujo de contacto: mensaje de acompañamiento por WhatsApp Business (D+0)
    if (leadData.telefono) {
      const waSent = await sendWhatsAppWelcome(leadData);
      if (!waSent) {
        console.warn(`[whatsapp] welcome not sent for ${maskEmail(leadData.email)} (identifier: ${data.identifier || 'n/a'})`);
      }
    }

    recentLeads.unshift({
      createdAt: new Date().toISOString(),
      nombre: leadData.nombre,
      email: leadData.email,
      telefono: leadData.telefono,
      tipoLabel: leadData.tipoLabel,
      issueId: data.id || null,
      identifier: data.identifier || null,
    });
    if (recentLeads.length > maxRecentLeads) recentLeads.length = maxRecentLeads;
    return data;
  }

  async function fetchIssueByIdentifier(caseId) {
    const res = await fetchWithTimeout(
      `${paperclipApi}/api/companies/${companyId}/issues?q=${encodeURIComponent(caseId)}&limit=20`,
      {
        headers: {
          Authorization: `Bearer ${submitApiKey}`,
        },
      },
      fetchTimeoutApiMs,
    );
    const data = await res.json().catch(() => []);
    if (!res.ok || !Array.isArray(data)) return null;
    const exact = data.find((issue) => String(issue.identifier || '').toUpperCase() === caseId);
    return exact || null;
  }

  async function fetchIssueComments(issueId) {
    const res = await fetchWithTimeout(`${paperclipApi}/api/issues/${encodeURIComponent(issueId)}/comments`, {
      headers: {
        Authorization: `Bearer ${submitApiKey}`,
      },
    }, fetchTimeoutApiMs);
    const data = await res.json().catch(() => []);
    if (!res.ok || !Array.isArray(data)) return [];
    return data
      .filter((comment) => String(comment.body || '').trimStart().startsWith('[CLIENTE]'))
      .map((comment) => ({
        author: comment.authorAgentId ? 'Despacho' : 'Cliente',
        fromClient: !comment.authorAgentId,
        body: String(comment.body || '')
          .replace(/^\s*\[CLIENTE\]\s*/i, '')
          .replace(/^#+\s*/gm, '')
          .slice(0, 450),
      }));
  }

  return { uploadDocumentToOcr, createIssueForLead, fetchIssueByIdentifier, fetchIssueComments };
}

module.exports = { createPaperclipService };
