# AutoLogin

A transparent, user-controlled autofill helper for Safari on macOS. Save login credentials per website, fill forms automatically, and manage everything from the toolbar or a dedicated settings page.

## Features

### Per-site credentials
- Save username, password, and additional custom fields for any website
- Credentials are stored locally on your device in Safari extension storage — nothing is sent to a server
- Edit or delete saved sites anytime from the settings page

### Smart form detection
- Automatically detects login fields on the current page when you open the popup
- Supports pages with extra fields beyond username and password
- Handles single-page app navigation (URL changes without a full reload)

### Auto-fill and auto-submit
- **Auto-fill** — fills saved credentials when a matching page loads
- **Auto-submit** — optionally submits the form after fields are filled
- Applies saved rules immediately on open tabs without requiring a page reload
- Limits autofill to two attempts per page load to avoid repeated retries on slow sites

### Safety checks
Auto-submit is blocked when the extension detects:
- CAPTCHA challenges (reCAPTCHA, hCaptcha, etc.)
- OTP, 2FA, or one-time-code fields
- Ambiguous pages with multiple competing login forms

### Toolbar popup
- Open from the Safari toolbar or with **Ctrl+Shift+L**
- Detects the current site and shows its saved fields
- Toolbar icon turns **blue** when the current site has a saved rule, **gray** when it does not

### Settings page
- View all saved sites in one place
- Edit credentials, toggle auto-fill and auto-submit, or delete individual sites
- Clear all saved sites or reset all extension data

### macOS companion app
- Onboarding app that helps you enable the Safari extension
- Shows whether the extension is currently turned on

## Getting started

1. Open `AutoLogin.xcodeproj` in Xcode and build the project (**Cmd+R**)
2. In Safari, go to **Settings → Extensions** and enable **AutoLogin**
3. Grant the extension permission for the websites you want to use it on
4. Click the toolbar icon on a login page, enter your credentials, and tap **Save Passkey**

## Privacy

All site rules and credentials stay in `browser.storage.local` on your Mac. AutoLogin does not sync, upload, or share your data.
