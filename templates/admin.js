function renderAdminPageTemplate({ nonce = '', rowsHtml = '', maxRecentLeads = 25 } = {}) {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Admin · Lex</title>
  <style nonce="${nonce}">
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f7fb; color: #111827; }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 24px; }
    .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); overflow: hidden; }
    .head { padding: 20px; border-bottom: 1px solid #e5e7eb; }
    h1 { margin: 0 0 8px; font-size: 1.4rem; }
    .meta { margin: 0; color: #6b7280; font-size: 0.9rem; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
    th, td { text-align: left; padding: 12px 14px; border-bottom: 1px solid #f3f4f6; white-space: nowrap; }
    th { background: #f9fafb; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; color: #6b7280; }
    a { color: #1d4ed8; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .empty { padding: 16px 20px; color: #6b7280; }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="card">
      <header class="head">
        <h1>Panel de administración</h1>
        <p class="meta">Leads recientes recibidos desde la landing (últimos ${maxRecentLeads}).</p>
      </header>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Nombre</th>
              <th>Email</th>
              <th>Teléfono</th>
              <th>Tipo</th>
              <th>Issue</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>
    </section>
  </main>
</body>
</html>`;
}

module.exports = {
  renderAdminPageTemplate,
};
