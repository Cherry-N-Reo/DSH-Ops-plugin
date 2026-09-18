---
name: sre-mysql
description: Inspect a bound MySQL systemd service without exposing credentials or executing SQL clients.
---

# MySQL SRE

Search the local `mysql` runbook and use service inspection only for an inventory-listed service. Check bounded disk, memory and systemd evidence first. SQL clients and database-specific destructive statements are not supported by this MVP; do not route them through interpreters or hidden credential paste. Never put passwords in commands, runbooks, terminal output or agent memory. Credential injection requires an operator-confirmed hidden prompt and leaves Enter to the operator. Keep critical actions and credential injection disabled until real-target acceptance.
