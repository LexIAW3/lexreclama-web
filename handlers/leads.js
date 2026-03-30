function createLeadHandlers({
  createIssueForLead,
  uploadDocumentToOcr,
  resolveIdempotentRequest,
  recentLeadSubmissions,
  subscribeContactInBrevo,
  sendLeadMagnetEmail,
  maskEmail,
  detectTestLeadReason,
  paidClaimTypes,
  leadMagnetPdfPath,
  privacyPolicyVersion,
}) {
  function requiresUpfrontPayment(tipo) {
    return tipo in paidClaimTypes;
  }

  function normalizeLeadPayload(body) {
    const nombre = String(body?.nombre || '').trim();
    const email = String(body?.email || '').trim();
    const telefono = String(body?.telefono || '').trim();
    const tipo = String(body?.tipo || '').trim();
    const descripcion = String(body?.descripcion || '').trim();
    const privacidadAceptada = body?.privacidadAceptada === true;
    const comercialAceptada = body?.comercialAceptada === true;
    const consentimientoTimestamp = String(body?.consentimientoTimestamp || '').trim();
    const versionPolitica = String(body?.versionPolitica || '').trim();
    const idempotencyKey = String(body?.idempotencyKey || '').trim();

    if (!nombre || !email || !tipo || !privacidadAceptada || !consentimientoTimestamp || !versionPolitica) {
      return { ok: false, error: 'Campos requeridos: nombre, email, tipo y consentimiento RGPD' };
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { ok: false, error: 'Dirección de email inválida' };
    }
    if (nombre.length > 120) return { ok: false, error: 'Nombre demasiado largo' };
    if (email.length > 254) return { ok: false, error: 'Email demasiado largo' };
    if (telefono.length > 30) return { ok: false, error: 'Teléfono demasiado largo' };
    if (descripcion.length > 4000) return { ok: false, error: 'Descripción demasiado larga (máx. 4000 caracteres)' };
    if (idempotencyKey && idempotencyKey.length > 128) {
      return { ok: false, error: 'idempotencyKey inválida' };
    }

    const ALLOWED_TIPOS = ['deuda', 'banco', 'multa', 'otro'];
    if (!ALLOWED_TIPOS.includes(tipo)) {
      return { ok: false, error: 'Tipo de reclamación no válido' };
    }

    const tipoLabel = {
      deuda: 'Reclamación de deuda impagada',
      banco: 'Cláusulas bancarias abusivas',
      multa: 'Impugnación de multa',
      otro: 'Consulta general',
    }[tipo];

    // Vertical-specific fields (all optional; capped to prevent oversized issues)
    const str = (v, max = 200) => String(body?.[v] || '').trim().slice(0, max);
    let vertical = {};
    if (tipo === 'multa') {
      vertical = {
        multa_expediente: str('multa_expediente', 60),
        multa_importe: str('multa_importe', 20),
        multa_fecha: str('multa_fecha', 20),
        multa_tipo_infraccion: str('multa_tipo_infraccion', 200),
        multa_organismo: str('multa_organismo', 100),
      };
    } else if (tipo === 'banco') {
      vertical = {
        banco_tipo_clausula: str('banco_tipo_clausula', 80),
        banco_nombre: str('banco_nombre', 100),
        banco_anio_firma: str('banco_anio_firma', 6),
        banco_cuota_mensual: str('banco_cuota_mensual', 20),
        banco_irph_referenciado: str('banco_irph_referenciado', 20),
      };
    } else if (tipo === 'deuda') {
      vertical = {
        deuda_tipo_deuda: str('deuda_tipo_deuda', 80),
        deuda_importe_reclamado: str('deuda_importe_reclamado', 20),
        deuda_nombre_deudor: str('deuda_nombre_deudor', 200),
        deuda_tiene_contrato: str('deuda_tiene_contrato', 10),
      };
    }

    return {
      ok: true,
      value: {
        nombre,
        email,
        telefono,
        tipo,
        tipoLabel,
        descripcion,
        privacidadAceptada,
        comercialAceptada,
        consentimientoTimestamp,
        versionPolitica,
        idempotencyKey,
        ...vertical,
      },
    };
  }

  function normalizeApiLeadPayload(body) {
    const nombre = String(body?.nombre || '').trim();
    const email = String(body?.email || '').trim();
    const tipoReclamacion = String(body?.tipo_reclamacion || body?.tipo || '').trim().toLowerCase();
    const descripcion = String(body?.descripcion || '').trim();

    if (!nombre || !email || !tipoReclamacion) {
      return { ok: false, error: 'Campos requeridos: nombre, email y tipo_reclamacion' };
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { ok: false, error: 'Dirección de email inválida' };
    }
    if (nombre.length > 120) return { ok: false, error: 'Nombre demasiado largo' };
    if (email.length > 254) return { ok: false, error: 'Email demasiado largo' };
    if (descripcion.length > 4000) return { ok: false, error: 'Descripción demasiado larga (máx. 4000 caracteres)' };

    const payload = {
      ...body,
      nombre,
      email,
      tipo: tipoReclamacion,
      descripcion,
      privacidadAceptada: body?.privacidadAceptada === true || String(body?.privacidadAceptada || '').toLowerCase() === 'true',
      comercialAceptada: body?.comercialAceptada === true || String(body?.comercialAceptada || '').toLowerCase() === 'true',
      consentimientoTimestamp: String(body?.consentimientoTimestamp || '').trim() || new Date().toISOString(),
      versionPolitica: String(body?.versionPolitica || '').trim() || privacyPolicyVersion,
      idempotencyKey: String(body?.idempotencyKey || '').trim() || '',
    };

    if (!payload.privacidadAceptada) {
      return { ok: false, error: 'Debes aceptar la política de privacidad' };
    }

    return { ok: true, value: payload };
  }

  async function handleSubmitLead(req, res) {
    const body = req.parsedBody;
    const uploadedFiles = req.uploadedFiles || [];

    const leadData = normalizeLeadPayload(body);
    if (!leadData.ok) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: leadData.error }));
      return;
    }

    if (requiresUpfrontPayment(leadData.value.tipo)) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Este tipo requiere pago previo. Inicia checkout primero.' }));
      return;
    }

    // Silently discard test leads so they don't pollute the claims manager queue.
    const testLeadReason = detectTestLeadReason(leadData.value);
    if (testLeadReason) {
      console.log(`[test-lead] silently discarded (${testLeadReason}): ${maskEmail(leadData.value.email)}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, issueId: null, identifier: null, deduplicated: false, test: true }));
      return;
    }

    try {
      const result = await resolveIdempotentRequest({
        scope: 'submit-lead',
        key: leadData.value.idempotencyKey,
        store: recentLeadSubmissions,
        execute: async () => {
          const created = await createIssueForLead(leadData.value, { paid: false });
          // Upload files to OCR server after issue is created
          if (uploadedFiles.length > 0) {
            for (const file of uploadedFiles) {
              await uploadDocumentToOcr(created.id, file);
            }
          }
          return { issueId: created.id, identifier: created.identifier };
        },
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        issueId: result.value.issueId,
        identifier: result.value.identifier,
        deduplicated: result.deduplicated,
      }));
    } catch (err) {
      console.error('Lead submission error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No se pudo procesar la solicitud en este momento.' }));
    }
  }

  async function handleApiLead(req, res) {
    const basePayload = normalizeApiLeadPayload(req.parsedBody || {});
    if (!basePayload.ok) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: basePayload.error }));
      return;
    }

    req.parsedBody = basePayload.value;
    req.uploadedFiles = [];
    await handleSubmitLead(req, res);
  }

  function normalizeSubscribePayload(payload) {
    const email = String(payload?.email || '').trim().toLowerCase();
    const nombre = String(payload?.nombre || '').trim();
    const tipoReclamacion = String(payload?.tipo_reclamacion || '').trim().toLowerCase();
    const privacidadAceptada = payload?.privacidadAceptada === true || String(payload?.privacidadAceptada || '').toLowerCase() === 'true';
    const consentimientoTimestamp = String(payload?.consentimientoTimestamp || '').trim();
    const versionPolitica = String(payload?.versionPolitica || '').trim();
    const leadMagnet = String(payload?.leadMagnet || '').trim().toLowerCase();
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!emailOk) return { ok: false, error: 'Email no válido' };
    if (nombre.length > 120) return { ok: false, error: 'Nombre demasiado largo' };
    if (tipoReclamacion.length > 80) return { ok: false, error: 'Tipo de reclamación demasiado largo' };
    if (leadMagnet.length > 80) return { ok: false, error: 'Lead magnet no válido' };
    if (!privacidadAceptada || !consentimientoTimestamp || !versionPolitica) {
      return { ok: false, error: 'Debes aceptar la política de privacidad para suscribirte' };
    }
    if (leadMagnet && leadMagnet !== 'guia-bancaria') {
      return { ok: false, error: 'Lead magnet no soportado' };
    }
    return {
      ok: true,
      value: {
        email,
        nombre,
        tipoReclamacion,
        leadMagnet,
        privacidadAceptada,
        consentimientoTimestamp,
        versionPolitica,
      },
    };
  }

  async function handleSubscribe(req, res) {
    const parsed = normalizeSubscribePayload(req.parsedBody);
    if (!parsed.ok) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: parsed.error }));
      return;
    }

    // Silently discard test/invalid addresses so they don't hit Brevo and return 5xx.
    const testLeadReason = detectTestLeadReason(parsed.value);
    if (testLeadReason) {
      console.log(`[test-lead] subscribe silently discarded (${testLeadReason}): ${maskEmail(parsed.value.email)}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    try {
      await subscribeContactInBrevo(parsed.value);
      try {
        await sendLeadMagnetEmail(parsed.value);
      } catch (emailErr) {
        console.error(`[lead-magnet] email send failed for ${parsed.value.email}: ${emailErr.message}`);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const response = { success: true };
      if (parsed.value.leadMagnet === 'guia-bancaria') {
        response.downloadUrl = leadMagnetPdfPath;
      }
      res.end(JSON.stringify(response));
    } catch (err) {
      const message = String(err?.message || 'Error al suscribirse').toLowerCase();
      const status = message.includes('brevo_api_key no configurada') ? 503 : 502;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No se pudo completar la suscripción ahora mismo.' }));
    }
  }

  return {
    requiresUpfrontPayment,
    normalizeLeadPayload,
    handleSubmitLead,
    handleApiLead,
    handleSubscribe,
  };
}

module.exports = {
  createLeadHandlers,
};
