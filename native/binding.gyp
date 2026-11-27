{
  # Lit's bridge to Apple's passkey sheet (passkeys.m). Built by `npm run
  # native` into build/Release/passkeys.node. Node-API, so the same build
  # loads in any Electron.
  "targets": [
    {
      "target_name": "passkeys",
      "sources": ["passkeys.m"],
      "defines": ["NAPI_VERSION=8"],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "MACOSX_DEPLOYMENT_TARGET": "12.0",
            "OTHER_CFLAGS": ["-fobjc-arc", "-Wall"]
          },
          "link_settings": {
            "libraries": [
              "-framework AppKit",
              "-framework AuthenticationServices",
              "-framework Security"
            ]
          }
        }]
      ]
    }
  ]
}
