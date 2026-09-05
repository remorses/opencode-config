---
name: agent-device
description: Set up and control physical iPhones from a Mac with the agent-device CLI. Use for device pairing, Xcode signing, app navigation, reading screens, screenshots, accessibility-hang recovery, and multiple connected phones.
---

# Control physical iPhones with agent-device

**Assume one phone is already connected and configured.** Start every task with this connection check, using the installed CLI or its resolved absolute path:

```bash
agent-device devices --platform ios
```

If exactly one physical iPhone is present, select it without asking which device to use. If no phone appears, ask the user to connect and unlock the existing phone, then check again. **Do not interpret a missing device, expired session, or failed command as a request to add a new device.**

**Run the full setup in sections 1–3 only when the user explicitly asks to add or configure a new device.** Ordinary requests such as “read this screen” or “send a message” go directly through the connected-phone workflow below. Do not reinstall the CLI, download Xcode components, create certificates, register devices, or rerun the full setup for routine actions. Diagnose a specific failure and use only the relevant recovery step.

**Always use `--depth 10` on explicit snapshots.** This limits traversal work and reduces the risk of deep accessibility trees hanging. It is a precaution, not a guarantee: XCTest can still stall before it returns a tree. Do not run repeated deep or unbounded snapshots to recover a hung screen.

## Default workflow: act on the connected phone

### Select the phone and reuse its session

After the connection check, inspect **existing sessions**. Reuse the session that belongs to this task and matches the selected phone. Use `device status` only if ownership is unclear or a command reports `DEVICE_IN_USE`. If there is no active session, opening the requested app can create one without repeating device setup.

```bash
agent-device session list
# Only for an ownership conflict:
agent-device device status --platform ios
```

Set `PHONE_UDID` to the discovered hardware UDID and `PHONE_SESSION` to the actual session name. With no existing session, use a clear new name such as `phone-a`. **Implicit default and explicit `--session default` are different handles**; copy the existing name rather than switching between them accidentally. Keep the existing signing environment available in case the daemon needs to start.

### Wake or unlock before acting

Check the **lock state** if the display is locked or an app launch is denied:

```bash
xcrun devicectl device info lockState --device "$PHONE_UDID"
```

If `passcodeRequired: true`, prompt the user: **“Please wake and unlock the iPhone with Face ID or its passcode, and leave it unlocked.”** The user can press the side button or tap the screen, then swipe up and authenticate. Recheck lock state before continuing. This is a physical unlock request, not a request to repeat pairing or Developer Mode setup.

**There is no documented physical-iPhone `agent-device unlock` command in the checked version.** `agent-device home --session "$PHONE_SESSION"` sends a responsive device to its Home screen; it does not bypass its lock. Opening an app can bring it forward when the phone is already unlocked, but is not a reliable unlock mechanism. Never claim a screen wake, Home action, or cable connection unlocked the phone. Keep Auto-Lock at its existing setting unless the user asks to change it; this phone was previously set to Never.

### Typical action sequence

1. **Inspect the current app** with a bounded snapshot when it is already the requested app. Preserve its current video, conversation, or form.
2. Otherwise **open the requested app** in the selected session without `--relaunch` or `--foreground`, then take a separate depth-10 snapshot.
3. **Act on a current ref**, then take another bounded snapshot. Repeat only the steps needed for the user's request.
4. **Verify the result** from visible UI state, show progress screenshots as described below, and report completion. Preserve a reused session for ongoing work; close a session when the task is finished and it is no longer needed.

```bash
# Skip open when already on the requested screen in this session.
agent-device open Messages --platform ios --device "$PHONE_UDID" --session "$PHONE_SESSION"
agent-device snapshot -i --depth 10 --session "$PHONE_SESSION"
# Example refs only: replace with the latest observed conversation and input refs.
agent-device press @e8 --session "$PHONE_SESSION"
agent-device snapshot -i --depth 10 --session "$PHONE_SESSION"
agent-device fill @e11 'Exact user-authorized text' --session "$PHONE_SESSION"
agent-device snapshot -i --depth 10 --session "$PHONE_SESSION"
# Verify recipient, text, and the actual Send control before this action.
agent-device press @e54 --session "$PHONE_SESSION"
agent-device snapshot --depth 10 --session "$PHONE_SESSION"
agent-device screenshot /absolute/path/action-result.png --session "$PHONE_SESSION"
```

Use `snapshot --depth 10` **without `-i`** to read messages, posts, or comments. Use `-i` when selecting interactive controls. If a specific runner failure occurs, use the recovery section; do not run `prepare`, restart the runner, or test Settings before every ordinary action.

### Show screenshots during the work

**Show screenshots often when the current harness can display images.** Do this proactively, not only when the user asks or after the task is complete. Show the starting screen, meaningful navigation or action results, any blocker that needs user input, and the verified final state. Add a short caption so the user can follow progress. Skip duplicate images of an unchanged screen.

**Use the harness's image display mechanism.** In a chat that supports local Markdown images, embed an absolute path, for example `![Current phone screen](/absolute/path/phone-screen.png)`. In another harness, use its supported image attachment or display tool. Merely saving a screenshot or inspecting it with an agent-only tool does not mean the user has seen it. If images cannot be displayed, give a short text update and a usable file link when supported; do not claim the image was shown. Inspect screenshots before sharing and avoid exposing unrelated sensitive content.

## Further guidance

- For an **explicit request to add a new device**, follow sections 1–3 for the Mac host and iPhone. An app launch alone does not prove the new device supports taps and screenshots; verify each on a harmless screen during initial setup.
- For **routine CLI usage**, section 4 covers refs, text entry, scrolling, and evidence.
- For **timeouts**, use the bounded recovery section, not repeated retries.
- For **two or more phones**, use separate device IDs and named sessions as shown below.
- Use current installed help to resolve version differences: `agent-device help physical-device`, `help snapshot`, `help prepare`, and `help <command>`.

## 1. Prepare the Mac

### Install the CLI and Xcode components

Install Node.js **22.12 or newer**, full Xcode, and agent-device from npm. Check for an existing CLI before installing or upgrading it.

```bash
command -v agent-device
node --version
npm install -g agent-device@latest
agent-device --version
agent-device doctor
xcode-select -p
```

**Resolve PATH problems** instead of reinstalling repeatedly. Global npm installs can use a Node-version-specific directory that is absent from the agent's PATH. Run `npm prefix -g`, then use its `bin/agent-device` executable explicitly. On this Mac, the working path during setup was:

```text
/Users/morse/.local/share/pnpm/nodejs/24.15.0/bin/agent-device
```

**Select full Xcode** if `xcode-select -p` points only to CommandLineTools. In Xcode, open **Settings > Components** and install iOS platform support. A visible SDK in `xcodebuild -showsdks` does not prove that all platform components are installed. We encountered `iOS 26.5 is not installed` and resolved it by installing the offered **iOS 26.5.1 + iOS 26.5 Simulator** component. It was about 8.5 GB; use the version offered by the current Xcode, not that historical version.

```bash
# Only if the selected developer directory is wrong:
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
```

### Enable Mac developer-tool access

The **Mac's developer-tool permission** is separate from iPhone Developer Mode. Both must be ready. This command resolved `Developer mode is disabled for Apple development tools`:

```bash
/usr/sbin/DevToolsSecurity -status
sudo /usr/sbin/DevToolsSecurity -enable
/usr/sbin/DevToolsSecurity -status
```

Let the user enter an administrator password in the system's own prompt when required. Do not request their password in chat. A tool that cannot access Terminal cannot complete that password step on their behalf.

### Create a signing certificate

In **Xcode > Settings > Apple Accounts** (called Accounts in some versions), sign in to the user's Apple account. Select the team, open **Manage Certificates**, and create **Apple Development** if no valid identity exists. A free Personal Team worked in this session.

```bash
security find-identity -v -p codesigning
security find-certificate -c 'Apple Development' -p |
  openssl x509 -noout -subject -issuer -dates
```

Read the **team ID from the certificate subject's `OU`** or Xcode team details. The code-signing identity's parenthesized suffix is not necessarily the team ID. Do not copy a team hardcoded in the runner project or infer one from an account email.

**Missing intermediate certificate:** We created an identity, but `security find-identity -v` still showed zero valid identities. Its issuer was Apple WWDR **G3**, which was missing. Importing Apple's official intermediate into the login keychain fixed validation. Use this only when the issuer matches and the chain is actually missing; do not override certificate trust or use “Always Trust” to mask a chain error.

```bash
curl -fLs https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer \
  -o /tmp/agent-device-apple-wwdr-g3.cer
openssl x509 -inform DER -in /tmp/agent-device-apple-wwdr-g3.cer \
  -noout -subject -issuer -dates
security add-certificates -k "$HOME/Library/Keychains/login.keychain-db" \
  /tmp/agent-device-apple-wwdr-g3.cer
security find-identity -v -p codesigning
```

## 2. Prepare each iPhone

1. **Connect by USB**, unlock the phone, and accept **Trust This Computer** on the phone. Confirm it appears in Xcode's **Window > Devices and Simulators**.
2. Enable **Settings > Privacy & Security > Developer Mode**. Complete the restart and the post-restart **Turn On** confirmation. The switch alone is not enough.
3. Keep the phone **unlocked** while installing or starting the runner. If the user wants it to stay awake, set **Settings > Display & Brightness > Auto-Lock > Never**. Italian labels are **Schermo e luminosità > Blocco automatico > Mai**. Verify the selected value. Do not change this setting merely because this skill mentions it.
4. After the runner is installed, open **Settings > General > VPN & Device Management > Developer App**, select the signing account, and **Trust** it. Trusting the Mac and enabling Developer Mode do not replace this separate developer-app trust step.

**Verify device state**, rather than relying only on the user having enabled a switch:

```bash
xcrun devicectl list devices
xcrun devicectl device info details --device "$PHONE_UDID"
xcrun devicectl device info lockState --device "$PHONE_UDID"
agent-device devices --platform ios
```

Look for `developerModeStatus: enabled`, `ddiServicesAvailable: true`, a paired connection, and `passcodeRequired: false`. The CoreDevice UUID and hardware UDID are different identifiers; use the hardware UDID reported by agent-device for repeatable selection and Xcode destinations.

## 3. Sign, register, and start the runner

### Keep signing configuration available

Set these **operator environment variables before the daemon starts**, and keep them present for later CLI invocations. Use a unique reverse-DNS bundle ID for a Personal Team.

```bash
export AGENT_DEVICE_IOS_TEAM_ID='YOUR_TEAM_ID'
export AGENT_DEVICE_IOS_BUNDLE_ID='com.yourname.agentdevice.runner'
export PHONE_UDID='UDID_FROM_DEVICE_DISCOVERY'

agent-device prepare ios-runner --platform ios --device "$PHONE_UDID" \
  --session phone-a --timeout 240000
```

**Daemon environment is persistent.** Exporting a new team in a shell does not reliably change an already-running daemon's signing environment. In this session a daemon restart lost the team override, and the build fell back to a different team in the project. Keep the exports in a user-controlled shell environment or launcher; do not assume they persist across agent tool calls.

For an existing daemon with the wrong environment, close this task's sessions first. Inspect the daemon PID and process command, then stop **only that verified daemon** before starting it with the correct exports. Do not interrupt another active phone session. Do not print all of `daemon.json`: it contains an authentication token. A separate `AGENT_DEVICE_STATE_DIR` can isolate a different signing environment, but cannot bypass another owner's device claim.

### Register an unprovisioned phone

If Xcode says **“Your team has no devices”** or cannot generate provisioning profiles, register the actual connected phone through Xcode's automatic signing. The CLI's generic build destination did not register our phone. A build with the **explicit device destination** and `-allowProvisioningDeviceRegistration` resolved it.

Locate the runner project shipped in the installed package and reuse the **derived-data path from `runner.log`**. The example assumes npm's global installation; adjust the package root for the actual install.

```bash
AGENT_DEVICE_PACKAGE_ROOT="$(npm root -g)/agent-device"
RUNNER_PROJECT="$AGENT_DEVICE_PACKAGE_ROOT/dist/apple/runner/AgentDeviceRunner/AgentDeviceRunner.xcodeproj"
RUNNER_DERIVED_PATH='/absolute/derivedDataPath/from/runner.log'

xcodebuild build-for-testing \
  -project "$RUNNER_PROJECT" -scheme AgentDeviceRunner \
  -destination "platform=iOS,id=$PHONE_UDID" \
  -derivedDataPath "$RUNNER_DERIVED_PATH" \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM="$AGENT_DEVICE_IOS_TEAM_ID" \
  AGENT_DEVICE_IOS_RUNNER_APP_BUNDLE_ID="$AGENT_DEVICE_IOS_BUNDLE_ID" \
  AGENT_DEVICE_IOS_RUNNER_TEST_BUNDLE_ID="$AGENT_DEVICE_IOS_BUNDLE_ID.uitests" \
  COMPILER_INDEX_STORE_ENABLE=NO ENABLE_CODE_COVERAGE=NO \
  ENABLE_PREVIEWS=NO ENABLE_DEBUG_DYLIB=NO
```

A profile must permit the actual **host and test-runner bundle identifiers**. The test app identifier can end in `.uitests.xctrunner`; inspect the error rather than assuming only two base identifiers need profiles. Leave `AGENT_DEVICE_IOS_SIGNING_IDENTITY` and `AGENT_DEVICE_IOS_PROVISIONING_PROFILE` unset unless automatic signing needs them. A profile override is a profile name/specifier, not a file path.

### Verify a usable session

After installation, complete developer-app trust on the iPhone, then retry preparation. `prepare` separates slow first-run setup from ordinary app commands. `open` does **not** accept `--timeout` in the version used here.

```bash
agent-device prepare ios-runner --platform ios --device "$PHONE_UDID" \
  --session phone-a --timeout 240000
agent-device open Settings --platform ios --device "$PHONE_UDID" --session phone-a
agent-device snapshot -i --depth 10 --session phone-a
agent-device screenshot /absolute/path/settings-ready.png --session phone-a
```

Use a harmless, observed back or navigation control to verify a tap, then capture a fresh bounded snapshot. **Prepared**, **opened**, and **controllable** are distinct results.

## 4. Drive the phone from the CLI

Use an explicit **session name on every command**. Opening another app within that session changes its active app. Plain `open` brings it forward without intentionally restarting it; use `--relaunch` only when a restart is intended. For fragile screens, prefer plain `open` followed by `snapshot --depth 10`, because `open --foreground` adds an initial snapshot without exposing the same depth control.

```bash
agent-device open Messages --platform ios --device "$PHONE_UDID" --session phone-a
agent-device snapshot -i --depth 10 --session phone-a
agent-device press @e8 --session phone-a
agent-device snapshot -i --depth 10 --session phone-a
agent-device fill @e11 'Exact user-authorized text' --session phone-a
agent-device snapshot -i --depth 10 --session phone-a
# Only after verifying recipient, text, and the actual Send ref:
agent-device press @e54 --session phone-a
agent-device snapshot -i --depth 10 --session phone-a
```

**Refs are examples**, not stable IDs. Use only refs from the latest snapshot or settled diff, preserving any suffix such as `@e54~s240212`. Never reuse a ref after a state change without observing the new state. `fill` replaces field contents; `type` appends after focus. Verify the composed text before sending because keyboards may alter input.

On stable screens, `press`, `fill`, `scroll`, and `back` support **`--settle`**, which acts and returns a UI diff. On hang-prone screens prefer a plain action and a separate **depth-10 snapshot**. Do not append `--depth 10` blindly to actions: ref-based `press` and `fill` reject snapshot-depth flags in current source. Automatic settle captures are not guaranteed to share the explicit snapshot's bound.

```bash
agent-device scroll down 500 --session phone-a
agent-device snapshot -i --depth 10 --session phone-a
agent-device back --session phone-a
agent-device snapshot --depth 10 --session phone-a
agent-device screenshot /absolute/path/evidence.png --session phone-a
agent-device close --session phone-a
```

Use a snapshot **without `-i` but with `--depth 10`** when reading non-interactive post or comment text. If text is below the current depth or offscreen, navigate closer, scope the snapshot, or scroll. If `scroll bottom` wrongly reports no hidden content, a bounded `scroll down 500` worked in TikTok settings.

**Verify outcomes** from the UI. An outgoing message bubble proves submission; “Delivered” is separate evidence of delivery. For a send timeout, inspect the conversation before retrying to avoid duplicate messages. An app's “Loading failed” screen is not an automation setup failure. Report unavailable posts honestly. Follow the progress-screenshot guidance above throughout the task.

## 5. Recover from accessibility hangs

1. **Bound the first read:** `snapshot -i --depth 10`. Use `--scope` when a known label narrows the screen. Do not respond to an empty bounded result by immediately requesting an unlimited tree.
2. If the CLI returns **`fallbackScreenshotPath`**, inspect that existing image. A one-node snapshot with a backend-failure warning has no usable semantic refs.
3. Use **screenshot-grounded coordinates** only after semantic access fails. iPhone screenshots may use physical pixels while tap coordinates use logical points. Our XR image was 828×1792 and its tap space was 414×896. Verify the current device's scale; do not assume 2× for another phone.
4. A coordinate tap can still invoke XCTest accessibility internally. If it also hangs or returns **`RUNNER_BUSY`**, wait briefly once, then inspect the named session's `runner.log`. Do not queue more actions behind a wedged command.
5. Recover this session's runner with `close --shutdown`, then `prepare`, then plain `open` and a bounded snapshot. `close --shutdown` also shuts down simulators/emulators; on our physical iPhone it stopped the runner without powering off the phone. Check current help before using it on another target type.
6. If the app itself remains unresponsive, one intentional **`open ... --relaunch`** can clear stale app state. After a repeated failure with the same cause, report the specific blocker or request the necessary on-device action. Do not keep rebuilding a correctly signed runner for an app-specific tree failure.

```bash
agent-device close --session phone-a --shutdown
agent-device prepare ios-runner --platform ios --device "$PHONE_UDID" \
  --session phone-a --timeout 240000
agent-device open Settings --platform ios --device "$PHONE_UDID" --session phone-a
agent-device snapshot -i --depth 10 --session phone-a
```

**Independent screenshot fallback:** Xcode > Window > Devices and Simulators > select the iPhone > **Take Screenshot** worked while the XCTest runner was busy. Xcode saved `Screenshot <date> at <time>.png` on this Mac's Desktop. Inspect the actual newly generated file; do not assume its path, filename, or completion from a click. Use the available computer-use tool for Xcode UI actions. This captures evidence but does not provide an independent phone input channel.

**Diagnostic distinctions from this setup:**

| Symptom | Correct next check |
| --- | --- |
| Developer Mode disabled | Distinguish iPhone Developer Mode from Mac DevToolsSecurity; check the exact error. |
| Launch denied: Locked | Unlock the physical phone; a connected cable does not unlock it. |
| iOS platform not installed | Xcode Settings > Components, even if the SDK name is listed. |
| Zero valid signing identities | Certificate, private key, dates, and issuer chain. |
| No account for a different team | Correct the daemon's signing environment. |
| Team has no devices / no profiles | Explicit destination and provisioning-device registration. |
| Developer App Certificate not trusted | Trust the installed developer app on the phone. |
| `errSecInternalComponent` during signing | Inspect keychain access and certificate chain. One retry succeeded here; repeated failure needs diagnosis. |
| `RUNNER_BUSY` / main-thread timeout | Screenshot fallback, bounded wait, then session runner recovery. |
| Feed fails but navigation works | App/network/account problem; do not claim content was read. |

## 6. Control more than one phone

**Yes.** Agent-device supports separate sessions on separate devices, including concurrent work. Use a stable hardware UDID and a distinct explicit session name for each phone. Complete pairing, Developer Mode, profile registration, and developer-app trust on **each physical iPhone**. One Mac/team/certificate can be reused where its provisioning permits those devices.

```bash
agent-device devices --platform ios
agent-device session list
agent-device device status --platform ios

agent-device open Settings --platform ios --device "$PHONE_A_UDID" --session phone-a
agent-device open Settings --platform ios --device "$PHONE_B_UDID" --session phone-b
agent-device snapshot -i --depth 10 --session phone-a
agent-device snapshot -i --depth 10 --session phone-b
agent-device screenshot /absolute/path/phone-a.png --session phone-a
agent-device screenshot /absolute/path/phone-b.png --session phone-b
```

**Serialize commands for one device/session.** Separate phones can be operated in parallel, but do not run competing taps, fills, opens, or snapshots against one phone. Start and provision phones sequentially first to make failures easy to identify. More phones also consume more USB bandwidth, power, and Mac resources; no tested hardware maximum was established here.

**Ownership is enforced.** A device cannot be actively owned by two sessions at once. For `DEVICE_IN_USE`, inspect `session list` and `device status`, then reuse the actual owner if it belongs to this task. Implicit `default` is scoped to the current workspace; explicit `--session default` is a different shared handle. This exact mismatch occurred here. Do not delete another session's claim or kill its daemon to take control.

**Signing environments:** Phones using the same team normally share one daemon. If different teams or runner configurations are needed, isolate them with distinct `AGENT_DEVICE_STATE_DIR` values set before starting each daemon, and keep every command in the correct environment. This does not waive host-wide device ownership. Close only the session being finished.

## Local setup record and sources

**Observed on 2026-09-05:** CLI 0.20.10, Xcode 26.6, iPhone XR on iOS 18.7.6. The working hardware UDID was `00008020-000405C214BB002E`, team `92MF9DG2LR`, and runner base `com.remorses.agentdevice.runner`. These are local recovery hints, not defaults for a new phone or another user's account. Re-discover before use.

**Verified references:** consult installed help first when upstream differs. Multi-device support was checked in official guidance and the source test named `router allows pre-open requests for different devices to proceed concurrently` in `src/daemon/__tests__/request-router-open.test.ts`. Two physical phones were not available for a live concurrency test. Depth 10 is the user's chosen operating precaution; this session did not prove it eliminates every hang.

- [Agent-device repository](https://github.com/callstack/agent-device)
- [Installation and physical iPhone prerequisites](https://oss.callstack.com/agent-device/docs/installation)
- [Sessions and command serialization](https://oss.callstack.com/agent-device/docs/sessions)
- [Parallel work on separate sessions/devices](https://oss.callstack.com/agent-device/docs/security-trust)
- [Snapshot depth and degraded captures](https://oss.callstack.com/agent-device/docs/snapshots)
- [Configuration and signing environment](https://oss.callstack.com/agent-device/docs/configuration)

**Task scope:** Device access is not permission to send messages, accept legal terms, change accounts, or alter unrelated settings. Follow the user's current authorization and applicable tool rules. Ask the user for physical unlocks, trust confirmations, or authentication steps that the available tools cannot perform. Verify before reporting success.
