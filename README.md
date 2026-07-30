# AutoLogin

A transparent, user-controlled autofill helper for Safari on macOS. Save login credentials per website, fill forms automatically, and manage everything from the toolbar or a dedicated settings page.

## Features

### Per-site credentials
- Save username, password, and additional custom fields for any website
- Passwords are stored in the **macOS Keychain**; extension storage only keeps opaque references — nothing is sent to a server
- Edit or delete saved sites anytime from the settings page
- Optionally pin a rule to an exact login page path so it never fills elsewhere

### Smart form detection
- Automatically detects login fields on the current page when you open the popup
- Supports pages with extra fields beyond username and password
- Handles single-page app navigation (URL changes without a full reload)

### Auto-fill and auto-submit
Filling and signing in are built in — there is nothing to configure:
- Saved credentials are filled automatically when a matching login page loads
- The form is then submitted automatically, but only when a username and a password were both filled inside one and the same form
- Applies saved rules immediately on open tabs without requiring a page reload
- Retries with a short bounded backoff so late-rendering login forms still get filled

### Safety checks
Password autofill is refused on plain-HTTP pages and on registration or password-change forms. Auto-submit is additionally blocked when the extension detects:
- CAPTCHA challenges (reCAPTCHA, hCaptcha, Turnstile, etc.)
- OTP, 2FA, or one-time-code fields
- Ambiguous pages with multiple competing login forms

### Toolbar popup
- Open from the Safari toolbar or with **Ctrl+Shift+L**
- Detects the current site and shows its saved fields
- Toolbar icon turns **blue** when the current site has a saved rule, **gray** when it does not

### Settings page
- View all saved sites in one place
- Edit credentials, adjust the login page path, or delete individual sites
- Clear all saved sites or reset all extension data

### macOS companion app
- Onboarding app that helps you enable the Safari extension
- Shows whether the extension is currently turned on

## Getting started

1. Open `AutoLogin.xcodeproj` in Xcode and build the project (**Cmd+R**)
2. In Safari, go to **Settings → Extensions** and enable **AutoLogin**
3. Grant the extension permission for the websites you want to use it on
4. Click the toolbar icon on a login page, enter your credentials, and tap **Save Credentials**

## Privacy

Site rules stay in `browser.storage.local` on your Mac; passwords live in the macOS Keychain, keyed by opaque ids. AutoLogin does not sync, upload, or share your data. (The companion app keeps the sandbox network-client entitlement only because WKWebView requires it to render the onboarding page.)
