import { SreError } from './errors.ts'

/** Operator opt-in replaces only image approval; binding, command and credential grants stay independent. */
export async function approveScreenshot(config: { autoScreenshot: boolean; targetUrl: string },
  ask: () => Promise<boolean>, record: () => Promise<void>): Promise<void> {
  if (config.autoScreenshot) {
    if (!config.targetUrl) throw new SreError('TARGET_REQUIRED')
    await record()
  } else if (!await ask()) throw new SreError('APPROVAL_REJECTED')
}
