# LexReclama Web

## Security hardening for `/admin`

### App-level IP allowlist (server.js)

`/admin` now requires both:
- Basic Auth (`ADMIN_USER` + `ADMIN_PASSWORD`)
- Source IP in `ADMIN_ALLOWED_IPS`

Environment variable:

```bash
ADMIN_ALLOWED_IPS=127.0.0.1,::1,10.8.0.0/24
```

Notes:
- Supports exact IPs and IPv4 CIDR blocks.
- Default is `127.0.0.1,::1`.
- Every `/admin` attempt is written to stdout with `[audit][admin]` for audit trails.

### Nginx restriction + dedicated audit log

Use the snippet at [`nginx/admin-hardening.conf`](./nginx/admin-hardening.conf) in your TLS virtual host.

Deployment checklist:
1. Add allowed VPN CIDRs in the `location = /admin` block.
2. Validate config: `sudo nginx -t`
3. Reload: `sudo systemctl reload nginx`
4. Verify denied access from non-allowed IP returns `403`.
5. Verify audit log entries in `/var/log/nginx/lex_admin_access.log`.
