# Mellon Installation

This runbook installs the `mellon` NixOS configuration from scratch. It follows
the same progression as the
[previous Arch guide](https://gist.github.com/noghartt/8388f7d8543e3eb1777cb6ed4a3d7807),
but NixOS, Disko, Home Manager, and Lanzaboote now own the system declaratively.

Mellon shares its NVMe with an existing Windows install. The storage steps add
two partitions in the space Windows left free and format only those; Windows'
partitions, including its own ESP, are never touched. The Linux side is sized to
whatever free space it gets (at least about 1 TB for the sizes below):

```text
GPT (shared with Windows: its ESP, MSR, C:, and recovery partitions stay as-is)
├── disk-main-ESP: 2 GiB Linux ESP mounted at /boot
└── disk-main-lvm: LUKS2 cryptlvm
    └── LVM volume group vg
        ├── root: 500 GiB Btrfs
        │   ├── @          -> /
        │   ├── @nix       -> /nix
        │   ├── @var_log   -> /var/log
        │   └── @snapshots -> /.snapshots
        ├── agents: 300 GiB Btrfs
        │   └── @agent     -> /agent (agent sandboxes)
        └── home: remaining space, Btrfs
            └── @home      -> /home
```

The normal boot flow is UEFI -> Lanzaboote-signed systemd-boot -> encrypted
systemd initrd -> LUKS -> LVM -> Btrfs. Swap is zram (compressed RAM); Mellon
runs 24/7 and never hibernates. No encryption or Secure Boot private key is
stored in Git or the Nix store.

## Before Installation

### Back up the current machine

1. Push or copy every uncommitted repository.
2. Back up `/home` and verify that important files can be restored.
3. Preserve any local GPG, SSH, age, or application data that is not in
   1Password or another backup.
4. Confirm access to the GitHub account and the 1Password account from another
   device.
5. Create or verify a 1Password Emergency Kit and recovery path.

### Prepare Windows

Do this in Windows before touching the firmware:

1. Save the BitLocker recovery key (Settings > Privacy & security > Device
   encryption, or `manage-bde -protectors -get C:`) somewhere off the machine,
   such as 1Password. Erasing the Platform Key and enrolling Mellon's own
   Secure Boot keys changes what the TPM measures, so Windows asks for this key
   once on its next boot. Alternatively suspend BitLocker for a few reboots:
   `manage-bde -protectors -disable C: -RebootCount 3`.
2. Turn off Fast Startup (Control Panel > Power Options > Choose what the power
   buttons do), so Windows fully shuts down instead of hibernating its disk.
3. Make sure the free space for Linux is unallocated: in Disk Management it must
   show as a black "Unallocated" bar, not an empty NTFS volume. Shrink C: there
   if needed.

Windows keeps the hardware clock in local time; Mellon is configured to match
(`time.hardwareClockInLocalTime`), so neither OS shifts the other's clock.

### Prepare the installer

Download the current x86_64 NixOS installer from
[nixos.org/download](https://nixos.org/download/), verify it using the checksums
published by NixOS, and write it to a USB drive. When using `dd`, replace
`/dev/sdX` with the whole USB device, not one of its partitions:

```bash
lsblk -o NAME,SIZE,MODEL,TRAN,MOUNTPOINTS
sudo umount /dev/sdX* 2>/dev/null || true
sudo dd if=nixos.iso of=/dev/sdX bs=4M status=progress oflag=sync
sudo eject /dev/sdX
```

That command destroys the selected USB drive. Check `lsblk` again immediately
before running it.

### Prepare the firmware

1. Update the ASUS BIOS/AGESA to a tested stable release.
2. Set UEFI-only boot and disable Compatibility Support Module (CSM).
3. Disable Secure Boot enforcement and erase only the Platform Key (`PK`) to
   enter Setup Mode. Do not choose **Clear All Secure Boot Keys** because that
   can erase the forbidden-signature database (`dbx`). The local keys are
   created after NixOS is installed.
4. Disable overclocking, PBO, Curve Optimizer, and EXPO until the base system
   passes stress tests.
5. Select the NixOS USB's UEFI boot entry.

## Installer Environment

### Connect to the network

Ethernet is preferred during installation. For Wi-Fi, start NetworkManager and
use its text UI:

```bash
sudo systemctl start NetworkManager
nmtui
ping -c 3 cache.nixos.org
```

### Confirm UEFI mode and select the target disk

`hosts/mellon/disk.nix` names no drive: it formats the partitions labelled
`disk-main-ESP` and `disk-main-lvm`, which you create below, so the drive is
chosen here, once, and a new SSD needs no repository change. Disconnect every
drive you are not installing to, then identify the target by model, serial,
and size:

```bash
test -d /sys/firmware/efi/efivars
sudo bootctl status
lsblk -d -o NAME,SIZE,MODEL,SERIAL,TRAN
ls -l /dev/disk/by-id/ | grep -v -- '-part[0-9]*$' | grep nvme-
```

Pick the `nvme-<MODEL>_<SERIAL>` entry whose serial matches the drive's label
(not an `nvme-eui.*` alias), and keep it in this shell for the rest of the
installation:

```bash
disk=/dev/disk/by-id/nvme-<MODEL>_<SERIAL>
readlink -f "$disk"
lsblk -o NAME,SIZE,MODEL,SERIAL,FSTYPE,MOUNTPOINTS "$disk"
```

Stop if `readlink` fails or `lsblk` shows anything other than the intended
system drive, with Windows' partitions on it.

### Clone the configuration

Clone the `main` branch into the live environment. The old `v2` branch is
stale; do not install from it.

```bash
git clone --branch main https://github.com/noghartt/nixcfg.git /tmp/nixcfg
cd /tmp/nixcfg
git status --short
git log -1 --format='%h %s'
nix --extra-experimental-features 'nix-command flakes' \
  eval .#nixosConfigurations.mellon.config.system.build.toplevel.drvPath
```

Push every pending change from the development machine before install day.
The evaluation must succeed before touching the disk.

## Disk Installation

### Add the Linux partitions

Print the partition table and check the free space Windows left. The
`Total free space` line and the gaps between partition boundaries must show one
block large enough for Linux:

```bash
sudo sgdisk -p "$disk"
```

Create the two Linux partitions. A start or end of `0` means the start and end
of the largest free block, so both land in that block and no existing
partition moves; partition number `0` takes the next free number:

```bash
sudo sgdisk --new=0:0:+2G --typecode=0:ef00 --change-name=0:disk-main-ESP "$disk"
sudo sgdisk --new=0:0:0 --typecode=0:8309 --change-name=0:disk-main-lvm "$disk"
sudo partprobe "$disk"
sudo udevadm settle
sudo sgdisk -p "$disk"
ls -l /dev/disk/by-partlabel/disk-main-ESP /dev/disk/by-partlabel/disk-main-lvm
```

Check that Windows' partitions are unchanged and that the two new ones are the
sizes you expect before continuing.

### Create the temporary LUKS secret

Disko needs a non-interactive passphrase file. Keep it in `/run`, which is
memory-backed and disappears at shutdown:

```bash
read -rsp "LUKS passphrase: " luks_pass && printf '\n'
read -rsp "Confirm LUKS passphrase: " luks_confirm && printf '\n'
[ "$luks_pass" = "$luks_confirm" ] || {
  unset luks_pass luks_confirm
  exit 1
}

sudo install -m 600 /dev/null /run/disko-luks-password
printf %s "$luks_pass" | sudo tee /run/disko-luks-password >/dev/null
unset luks_pass luks_confirm

cleanup_luks_secret() {
  sudo rm -f /run/disko-luks-password
}
trap cleanup_luks_secret EXIT INT TERM
```

This initial passphrase is required at every boot until another LUKS key slot is
configured. Use a strong passphrase that can be entered with the US console
layout.

### Partition, encrypt, and mount

Build Mellon's Disko format-and-mount script from the flake's own locked Disko.
It formats only the two labelled partitions: the ESP as vfat, and the other as
LUKS with LVM and Btrfs inside. It never repartitions the drive. Do not use
Disko's `destroy` modes on this machine.

```bash
script="$(nix --extra-experimental-features 'nix-command flakes' \
  build --no-link --print-out-paths \
  .#nixosConfigurations.mellon.config.system.build.formatMount)"
sudo "$script"/bin/disko-format-mount
```

Regardless of whether Disko succeeds, immediately remove the passphrase file
before investigating or continuing:

```bash
sudo rm -f /run/disko-luks-password
trap - EXIT INT TERM
unset -f cleanup_luks_secret
unset script
```

Confirm the resulting mounts:

```bash
findmnt --real --submounts /mnt
sudo btrfs subvolume list /mnt
sudo btrfs subvolume list /mnt/agent
sudo lvs
sudo cryptsetup status cryptlvm
```

### Preserve the checkout on the installed system

Copy the checkout onto the mounted home volume. The final ownership is applied
after NixOS creates the declared user.

```bash
sudo install -d /mnt/home/noghartt/www
sudo cp -a /tmp/nixcfg /mnt/home/noghartt/www/nixcfg
cd /mnt/home/noghartt/www/nixcfg
```

### Generate Mellon's hardware configuration

Generate only detected hardware declarations. Disko remains the sole source of
filesystem and swap configuration:

```bash
sudo nixos-generate-config \
  --root /mnt \
  --no-filesystems \
  --show-hardware-config \
  | sudo tee hosts/mellon/hardware-configuration.nix >/dev/null

nix --extra-experimental-features 'nix-command flakes' \
  eval .#nixosConfigurations.mellon.config.system.build.toplevel.drvPath
```

Inspect the generated file. It must describe detected hardware, not duplicate
filesystems, swap, NVIDIA policy, or the hand-written settings in
`hosts/mellon/hardware.nix`.

## Base Installation

### Install without a bootloader

Lanzaboote cannot sign boot artifacts until this machine's keys exist. Install
the system closure first while deliberately skipping bootloader activation:

```bash
sudo nixos-install \
  --root /mnt \
  --flake .#mellon \
  --no-root-passwd \
  --no-bootloader
```

The root account remains without a password and is not used for normal login.

### Create Secure Boot keys and install the bootloader

Create machine-local keys inside the installed system, activate the signed boot
configuration, and set the normal user's login password:

```bash
sudo nixos-enter --root /mnt -c 'sbctl create-keys'
sudo nixos-enter --root /mnt -c \
  '/nix/var/nix/profiles/system/bin/switch-to-configuration boot'
sudo nixos-enter --root /mnt -c 'passwd noghartt'
sudo nixos-enter --root /mnt -c \
  'chown -R noghartt:users /home/noghartt'
```

Verify that files exist under `/mnt/var/lib/sbctl` and that the ESP contains a
bootloader before rebooting:

```bash
sudo find /mnt/var/lib/sbctl -maxdepth 2 -type f
findmnt /mnt/boot
sudo ls /mnt/boot/EFI/systemd
```

Reboot with Secure Boot still disabled:

```bash
cd /
sudo umount -R /mnt
sudo reboot
```

Remove the installer USB when the firmware restarts.

## Secure Boot Enrollment

Log in as `noghartt`, open a terminal, and verify the signed files while the
firmware is still in Setup Mode:

```bash
cd ~/www/nixcfg
sudo sbctl status
sudo sbctl verify
```

Enroll the local keys together with Microsoft's certificates. The Microsoft
certificates retain compatibility with firmware and GPU option ROMs:

```bash
sudo sbctl enroll-keys --microsoft
sudo sbctl status
```

Reboot into firmware settings, enable Secure Boot, then boot NixOS and verify:

```bash
sudo sbctl status
bootctl status
```

`sbctl status` should report Secure Boot enabled and Setup Mode disabled. Back up
`/var/lib/sbctl` to encrypted offline storage. It contains private keys and must
never enter Git, cloud sync, or the Nix store.

Confirm that the firmware's forbidden-signature database survived enrollment:

```bash
sudo stat -c '%n %s bytes' /sys/firmware/efi/efivars/dbx-*
```

Investigate if no `dbx` variable exists or its payload is empty before treating
Secure Boot as complete.

### Boot Windows

Windows Boot Manager stays on Windows' own ESP, which systemd-boot does not
scan, so it is not in Mellon's boot menu. Choose it from the firmware boot menu
(F8 on ASUS boards), or boot it once from Linux:

```bash
sudo efibootmgr                      # note Windows Boot Manager's BootXXXX number
sudo efibootmgr --bootnext XXXX && systemctl reboot
```

Boot Windows once now. If it asks for the BitLocker recovery key, enter the one
saved before installation; it re-seals to the new Secure Boot state. Windows
updates sometimes move Windows Boot Manager to the front of the boot order; put
"Linux Boot Manager" back first with `sudo efibootmgr --bootorder` or in the
firmware. Windows' Secure Boot `dbx` updates can also change what the TPM
measures, so expect one LUKS passphrase boot and TPM re-enrollment afterwards
(see below).

## First Boot Setup

### Check out and record the generated hardware file

The install checkout should already be at `~/www/nixcfg`:

```bash
cd ~/www/nixcfg
sudo chown -R noghartt:users .
git status --short
git diff -- hosts/mellon/hardware-configuration.nix
```

Commit and push the generated hardware configuration after confirming it
contains no filesystem declarations or unexpected data. Future rebuilds use
this checkout:

```bash
sudo nixos-rebuild switch --flake .#mellon
```

### Add a LUKS recovery passphrase

Add a second, distinct passphrase and store it outside Mellon, such as in
1Password. Keep the install passphrase until the recovery key has been tested:

```bash
sudo cryptsetup luksAddKey /dev/disk/by-partlabel/disk-main-lvm
sudo cryptsetup luksDump /dev/disk/by-partlabel/disk-main-lvm
```

Reboot once and test the recovery passphrase before relying on it.

### Enroll TPM2 unlock with a PIN

Mellon's measured-boot policy binds TPM unlock to Lanzaboote's verified boot
chain and Secure Boot state. Enroll only after Secure Boot is enabled and the
recovery passphrase above has been tested:

```bash
systemd-analyze has-tpm2
sudo /run/current-system/systemd/lib/systemd/systemd-pcrlock is-supported
sudo test -s /var/lib/systemd/pcrlock.json
sudo systemd-cryptenroll \
  --tpm2-device=auto \
  --tpm2-pcrlock=/var/lib/systemd/pcrlock.json \
  --tpm2-with-pin=true \
  /dev/disk/by-partlabel/disk-main-lvm
sudo cryptsetup luksDump /dev/disk/by-partlabel/disk-main-lvm
```

Choose a PIN distinct from the LUKS passphrases. Normal boots request this PIN;
if the TPM is cleared or the measured boot policy no longer matches, the signed
initrd falls back to a LUKS passphrase. Never remove every passphrase slot.

Reboot and test both TPM PIN unlock and recovery-passphrase fallback before
depending on the TPM token. BIOS updates, Secure Boot key or `dbx` changes, TPM
resets, and motherboard replacement can require one passphrase boot and TPM
reenrollment.

### Configure 1Password and opnix

1. Sign in to the 1Password desktop application.
2. Enable its SSH agent under **Settings > Developer > Use the SSH agent**.
3. Create a service account restricted to the `Nix` vault.
4. In that vault, create an item named `git` whose Notes field contains exactly:

```ini
[user]
	name = <name>
	email = <email>
```

Provision the service-account token without writing it to shell history:

```bash
mkdir -p ~/.config/opnix
opnix token -path ~/.config/opnix/token set
chmod 600 ~/.config/opnix/token
sudo nixos-rebuild switch --flake ~/www/nixcfg#mellon
git config --get user.name
git config --get user.email
```

The token and generated Git identity file stay outside the repository. Never
commit either file.

### Authenticate optional services

Only run the services that are wanted on this machine:

```bash
gh auth login
sudo tailscale up --accept-dns=true --accept-routes=false
warp-cli registration new
warp-cli mode tunnel_only
warp-cli tunnel ip list
warp-cli connect
```

The 1Password SSH agent supplies Git SSH keys. Tailscale is the persistent
personal VPN and owns DNS; WARP is an on-demand work tunnel in traffic-only
mode. The organization-managed WARP profile must exclude `100.64.0.0/10` and
`fd7a:115c:a1e0::/48`. If work policy rejects traffic-only mode or controls split
tunnels, request those settings from the WARP administrator rather than adding
manual default routes. Do not use a Tailscale exit node while WARP is connected.

### Enable SSH over the tailnet

Mellon runs 24/7 and never suspends. sshd accepts keys only and listens only
on the tailnet interface, so `tailscale up` above must have succeeded first.
Authorized keys come from 1Password: in the `Nix` vault, create an item named
`ssh-authorized-keys` whose Notes field holds the public keys allowed to log in,
one per line (copy them from the SSH Key items in 1Password). Then rebuild and
check that opnix wrote them:

```bash
sudo nixos-rebuild switch --flake ~/www/nixcfg#mellon
ls -l ~/.ssh/authorized_keys
systemctl status sshd
```

On the Mac, forward the 1Password agent to Mellon so Git and SSH there sign
through the Mac while a session is open. Add to `~/.ssh/config`:

```sshconfig
Host mellon
  ForwardAgent "~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
```

sshd allows three authentication attempts, and the 1Password agent offers
every key it holds. If 1Password holds more than three SSH keys, download the
key's public half to `~/.ssh/mellon.pub` and add `IdentityFile ~/.ssh/mellon.pub`
and `IdentitiesOnly yes` to that block. Then, from the Mac:

```bash
ssh mellon 'echo ok'
ssh -t mellon 'ls -l ~/.ssh/agent.sock && ssh -T git@github.com'
```

`~/.ssh/agent.sock` points at the forwarded agent of the latest interactive
login, so tmux or Herdr sessions that outlive a connection keep signing through
the next one. With no live forwarded agent, Mellon falls back to its local
1Password app.

## Validation Checklist

### System health

```bash
systemctl --failed
systemctl list-timers --all
journalctl -b -p warning
findmnt -t btrfs,vfat
zramctl
sudo snapper -c root list
sudo smartctl -a /dev/nvme0
fwupdmgr get-devices
```

### Network and peripherals

```bash
iw reg get
resolvectl status
nmcli device status
bluetoothctl show
wpctl status
```

Test Ethernet at 2.5 Gb/s, Wi-Fi while Bluetooth is active, microphone and
speaker routing, all USB devices, and monitor refresh rates. The RTL8922AE has
young driver support; if Wi-Fi becomes unstable, repeat the test with Bluetooth
disabled before changing kernel or NetworkManager settings.

### NVIDIA and desktop

```bash
nvidia-smi
lsmod | grep '^nvidia'
docker run --rm --gpus all nvidia/cuda:13.0.0-base-ubuntu24.04 nvidia-smi
```

Verify greetd login, Hyprland, Noctalia, screen locking, idle screen-off,
audio, and Firefox hardware acceleration. `systemctl suspend` must be refused:
Mellon stays up 24/7.

Mellon's kernel, firmware, wireless regulatory data, and AMD microcode come from
the independently locked `nixpkgs-hardware` input. NVIDIA 595.84 is pinned in
`hosts/mellon/nvidia.nix`, with the Blackwell defaults supplied by
`nixos-hardware`. Update either hardware input only as a deliberate change and
repeat this validation checklist afterward.

## Recovery

### Enter the installed system from the NixOS USB

Boot the installer with Secure Boot disabled, unlock LUKS, activate LVM, and
mount each declared subvolume:

```bash
sudo cryptsetup open /dev/disk/by-partlabel/disk-main-lvm cryptlvm
sudo vgchange -ay

sudo mount -o subvol=@ /dev/vg/root /mnt
sudo mkdir -p /mnt/{boot,nix,home,agent,var/log,.snapshots}
sudo mount -o subvol=@nix /dev/vg/root /mnt/nix
sudo mount -o subvol=@var_log /dev/vg/root /mnt/var/log
sudo mount -o subvol=@snapshots /dev/vg/root /mnt/.snapshots
sudo mount -o subvol=@agent /dev/vg/agents /mnt/agent
sudo mount -o subvol=@home /dev/vg/home /mnt/home
sudo mount /dev/disk/by-partlabel/disk-main-ESP /mnt/boot
sudo nixos-enter --root /mnt
```

From the entered system, rebuild a known-good revision or repair Lanzaboote. If
the Secure Boot keys are intact:

```bash
cd /home/noghartt/www/nixcfg
nixos-rebuild boot --flake .#mellon
exit
```

Unmount in reverse order before rebooting:

```bash
sudo umount -R /mnt
sudo vgchange -an
sudo cryptsetup close cryptlvm
sudo reboot
```

### Secure Boot failure

If firmware rejects the bootloader, disable Secure Boot but leave UEFI mode
enabled. When booted into Mellon, restore the backup to `/var/lib/sbctl`. From a
live installer with Mellon mounted at `/mnt`, restore it to
`/mnt/var/lib/sbctl`. Rebuild the boot generation, verify signatures with
`sbctl verify`, and reenroll the keys before enabling Secure Boot again.

### Lost encryption credentials

There is no bypass for LUKS. If every enrolled passphrase is lost, restore data
from the off-machine backup onto a fresh installation.
