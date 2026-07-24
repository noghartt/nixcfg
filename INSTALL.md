# Mellon Installation

This runbook installs the `mellon` NixOS configuration from scratch. It follows
the same progression as the
[previous Arch guide](https://gist.github.com/noghartt/8388f7d8543e3eb1777cb6ed4a3d7807),
but NixOS, Disko, Home Manager, and Lanzaboote now own the system declaratively.

The storage step is destructive. It wipes the configured 2 TB Kingston NVMe and
creates this layout:

```text
GPT
├── 2 GiB ESP mounted at /boot
└── LUKS2 cryptlvm
    └── LVM volume group vg
        ├── root: 500 GiB Btrfs
        │   ├── @          -> /
        │   ├── @nix       -> /nix
        │   ├── @var_log   -> /var/log
        │   ├── @snapshots -> /.snapshots
        │   └── @swap      -> /swap (64 GiB swapfile)
        └── home: remaining space, Btrfs
            └── @home      -> /home
```

The normal boot flow is UEFI -> Lanzaboote-signed systemd-boot -> encrypted
systemd initrd -> LUKS -> LVM -> Btrfs. No encryption or Secure Boot private key
is stored in Git or the Nix store.

## Before Installation

### Back up the current machine

1. Push or copy every uncommitted repository.
2. Back up `/home` and verify that important files can be restored.
3. Preserve any local GPG, SSH, age, or application data that is not in
   1Password or another backup.
4. Confirm access to the GitHub account and the 1Password account from another
   device.
5. Create or verify a 1Password Emergency Kit and recovery path.

Disko creates a new partition table and filesystems. It is not a forensic erase;
use the NVMe manufacturer's sanitize procedure separately if that is required.

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
   passes stress, suspend, and hibernation tests.
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

### Confirm UEFI mode and the target disk

```bash
test -d /sys/firmware/efi/efivars
sudo bootctl status
readlink -f /dev/disk/by-id/nvme-KINGSTON_SFYRDK2000G_50026B7283A261E1
lsblk -o NAME,SIZE,MODEL,SERIAL,FSTYPE,MOUNTPOINTS
```

Stop if the by-id path is absent or resolves to anything other than Mellon's
Kingston 2 TB system drive. Disconnect every drive that cannot safely be wiped.
Do not substitute another path merely to make the command succeed; first update
`hosts/mellon/disk.nix` after verifying the physical device.

### Clone the configuration

The Mellon work currently lives on the `v2` branch. Clone it into the live
environment:

```bash
git clone --branch v2 https://github.com/noghartt/nixcfg.git /tmp/nixcfg
cd /tmp/nixcfg
git status --short
required_commit=d22f22b7078aa13d1f015a3c85251c48a18aecc3
git merge-base --is-ancestor "$required_commit" HEAD || {
  printf 'Refusing install: origin/v2 does not contain %s\n' "$required_commit"
  exit 1
}
nix --extra-experimental-features 'nix-command flakes' \
  eval .#nixosConfigurations.mellon.config.system.build.toplevel.drvPath
unset required_commit
```

Commit `d22f22b` must be pushed from the trusted development machine before
install day; without it, `origin/v2` has the old unencrypted layout. Both the
ancestry check and evaluation must succeed before touching the disk.

## Disk Installation

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

### Run the locked Disko version

Read Disko's exact revision from `flake.lock`, then partition, encrypt, format,
and mount the drive at `/mnt`:

```bash
disko_rev="$(nix --extra-experimental-features 'nix-command flakes' \
  eval --raw --impure --expr \
  '(builtins.fromJSON (builtins.readFile ./flake.lock)).nodes.disko.locked.rev')"

sudo nix --extra-experimental-features 'nix-command flakes' \
  run "github:nix-community/disko/${disko_rev}#disko" -- \
  --mode disko --flake .#mellon
```

Regardless of whether Disko succeeds, immediately remove the passphrase file
before investigating or continuing:

```bash
sudo rm -f /run/disko-luks-password
trap - EXIT INT TERM
unset -f cleanup_luks_secret
unset disko_rev
```

Confirm the resulting mounts and swapfile:

```bash
findmnt --real --submounts /mnt
sudo btrfs subvolume list /mnt
sudo test -f /mnt/swap/swapfile
sudo btrfs inspect-internal map-swapfile /mnt/swap/swapfile
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
sudo tailscale up
warp-cli registration new
warp-cli connect
```

The 1Password SSH agent supplies Git SSH keys. Tailscale and Cloudflare WARP are
independent VPNs; do not expect both routes to be active simultaneously without
explicit routing policy.

## Hibernation

The swapfile's physical offset exists only after Disko creates the filesystem.
Calculate it:

```bash
sudo btrfs inspect-internal map-swapfile -r /swap/swapfile
```

Add the returned integer to `boot.kernelParams` in `hosts/mellon/boot.nix`:

```nix
kernelParams = [ "resume_offset=<returned-integer>" ];
```

Build the next boot generation, reboot so the kernel receives the parameter,
then test hibernation:

```bash
sudo nixos-rebuild boot --flake ~/www/nixcfg#mellon
sudo reboot
cat /sys/power/resume
cat /sys/power/resume_offset
systemctl hibernate
```

Recalculate the offset whenever `/swap/swapfile` is recreated.

## Validation Checklist

### System health

```bash
systemctl --failed
systemctl list-timers --all
journalctl -b -p warning
findmnt -t btrfs,vfat
swapon --show
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

Verify greetd login, Hyprland, Noctalia, screen locking, idle suspend, audio,
Firefox hardware acceleration, repeated suspend/resume, and hibernation while
GPU memory is in use.

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
sudo mkdir -p /mnt/{boot,nix,home,var/log,.snapshots,swap}
sudo mount -o subvol=@nix /dev/vg/root /mnt/nix
sudo mount -o subvol=@var_log /dev/vg/root /mnt/var/log
sudo mount -o subvol=@snapshots /dev/vg/root /mnt/.snapshots
sudo mount -o subvol=@swap /dev/vg/root /mnt/swap
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
