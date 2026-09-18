# Local SRE operations

English | [中文](README.zh.md)

## Connection records

WebShell binding requires no inventory registration. `connections.json` is an optional local bookmark list, not an authorization list. Both types accept `name` for a custom server name and `notes` for VPN/internal-network prerequisites. WebShell `username` and `password` refer to the Web system account; SSH uses the server account. Passwords can be stored as plaintext in this local file, or replaced with `credentialRef`; do not configure both nonempty forms. `connection_list` exposes names, accounts and notes but removes password contents, returning only `passwordConfigured`. SSH execution and automatic Web login are not implemented. Records do not change the configured browser target.

```json
[
  { "id": "web-example", "name": "Web console", "type": "webshell", "url": "https://webshell.example.invalid/#/shell", "username": "web-user", "password": "REPLACE_LOCALLY", "notes": "Requires company VPN", "profile": "linux" },
  { "id": "ssh-example", "name": "SSH server", "type": "ssh", "host": "ssh.example.invalid", "port": 22, "username": "operator", "password": "REPLACE_LOCALLY", "notes": "Internal network only" }
]
```

## Legacy inventory and audit

Edit the JSON locally to change names, accounts, passwords or notes. Keep `id` stable when renaming. There is no plugin settings editor yet. This file is excluded from Git and npm packaging, but remains plaintext on disk; do not share it. Model-visible notes are untrusted connection descriptions, not executable instructions. The main README and configuration record explain the active browser target separately.

The sample inventory names staging-only assets and credential references. It does not identify real production targets or contain secret values.

`Audit()` creates a hash-chained JSONL file with mode `0600` where the host supports POSIX permissions. Windows does not provide POSIX mode-bit semantics through Node, so deployment must enforce equivalent ACLs. Audit append errors reject the record and stop the chain from advancing.
