function sweepPortalState({ portalAuthCodes, portalSessions }) {
  const now = Date.now();
  for (const [caseId, auth] of portalAuthCodes) {
    if (auth.expiresAtMs <= now || auth.used) portalAuthCodes.delete(caseId);
  }
  for (const [token, session] of portalSessions) {
    if (session.expiresAtMs <= now) portalSessions.delete(token);
  }
}

module.exports = {
  sweepPortalState,
};
