import { notarize } from '@electron/notarize'

export default async function notarizeApp(context) {
  if (process.platform !== 'darwin') {
    return
  }

  const appleId = process.env.APPLE_ID
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD
  const teamId = process.env.APPLE_TEAM_ID
  const signingCertificate = process.env.CSC_LINK

  // Apple only accepts notarization requests for Developer ID signed apps.
  // Keep unsigned CI builds working when the macOS signing secrets are absent.
  if (!signingCertificate || !appleId || !appleIdPassword || !teamId) {
    return
  }

  await notarize({
    appPath: `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`,
    appleId,
    appleIdPassword,
    teamId,
  })
}
