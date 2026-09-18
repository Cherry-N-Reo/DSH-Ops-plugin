---
name: sre-nginx
description: Follow the local nginx runbook to inspect a bound service and distinguish diagnosis from approved restart.
---

# nginx SRE

Use `asset_lookup` and `runbook_search` with query `nginx`. Use `service_inspect` for the inventory-listed nginx service. Bound log output by service, time and line count. Diagnose before proposing reload/restart. A successful restart alone does not prove recovery: inspect status and compare incident evidence afterwards. Do not remove caches/logs or change network policy without the independent approval workflow. Do not invent health URLs or execute an unsupported command through another tool.
