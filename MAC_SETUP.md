# New Mac setup for Kimaki

Use this when a new Mac should join the Kimaki fleet. Do first-boot on the Mac. Then control it over SSH from Kimaki.

## 1. First boot

On the new Mac:

1. Finish Setup Assistant.
2. Create the admin user. Prefer a short name like `tommy`.
3. Connect WiFi.
4. Keep the Mac awake and unlocked. Enter the password once if the lock screen is up. SSH dies when the Mac sleeps even if ping still works.

## 2. Sharing and SSH

On the new Mac:

1. Open **System Settings → General → Sharing**.
2. Turn on **Remote Login**.
3. Allow the admin user.
4. Set **Local hostname** to a short name. Example: `mintmacbook`.
5. Confirm the name is `mintmacbook.local`.

Do not install a tunnel for same-LAN setup. Bonjour already gives a host name.

From the old Mac:

```bash
ping -c 2 mintmacbook.local
ssh tommy@mintmacbook.local
```

If ping works but port 22 times out, Remote Login is off or the Mac slept. A locked Mac can still answer ping. It will not accept SSH until you enter the password.

Disable sleep as soon as SSH works. Otherwise the Mac sleeps again and SSH dies:

```bash
sudo pmset -a sleep 0 disksleep 0 displaysleep 0 hibernatemode 0 autopoweroff 0 standby 0 powernap 0 ttyskeepawake 1 tcpkeepalive 1 womp 1
pmset -g | egrep 'sleep|displaysleep|disksleep'
```

`sleep 0` and `displaysleep 0` must show on both Battery and AC. Do this before long Homebrew installs.

## 3. Custom remote host

Use `.local` on the same LAN. IP can change. The host name stays.

Check it:

```bash
scutil --get LocalHostName
dns-sd -G v4 mintmacbook.local
```

Set it from the new Mac if needed:

```bash
sudo scutil --set LocalHostName mintmacbook
sudo scutil --set ComputerName mintmacbook
sudo scutil --set HostName mintmacbook.local
```

Then SSH with:

```bash
ssh tommy@mintmacbook.local
```

Add a Host block on the old Mac so Kimaki does not need the IP:

```
Host mintmacbook
  HostName mintmacbook.local
  User tommy
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
```

### Optional: Thunderbolt cable

A USB-C / Thunderbolt cable is faster and more stable than WiFi. After you plug it in, the new Mac often gets a `169.254.x.x` address on the Thunderbolt Bridge. `.local` still works. Use the cable when Homebrew and Chrome downloads are slow.

### Optional: Tailscale

Install Tailscale only if you need SSH off this LAN. Then use `mintmacbook.tailnet.ts.net`. Skip ngrok and Cloudflare Tunnel.

## 4. Authorize this Mac

Copy the old Mac public key into `~/.ssh/authorized_keys` on the new Mac. Then `ssh -o BatchMode=yes tommy@mintmacbook.local` works without a password.

## 5. Command Line Tools, then Homebrew

Homebrew hangs if Xcode Command Line Tools are missing. Install CLT first, with no GUI prompt:

```bash
sudo touch /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
softwareupdate -l
sudo softwareupdate -i "Command Line Tools for Xcode 26.5-26.5"
sudo rm -f /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
xcode-select -p
```

Then:

```bash
NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/opt/homebrew/bin/brew shellenv zsh)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv zsh)"
```

Non-interactive SSH has no TTY. Homebrew sudo needs `SUDO_ASKPASS` or a cached `sudo -v` from a real TTY.

## 6. Apps and runtimes

Verified on mintmacbook, 2026-09-15.

```bash
eval "$(/opt/homebrew/bin/brew shellenv)"
brew install bun pnpm duti defaultbrowser
```

### Node 24 via pnpm

`pnpm env use` is deprecated. Use `pnpm runtime set node 24 -g`.

`pnpm` 12.4.1 left a broken `~/Library/pnpm/bin/node` symlink that pointed at the pnpm binary. After `pnpm runtime set`, replace that shim with the real Node binary:

```bash
pnpm setup -f
export PNPM_HOME="$HOME/Library/pnpm"
export PATH="$PNPM_HOME/bin:$HOME/.local/bin:$PATH"
pnpm runtime set node 24 -g
REAL=$(find "$PNPM_HOME/global" -path "*node@runtime+24*" -name node -type f | head -1)
ln -sfn "$REAL" "$PNPM_HOME/bin/node"
ln -sfn "$REAL" "$HOME/.local/bin/node"
node -v   # v24.21.0
```

Add this to `~/.zprofile` and `~/.zshrc`:

```zsh
eval "$(/opt/homebrew/bin/brew shellenv zsh)"
export PNPM_HOME="$HOME/Library/pnpm"
export PATH="$PNPM_HOME/bin:$HOME/.local/bin:$PATH"
```

### Chrome

```bash
brew install --cask google-chrome
```

That puts Chrome in `/Applications`. Setting it as the default browser from SSH did **not** stick. `duti` and `defaultbrowser chrome` still left `http`/`https` on Safari. Chrome launched from SSH also stuck at `_dyld_start` and never created `~/Library/Application Support/Google/Chrome/Default`.

On the new Mac screen, open Chrome once. Then:

```bash
defaultbrowser chrome
duti -s com.google.Chrome public.html all
```

Confirm in **System Settings → Desktop and Dock → Default web browser**.

### Playwriter Chrome extension

Store id: `jfeammnjpkecdekppnclgkkffahnhfhe`.

https://chromewebstore.google.com/detail/playwriter/jfeammnjpkecdekppnclgkkffahnhfhe

Force-install policy is already on the Mac:

- `/Library/Managed Preferences/com.google.Chrome.plist`
- `/Library/Google/Chrome/External Extensions/jfeammnjpkecdekppnclgkkffahnhfhe.json`

An unpacked copy is at `~/playwriter-extension` (from playwriter `extension/dist-release`). After Chrome first-run, open it once so the policy can load the store extension. If it does not, load unpacked from `~/playwriter-extension` on `chrome://extensions`.

CUA cannot click Chrome yet. Accessibility and Screen Recording are still pending.

### Raycast v1, Option-Space

Do **not** `brew install --cask raycast`. That installs Raycast 2.x.

Last v1 for Apple Silicon on Tahoe is **1.104.29**:

```bash
curl -fL "https://releases.raycast.com/releases/1.104.29/download?build=arm" -o /tmp/Raycast.dmg
hdiutil attach /tmp/Raycast.dmg -nobrowse -quiet
cp -R /Volumes/Raycast/Raycast.app /Applications/
hdiutil detach /Volumes/Raycast
defaults write com.raycast.macos raycastGlobalHotkey -string "Option-49"
defaults write com.raycast.macos onboardingCompleted -bool true
defaults write com.raycast.macos SUEnableAutomaticChecks -bool false
defaults write com.raycast.macos SUAutomaticallyUpdate -bool false
open -a Raycast
```

`Option-49` is Option-Space. Raycast 1.104.29 is running on mintmacbook.

### Rectangle

```bash
brew install --cask rectangle
open -a Rectangle
```

Verified: Rectangle **1.100**. Window snapping. Grant Accessibility on first launch if macOS asks.

### Zed and Ghostty

```bash
brew install --cask zed ghostty
```

Verified: Zed **1.19.2**, Ghostty **1.3.1**. Apps land in `/Applications`. Homebrew may warn that Zed cannot write PowerShell completions. Ignore that. The `zed` CLI is at `/opt/homebrew/bin/zed`.

### cua-driver

```bash
/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"
```

This installs `/Applications/CuaDriver.app` and `~/.local/bin/cua-driver` (0.28.1). On the new Mac, grant **Accessibility** and **Screen Recording**:

```bash
cua-driver permissions grant
```

SSH cannot finish that grant. The permission dialogs belong to the GUI session.

## 7. Verify

```bash
ssh mintmacbook 'node -v; bun -v; pnpm -v; brew --version | head -1; cua-driver --version | head -1; defaults read /Applications/Raycast.app/Contents/Info CFBundleShortVersionString; defaults read com.raycast.macos raycastGlobalHotkey; defaults read /Applications/Zed.app/Contents/Info CFBundleShortVersionString; defaults read /Applications/Ghostty.app/Contents/Info CFBundleShortVersionString; defaults read /Applications/Rectangle.app/Contents/Info CFBundleShortVersionString; pmset -g | egrep "sleep|displaysleep"'
```

Expected:

- Node `v24.21.0`
- bun `1.4.2`
- pnpm `12.4.1`
- Homebrew `7.0.1`
- cua-driver `0.28.1`
- Raycast `1.104.29`
- hotkey `Option-49`
- Zed `1.19.2`
- Ghostty `1.3.1`
- Rectangle `1.100`
- `sleep 0` and `displaysleep 0`

Then on the new Mac: open Chrome, set it as default, confirm Playwriter, grant CUA.

## 8. Kimaki from source

Clone into `~/Documents/GitHub`, install workspace deps, then run the CLI with tsx. Do not use `npx kimaki` for this Mac.

```bash
mkdir -p ~/Documents/GitHub
git clone --recurse-submodules https://github.com/remorses/kimaki.git ~/Documents/GitHub/kimaki
cd ~/Documents/GitHub/kimaki
pnpm install
pnpm rebuild prisma @prisma/engines esbuild @parcel/watcher --filter kimaki
cd cli
pnpm generate
```

Start the bot from source in gateway mode:

```bash
cd ~/Documents/GitHub/kimaki/cli
export PATH="/opt/homebrew/bin:$HOME/Library/pnpm/bin:$HOME/.local/bin:$PATH"
pnpm exec tsx src/bin.ts --gateway
```

SSH has no TTY. The process prints an SSE line `data: {"type":"install_url","url":"..."}`. Open that URL in a browser that is already logged into Discord. Authorize the bot in the target server. The CLI polls `https://kimaki.dev/api/onboarding/status` until the guild is saved.

Keep the process running after authorize. A second SSH session can check:

```bash
ssh mintmacbook 'tail -n 50 ~/.kimaki/kimaki.log'
```

The shared **Kimaki** category can already have 50 channels. `project add` then fails with `CHANNEL_PARENT_MAX_CHANNELS`. Create a new category such as **Kimaki mintmacbook**, put a `#kimaki` text channel in it, and map the clone:

```bash
# after the bot is running, from ~/Documents/GitHub/kimaki/cli
pnpm exec tsx src/bin.ts project list
```

Expected log after authorize: `Discord bot logged in as Kimaki#4819` and `Kimaki Macbook`. Ping can work while SSH times out if the Mac is locked. Unlock it, then disable sleep.
