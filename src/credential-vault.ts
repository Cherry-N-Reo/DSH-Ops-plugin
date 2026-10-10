import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

/** Credentials returned only to the caller performing the selected connection's login. */
export type ConnectionAuth = { username: string; password?: string }

/** Windows CurrentUser protection adapter, injectable for deterministic tests. */
export type CredentialVault = {
  protect(auth: ConnectionAuth, entropy: string): Promise<string>
  unprotect(ciphertext: string, entropy: string): Promise<ConnectionAuth>
}

/** Uses Windows DPAPI and binds ciphertext to the record identity and complete target. */
export const dpapiVault: CredentialVault = {
  protect: (auth, entropy) => invokePowerShell('protect', { auth, entropy }),
  unprotect: async (ciphertext, entropy) => JSON.parse(await invokePowerShell('unprotect', { ciphertext, entropy })) as ConnectionAuth,
}

/** @param id Stable connection ID. @param type Connection kind. @param target Complete WebShell URL or SSH host and port.
 * @returns Domain-separated entropy for binding protected data to its connection target.
 */
export function credentialEntropy(id: string, type: 'webshell' | 'ssh', target: string): string {
  return createHash('sha256').update(JSON.stringify(['dsh-sre-webshell-credential-v1', id, type, target])).digest('base64')
}

function invokePowerShell(operation: 'protect' | 'unprotect', input: Record<string, unknown>): Promise<string> {
  if (process.platform !== 'win32') return Promise.reject(new Error('Local connection credentials require Windows DPAPI.'))
  const script = `$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Security; $x=[Console]::In.ReadToEnd() | ConvertFrom-Json; $e=[Convert]::FromBase64String($x.entropy); if ('${operation}' -eq 'protect') { $b=[Text.Encoding]::UTF8.GetBytes(($x.auth | ConvertTo-Json -Compress)); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser)) } else { $b=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($x.ciphertext),$e,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($b)) }`
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    let stdout = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.once('error', () => reject(new Error('Windows DPAPI credential operation failed.')))
    child.once('close', code => {
      if (code !== 0) { reject(new Error('Windows DPAPI credential operation failed.')); return }
      try {
        const result = operation === 'protect' ? stdout.trim() : JSON.stringify(JSON.parse(stdout))
        resolve(result)
      } catch { reject(new Error('Windows DPAPI credential operation failed.')) }
    })
    child.stdin.end(JSON.stringify({ ...input, entropy: Buffer.from(String(input.entropy ?? '')).toString('base64') }))
  })
}
