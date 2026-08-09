# Pedal Bakery on Windows — setup from zero

For a Windows machine with nothing installed. At the end you'll have a
terminal that looks and behaves like a Mac one, Claude Code running in it,
and Pedal Bakery open in your browser.

Budget ~30 minutes, most of it waiting on downloads.

**Before you start:** Claude Code needs a Claude **Pro or Max** subscription.
The free claude.ai plan doesn't include it.

## What you're installing, and why

We're using **WSL** — a built-in Windows feature that runs Ubuntu Linux
*inside* Windows. This is not dual-boot, not a virtual machine you have to
manage, and it doesn't touch your Windows install. You stay on Windows the
whole time: Windows Terminal, Chrome, your files.

The reason: it makes your terminal identical to a Mac's, so every command
anyone hands you works verbatim. It also ships Python and git for free, and
it's the only Windows option where Claude Code can sandbox commands.

The plan is to get Claude Code working and the app running first, then make
the terminal pretty — with Claude Code doing most of that work for you.

---

## 1. Windows Terminal

The app your terminal runs in.

- **Windows 11** — already installed. Skip.
- **Windows 10** — install *Windows Terminal* free from the Microsoft Store.

## 2. Ubuntu, via WSL

Open **PowerShell as Administrator** — right-click the Start button, then
**Terminal (Admin)** on Windows 11, or **Windows PowerShell (Admin)** on
Windows 10. Run:

```powershell
wsl --install
```

**Reboot when it asks.**

> **If it fails with `0x80370102`** or "the virtual machine could not be
> started", hardware virtualization is switched off in your BIOS/UEFI —
> common on prebuilt and gaming desktops. Go to Settings → System → Recovery
> → Advanced startup → **Restart now** → Troubleshoot → Advanced options →
> **UEFI Firmware Settings**, and enable **Intel VT-x** or **AMD-V / SVM**
> (sometimes listed as "Virtualization Technology"). Save, boot back into
> Windows, and rerun `wsl --install`.

After the reboot an Ubuntu window opens by itself and asks for a UNIX
username and password. Pick anything — but **remember that password**, it's
your `sudo` password and you'll need it repeatedly.

> If the window doesn't appear, open Windows Terminal and pick **Ubuntu**
> from the dropdown next to the `+` tab button.

Bring it up to date (first `sudo` will ask for that password):

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y zsh git curl
```

**Checkpoint:** `python3 --version` should print something like `Python 3.12.3`.
Ubuntu ships it, nothing to install.

## 3. Claude Code

Everything from here runs in the **Ubuntu** tab, not PowerShell.

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

Then start it and log in through the browser that opens:

```bash
claude
```

A browser should open for you to log in. If nothing happens — WSL can't
always launch a Windows browser — copy the URL Claude prints and paste it
into your browser by hand.

If that says `command not found`, the installer added `claude` to your PATH
but this shell started before it existed. Run `exec bash` (or open a new tab)
and try again.

**Checkpoint:** `claude --version` prints a version number. `claude doctor`
gives you a fuller health check if anything looks off.

## 4. Pedal Bakery

Make a folder for your projects and clone into it, one line at a time:

```bash
cd ~
mkdir repos
cd repos
git clone https://github.com/timpal0l/pedal-bakery.git audio-sim
cd audio-sim
python3 bakery/server.py
```

`cd ~` means "go to my home folder" and works from anywhere — use it rather
than `cd ..`, which would land you in `/home`, a folder you don't own.

Open <http://localhost:8123> in **Chrome or Edge, on Windows** — WSL forwards
localhost automatically, it just works. A fresh Windows machine has Edge and
no Chrome; Edge is Chromium underneath, so the 3D and the live guitar input
both work fine in it.

Type a name, hit **CREATE BAKERY**, and you should be looking at a 3D
pedalboard. That's the whole app working. Read `ONBOARDING.md` next.

**That tab now belongs to the server.** It sits there printing its log and
won't give you a prompt back — that's it working, not frozen. Open a second
tab with `Ctrl+Shift+T` (or the `+` button) for everything else, including
Claude Code. `Ctrl+C` in the server tab stops the server when you're done.

---

## 5. The font

Now the cosmetics. This is the one part Claude Code can't do for you —
installing a font means registering it with Windows itself.

Themed prompts draw using special glyphs. Without the right font they render
as empty boxes and it looks broken.

1. On Windows, download the four **MesloLGS NF** `.ttf` files linked from
   <https://github.com/romkatv/powerlevel10k/blob/master/font.md>
2. Select all four → right-click → **Install**

Leave selecting it to step 6 — Claude will do that part.

## 6. Hand the rest to Claude Code

Start Claude Code in your project (`cd ~/repos/audio-sim && claude`) and give
it this:

> I'm on Windows running Ubuntu in WSL. Make my terminal look like a Mac one:
> install oh-my-zsh unattended, install powerlevel10k and set it as my zsh
> theme. I've already installed the MesloLGS NF font on the Windows side —
> find my Windows Terminal settings.json under
> `/mnt/c/Users/*/AppData/Local/Packages/Microsoft.WindowsTerminal*/LocalState/`,
> back it up, then set the Ubuntu profile's font to MesloLGS NF, color scheme
> to One Half Dark, add slight transparency, and make Ubuntu the default
> profile. Tell me any command I need to run myself because it needs my
> password.

Windows Terminal live-reloads its settings file, so you'll watch the window
change as Claude edits it.

That last sentence in the prompt matters: changing your default shell
(`chsh`) needs your password, and Claude can't type it. It'll hand you that
one command to run yourself.

Finally, run the prompt wizard yourself — it's interactive, so it has to be
you:

```bash
p10k configure
```

It asks things like *"does this look like a diamond?"*. If the answer is
"no, it's an empty box", the font didn't install or didn't get selected —
go back to step 5. Rerun `p10k configure` any time you want a different look.

---

## Things that will trip you up

**Keep your code in `~/repos`, never in `/mnt/c/...`.** `/mnt/c` is your
Windows C: drive seen from Ubuntu. It works, but it's roughly 10× slower and
breaks file watching. Your Ubuntu home directory is the right place. (The one
good reason to reach into `/mnt/c` is what we did in step 6 — editing a
Windows app's config.)

**Claude Code hangs on `sudo`.** It can't type your password. When it needs
to install something, either run `sudo -v` first (caches your password for
~15 minutes) or just run the `sudo` line yourself when Claude shows it.

**Getting files between Windows and Ubuntu:** type `explorer.exe .` in
Ubuntu to open the current folder in Windows Explorer. Very handy.

**Everything lives in Ubuntu now.** Install Python packages, run the server,
and run `claude` from the Ubuntu tab — not from PowerShell. In particular
Pedal Bakery's **BAKE** button shells out to the `claude` CLI, so the server
and Claude Code have to be on the same side. They both are, if you followed
the steps above.

## Optional, once you're comfortable

- **VS Code** — install on Windows, add the **WSL** extension, then type
  `code .` in Ubuntu to open your project. Best of both worlds.
- **Claude Code in VS Code** — there's an extension, so you get the agent
  next to your editor instead of in a separate window.
