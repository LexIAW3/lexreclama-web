function normalizeCaseIdentifier(input) {
  return String(input || '').trim().toUpperCase();
}

function isCaseIdentifierValid(identifier) {
  return /^LEX-\d{1,8}$/.test(identifier);
}

function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!local || !domain) return '***';
  const safeLocal = `${local.slice(0, 2)}***`;
  return `${safeLocal}@${domain}`;
}

function mapIssueStatusLabel(status) {
  const labels = {
    todo: 'En revision',
    in_progress: 'En curso',
    blocked: 'Pendiente de documentacion',
    done: 'Resuelto',
  };
  return labels[status] || 'En revision';
}

function mapIssueToPortalCase(issue, messages = []) {
  const status = String(issue?.status || 'todo');
  const stepsByStatus = {
    todo: ['Recibido', 'En revision', 'Analisis legal', 'Resolucion', 'Cierre'],
    in_progress: ['Recibido', 'En revision', 'Analisis legal', 'Resolucion', 'Cierre'],
    blocked: ['Recibido', 'Pendiente de documentacion', 'Analisis legal', 'Resolucion', 'Cierre'],
    done: ['Recibido', 'Analisis legal', 'Resolucion', 'Cierre completado'],
  };
  const activeStepByStatus = {
    todo: 'En revision',
    in_progress: 'Analisis legal',
    blocked: 'Pendiente de documentacion',
    done: 'Cierre completado',
  };
  const steps = stepsByStatus[status] || stepsByStatus.todo;
  const activeStep = activeStepByStatus[status] || steps[0];
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title || 'Caso',
    status,
    statusLabel: mapIssueStatusLabel(status),
    updatedAt: issue.updatedAt || new Date().toISOString(),
    steps,
    activeStep,
    messages,
    documents: [],
    nextAction: status === 'blocked'
      ? 'Necesitamos documentación adicional para seguir avanzando. Te avisaremos con instrucciones concretas.'
      : status === 'done'
        ? 'Tu reclamación está cerrada. Puedes descargar los documentos finales desde esta área.'
        : 'Nuestro equipo está revisando tu expediente. El siguiente hito se reflejará aquí en cuanto se complete.',
  };
}

module.exports = {
  normalizeCaseIdentifier,
  isCaseIdentifierValid,
  maskEmail,
  mapIssueToPortalCase,
};
