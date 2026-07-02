# AutoLogin Extension

This folder contains the Safari project.

Main folders:

- `Safari Extension/Resources/` contains the web extension source.
- `macOS App/` contains the wrapper app that opens Safari settings and hosts the extension.
- `macOS App Tests/` contains unit tests.
- `macOS App UI Tests/` contains UI tests.

Open this project in Xcode with:

- `AutoLogin.xcodeproj`

Saved site rules are stored by the extension in `browser.storage.local` under the `sites` key.
