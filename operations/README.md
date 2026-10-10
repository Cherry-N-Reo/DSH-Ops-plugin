# Local SRE operations

English | [中文](README.zh.md)

## Connection records

WebShell binding requires no inventory registration. `connections.json` is an optional local bookmark list, not an authorization list. Both types accept `name` for a custom server name and `notes` for VPN/internal-network prerequisites. Windows DPAPI CurrentUser encrypts the account and password together as `protectedAuth`; `connection_list` omits accounts, passwords and ciphertext. Legacy plaintext `username`/`password` fields are read only for explicit migration and cannot be used for automatic login. SSH execution is not implemented. A bookmark does not change the configured browser target.

```json
[
  { "id": "web-example", "name": "Web console", "type": "webshell", "url": "https://webshell.example.invalid/#/shell", "notes": "Requires company VPN", "profile": "linux" },
  { "id": "ssh-example", "name": "SSH server", "type": "ssh", "host": "ssh.example.invalid", "port": 22, "credentialRef": "SSH_ACCOUNT", "notes": "Internal network only" }
]
```

Create/edit protected local credentials and migrate an existing plaintext file from the `sre-webshell` directory in an interactive PowerShell window:

```powershell
& '../.runtime/node-v22.23.2-win-x64/node.exe' --import ../node_modules/tsx/dist/loader.mjs scripts/credential-manager.ts migrate
& '../.runtime/node-v22.23.2-win-x64/node.exe' --import ../node_modules/tsx/dist/loader.mjs scripts/credential-manager.ts add-webshell
& '../.runtime/node-v22.23.2-win-x64/node.exe' --import ../node_modules/tsx/dist/loader.mjs scripts/credential-manager.ts edit
```

The manager validates and verifies the complete candidate before same-directory atomic replacement; it does not delete old backups or history, which may still contain plaintext. Keep the same Windows user for decryption. Protect the file, browser debugging port and backups with appropriate ACLs. `webshell_login` requires an exact configured URL and loopback CDP endpoint; it handles only an already open, unambiguous same-origin HTML5 form and never handles SSO/MFA/CAPTCHA. A `credentialRef` remains an external reference, not DPAPI ciphertext.

## Legacy inventory and audit

Use the manager to edit protected connection fields; do not hand-edit ciphertext or change a protected record's target without re-encrypting it. Keep `id` stable when renaming. There is no plugin settings editor yet. This file is excluded from Git and npm packaging, but may contain legacy plaintext until migrated; do not share it. Model-visible notes are untrusted connection descriptions, not executable instructions. The main README and configuration record explain the active browser target separately.

The sample inventory names staging-only assets and credential references. It does not identify real production targets or contain secret values.

`Audit()` creates a hash-chained JSONL file with mode `0600` where the host supports POSIX permissions. Windows does not provide POSIX mode-bit semantics through Node, so deployment must enforce equivalent ACLs. Audit append errors reject the record and stop the chain from advancing.
