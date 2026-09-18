# Third-party notices

## DeepSeek Harness

This plugin targets DeepSeek Harness 0.1.6-alpha.2 from the local checkout. DSH, Cordis and Schemastery are MIT licensed; their licenses remain in the checkout. The plugin uses the official named-plugin, Config schema, dependency injection, effect disposal, tool registry and approval APIs. It does not modify the agent loop.

## computer-user

Only `input.ps1` and `capture.ps1` are copied unchanged from [jing-hy/computer-user](https://github.com/jing-hy/computer-user/tree/2fbf383b49fe08e466d4d1caba659fb42b61de6b), version 0.3.6, commit `2fbf383b49fe08e466d4d1caba659fb42b61de6b`, MIT license. The original license is in `third-party/computer-user/LICENSE`. The generic tools, settings, mode toggles, clipboard typing and community process runner are not mounted or imported. Our process runner uses stdin, bounded cancellation, scrubbed environment and awaits process exit.

The reviewed scripts use Win32 input and System.Drawing screenshots. They do not perform network requests. Their SendInput return counts are not checked, so remote marker and copied-output verification remain mandatory; input success is never inferred from the helper's `ok` alone. They use system DPI awareness, which does not establish per-monitor DPI correctness on every mixed-DPI arrangement. These arrangements require real-target testing before use.

## YAML

Inventory parsing uses `yaml` 2.9.0 (ISC license), already pinned by the DSH dependency installation. No vector database or secret-storage package is added.

## Upgrade policy

No dependency follows `latest`. Upgrade only after reviewing source and rerunning policy, approval, lifecycle, Copy/Paste, scroll continuity, DPI and target-browser acceptance. The real WebShell tests are separate from keyless/mock-driver tests.
