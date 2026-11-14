# Publishing Focuvibe on the Microsoft Store

The Store build is an `.appx` made by the same GitHub Actions workflow as the NSIS installer, from the same `package.json` version. Microsoft re-signs it, so it never triggers SmartScreen or Smart App Control. GitHub users update through `electron-updater`; Store users update through the Store (the Store build never loads `electron-updater`).

## One-time setup (you)

1. **Register** at https://storedeveloper.microsoft.com as an **individual**. It is free for individuals. You need a government ID and a selfie; approval can take from minutes to a few days.
2. In **Partner Center**, go to Apps and games → New product → **MSIX or PWA app**, and **reserve the name** "Focuvibe" (if it is taken, pick a variant such as "Focuvibe Focus Timer"; the name you reserve is what shows in the Store).
3. Open the app → **Product management → Product identity** and copy three values:

   | Partner Center field | GitHub variable |
   |---|---|
   | Package/Identity/Name | `STORE_IDENTITY_NAME` |
   | Package/Identity/Publisher (looks like `CN=xxxxxxxx-xxxx-...`) | `STORE_PUBLISHER` |
   | Package/Properties/PublisherDisplayName | `STORE_PUBLISHER_DISPLAY_NAME` |

   Add them at github.com/shaizaanV/studyapp → Settings → Secrets and variables → Actions → **Variables** (not Secrets; they are public in the manifest). Copy them exactly: they are case-sensitive and a mismatch makes Partner Center reject the upload.
4. **Privacy policy URL.** Settings → Pages → Source: *Deploy from a branch*, branch `main`, folder `/docs`. After a minute the policy is at `https://shaizaanv.github.io/studyapp/privacy` (the text lives in `PRIVACY.md` and `docs/privacy.md`; keep them in sync).

## Each release

1. Bump `package.json` `version` and push to `main`. The workflow publishes the GitHub release (NSIS) and, once the three variables exist, also builds `Focuvibe-Store-<version>-x64.appx` and attaches it to that release (and saves it as the `flowcus-store-package` build artifact).
   The first time, or to rebuild the Store package for an existing version: Actions → Release → **Run workflow**.
2. Download the `.appx` and in Partner Center: the app → **Start your submission → Packages** → upload it.
3. Fill in the submission the first time (below), then **Submit to the Store**. Certification takes up to about 3 business days; it goes live a few minutes after it passes.
4. **Only after the version is live on both the GitHub release and the Store** raise `MIN_APP` in `relay/wrangler.toml` and `npx wrangler deploy`; otherwise Store users on the older build are told to update and cannot create or join rooms until the Store catches up.

The Store requires version `X.Y.Z.0`; the build produces that automatically from `X.Y.Z`. Each new submission needs a higher version than the last.

## Submission answers (first time)

- **Pricing:** Free. **Markets:** all offered. **Category:** Productivity.
- **Age rating questionnaire:** no violence, no sexual content, no gambling, no user-generated content moderation by you beyond room tools; the app has **online chat between users** (study rooms), so answer the "users can interact" question truthfully. Expect a 3+/everyone-style rating with an online-interaction notice.
- **Properties:** Privacy policy URL from step 4 above. Support contact: https://github.com/shaizaanV/studyapp/issues.
- **Restricted capability (`runFullTrust`) justification:**
  > Focuvibe is an Electron desktop application. It needs the full-trust process model to run its Chromium and Node runtime, WebRTC peer-to-peer connections for study rooms, and Windows toast notifications. It does not access user files outside its own data folder.
- **Notes for certification:** "No account is needed. To test study rooms you need two PCs: create a room on one, type its 6-character code on the other."

### Listing text (paste into Description)

> **Focuvibe** is a focus timer built to make you actually start and keep going.
>
> • **Two timing modes** — a classic fixed Pomodoro, and a Flow mode whose breaks grow with how long you focused.
> • **Wall Method** — an optional ten-minute pre-focus baseline to settle in before the clock starts.
> • **Study rooms** — study together over a direct peer-to-peer link. Create a room, share its short code, link or QR code, and your friends join in seconds. Shared timer, chat, and moderator tools (kick, ban, mute).
> • **Analytics dashboard** — your streaks, focus time and tier breakdown, stored only on your PC.
> • **Break alarm you cannot miss**, a compact always-on-top mini widget, and a dark interface that stays out of your way.
>
> No account, no ads. Optional anonymous study totals can be turned off in Settings.

**Screenshots:** the Store needs at least one (four recommended), 1366×768 or larger. Run `npm run smoke` to generate screenshots into `.smoke/`, or capture the timer, break, analytics and room panels yourself. Store logos are generated from the app icon by `npm run icon` (`build/appx/`).

## Test the package before submitting

An unsigned `.appx` will not install by default. To try it on your own PC, either enable Developer Mode (Settings → System → For developers) and run `Add-AppxPackage -Path .\Focuvibe-Store-<version>-x64.appx`, or sign it with a throwaway self-signed certificate whose subject equals `STORE_PUBLISHER` and trust it. Check:

- the app launches, the timer runs and a break notification appears,
- `flowcus://join/ABC123` (from the Run dialog) opens Focuvibe on the room panel with the code filled in,
- a room can be created and joined by code,
- no update prompt appears and nothing contacts GitHub for updates,
- run the Windows App Certification Kit on the package (it is in the Windows SDK) and fix anything it flags before submitting.

Remove the test install with `Get-AppxPackage *Focuvibe* | Remove-AppxPackage`.

## How the two channels differ

| | GitHub (NSIS) | Microsoft Store (appx) |
|---|---|---|
| Blocked by SmartScreen / Smart App Control | Yes (unsigned) | No |
| Updates | `electron-updater`, within 4 hours of a release | Store, after certification |
| `flowcus://` links | registered at runtime | registered by the package manifest |
| Settings and history | its own data folder | its own virtualised data folder (not shared) |
