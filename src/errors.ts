const messages = {
  TARGET_NOT_FOUND: 'Configured WebShell tab was not found through browser accessibility. Keep it open in Chrome or Edge with accessibility enabled; no navigation or shell command was attempted.',
  TARGET_MISMATCH: 'The active browser URL is not the configured WebShell target. Screenshot/input refused.',
  FOCUS_FAILED: 'Windows did not allow the configured WebShell window to become foreground. Screenshot/input refused.',
  APPROVAL_REJECTED: 'Human approval was rejected. Check the session preset: approval=never rejects explicit requests without prompting. No automatic retry.',
  APPROVAL_UNAVAILABLE: 'No human approval interface is available. Operation refused.',
  APPROVAL_CANCELLED: 'Human approval was cancelled. Operation refused.',
  TARGET_REQUIRED: 'Automatic screenshots require an operator-configured targetUrl.',
  OBSERVATION_EXPIRED: 'Observation is missing or expired. Obtain a fresh terminal_observe result before binding; no remote command was submitted.',
  CONNECTION_NOT_FOUND: 'Connection bookmark not found. Use connection_list, or omit connectionId to bind the observed WebShell directly. Registration is not required.',
  SSH_NOT_SUPPORTED: 'SSH records are metadata only. This plugin does not yet provide SSH execution; do not bind them to a browser terminal.',
  INPUT_UNCERTAIN: 'Input is partial, hidden, mismatched, has an IME candidate, or was not confidently identified. No replay, fallback, clearing, or Enter. Inspect the terminal and recover the binding manually.',
  INPUT_OBSERVATION_STALE: 'Input verification requires the latest pending screenshot. Use terminal_collect to refresh evidence without sending input.',
  INPUT_NOT_PENDING: 'No verifiable input is pending. Collect the existing command output, or inspect and recover a blocked binding; do not resubmit.',
  INPUT_HELPER_UNCERTAIN: 'The input helper failed and an empty line cannot establish that no characters are still pending. No automatic retry or keyboard fallback; inspect and recover.',
  KEYBOARD_NOT_ACCEPTED: 'The physical-key fallback was not accepted. Inspect terminal focus/input handling and recover manually; no further input attempt.',
  CRITICAL_ENVIRONMENT_UNCERTAIN: 'The visual remote user/cwd probe is incomplete or invalid. Critical command was not submitted. Inspect and recover the binding.',
  CRITICAL_ENVIRONMENT_CHANGED: 'Remote user/cwd changed after final approval. Critical command was not submitted. Approval is invalid; inspect and recover the binding.',
} as const

/** Only fixed, reviewed messages may escape the desktop transaction into model history. */
export class SreError extends Error {
  constructor(readonly code: keyof typeof messages) { super(`${code}: ${messages[code]}`) }
}
export function bridgeError(code: unknown): SreError | undefined {
  return typeof code === 'string' && Object.hasOwn(messages, code)
    ? new SreError(code as keyof typeof messages) : undefined
}
