// electron-builder's config for a Lit signed with a Developer ID, which may
// use Apple's passkey sheet (README: Passkeys). `npm run build:signed`, or
// `npm run app` once build/Lit.provisionprofile is there.
//
// It is package.json's `build` with:
// - the Developer ID Application certificate in the keychain (or CSC_NAME)
//   in place of ad-hoc signing, under the hardened runtime notarizing needs;
// - build/Lit.provisionprofile, a Developer ID profile for app.jimmywu.lit
//   with the Web Browser Public Key Credential Requests capability, embedded;
// - the entitlements below, with the team from that profile;
// - notarizing, when Apple's credentials are in the environment (APPLE_API_KEY,
//   APPLE_API_KEY_ID and APPLE_API_ISSUER; or APPLE_ID,
//   APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID). A copy only for this Mac
//   needs none.
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { build } = require('../package.json')

const root = path.join(__dirname, '..')
const PROFILE = path.join(__dirname, 'Lit.provisionprofile')

// What every part of Lit needs under the hardened runtime: Electron's
// JavaScript engine, and what sites may ask for (src/permissions.js).
const RUNTIME = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.device.camera',
  'com.apple.security.device.audio-input',
  'com.apple.security.personal-information.location',
]

function teamOf(profile) {
  if (!fs.existsSync(profile)) throw new Error(`No provisioning profile at ${path.relative(root, profile)}; see the README's Passkeys section.`)
  const decoded = execFileSync('security', ['cms', '-D', '-i', profile])
  return execFileSync('plutil', ['-extract', 'TeamIdentifier.0', 'raw', '-o', '-', '-'], { input: decoded }).toString().trim()
}

const plist = (entries) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${Object.entries(entries).map(([key, value]) => `  <key>${key}</key>\n  ${value === true ? '<true/>' : `<string>${value}</string>`}`).join('\n')}
</dict>
</plist>
`

// Written next to the build, as the team is only known here.
function writeEntitlements(team) {
  const dir = path.join(root, build.directories.output)
  fs.mkdirSync(dir, { recursive: true })
  const runtime = Object.fromEntries(RUNTIME.map((key) => [key, true]))
  const app = path.join(dir, 'entitlements.mac.plist')
  const helpers = path.join(dir, 'entitlements.mac.inherit.plist')
  fs.writeFileSync(app, plist({
    // Lit as the profile names it; macOS won't open it otherwise.
    'com.apple.application-identifier': `${team}.${build.appId}`,
    'com.apple.developer.team-identifier': team,
    // Apple's passkey sheet for web pages (native/passkeys.m).
    'com.apple.developer.web-browser.public-key-credential': true,
    ...runtime,
  }))
  fs.writeFileSync(helpers, plist(runtime))
  return { app, helpers }
}

const { app, helpers } = writeEntitlements(teamOf(PROFILE))
const { identity: _adHoc, ...mac } = build.mac

module.exports = {
  ...build,
  mac: {
    ...mac,
    hardenedRuntime: true,
    provisioningProfile: PROFILE,
    entitlements: app,
    entitlementsInherit: helpers,
    notarize: Boolean(process.env.APPLE_API_KEY || process.env.APPLE_ID || process.env.APPLE_KEYCHAIN_PROFILE),
  },
}
