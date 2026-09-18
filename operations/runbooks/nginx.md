# Nginx service runbook

This runbook applies only to the sample staging asset. It contains no production hostname, address, account, or credential.

1. Confirm the asset and maintenance approval before acting.
2. Validate configuration with `nginx -t`.
3. Inspect status with `systemctl status nginx --no-pager`.
4. Reload with `systemctl reload nginx` only after validation succeeds.
5. Record asset ID, phase, outcome, and hashes in the redacted audit log; do not record command output or secrets.
