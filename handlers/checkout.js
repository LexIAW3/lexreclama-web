'use strict';

/**
 * DT-3 Fase E — handlers de Stripe Checkout extraídos de server.js.
 * Factory con DI: recibe todas las dependencias y devuelve los handlers.
 */

const crypto = require('crypto');

/**
 * @param {object} deps
 * @param {Function} deps.normalizeLeadPayload
 * @param {Function} deps.requiresUpfrontPayment
 * @param {Function} deps.resolveIdempotentRequest
 * @param {Map}      deps.recentCheckoutCreations
 * @param {Map}      deps.pendingCheckoutLeads
 * @param {Map}      deps.completedCheckoutLeads
 * @param {Function} deps.createStripeCheckoutSession
 * @param {Function} deps.readStripeCheckoutSession
 * @param {Function} deps.sweepPendingCheckoutLeads
 * @param {Function} deps.createIssueForLead
 * @param {object}   deps.paidClaimTypes
 */
function createCheckoutHandlers({
  normalizeLeadPayload,
  requiresUpfrontPayment,
  resolveIdempotentRequest,
  recentCheckoutCreations,
  pendingCheckoutLeads,
  completedCheckoutLeads,
  createStripeCheckoutSession,
  readStripeCheckoutSession,
  sweepPendingCheckoutLeads,
  createIssueForLead,
  paidClaimTypes,
}) {
  async function handleCreateCheckoutSession(req, res) {
    const body = req.parsedBody;

    const leadData = normalizeLeadPayload(body);
    if (!leadData.ok) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: leadData.error }));
      return;
    }

    if (!requiresUpfrontPayment(leadData.value.tipo)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Este tipo no requiere checkout previo' }));
      return;
    }

    sweepPendingCheckoutLeads();

    try {
      const result = await resolveIdempotentRequest({
        scope: 'create-checkout-session',
        key: leadData.value.idempotencyKey,
        store: recentCheckoutCreations,
        execute: async () => {
          const leadToken = crypto.randomUUID();
          const stripeSession = await createStripeCheckoutSession(req, leadToken, leadData.value);
          pendingCheckoutLeads.set(leadToken, {
            leadData: leadData.value,
            createdAtMs: Date.now(),
            stripeSessionId: stripeSession.id,
          });
          return {
            leadToken,
            checkoutUrl: stripeSession.url,
            checkoutSessionId: stripeSession.id,
          };
        },
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        leadToken: result.value.leadToken,
        checkoutUrl: result.value.checkoutUrl,
        checkoutSessionId: result.value.checkoutSessionId,
        deduplicated: result.deduplicated,
      }));
    } catch (err) {
      console.error('Stripe checkout session error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No se pudo iniciar el proceso de pago. Inténtalo de nuevo en unos minutos.' }));
    }
  }

  async function handleConfirmCheckout(req, res) {
    const body = req.parsedBody;

    const leadToken = String(body?.leadToken || '').trim();
    const sessionId = String(body?.sessionId || '').trim();
    if (!leadToken || !sessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'leadToken y sessionId son obligatorios' }));
      return;
    }

    const completed = completedCheckoutLeads.get(leadToken);
    if (completed) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, issueId: completed.issueId, identifier: completed.identifier, deduplicated: true }));
      return;
    }

    const pending = pendingCheckoutLeads.get(leadToken);
    if (!pending) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'La sesión de checkout no existe o ha expirado' }));
      return;
    }
    if (pending.stripeSessionId !== sessionId) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'sessionId no coincide con el checkout pendiente' }));
      return;
    }

    try {
      const stripeSession = await readStripeCheckoutSession(sessionId);
      const paid = stripeSession.payment_status === 'paid';
      const tokenMatches = String(stripeSession.metadata?.leadToken || '') === leadToken;
      if (!paid || !tokenMatches) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Pago aún no confirmado por Stripe' }));
        return;
      }

      const amountLabel = paidClaimTypes[pending.leadData.tipo]?.baseAmountLabel || 'importe inicial';
      const issue = await createIssueForLead(pending.leadData, {
        paid: true,
        amountLabel,
        checkoutSessionId: stripeSession.id,
      });

      const payload = { issueId: issue.id, identifier: issue.identifier, completedAtMs: Date.now() };
      completedCheckoutLeads.set(leadToken, payload);
      pendingCheckoutLeads.delete(leadToken);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, issueId: payload.issueId, identifier: payload.identifier }));
    } catch (err) {
      console.error('Confirm checkout error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No se pudo confirmar el pago en este momento.' }));
    }
  }

  return { handleCreateCheckoutSession, handleConfirmCheckout };
}

module.exports = { createCheckoutHandlers };
