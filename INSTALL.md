# Mellon Installation

This runbook is destructive. It wipes mellon's configured Kingston NVMe and
creates an encrypted NixOS installation with machine-local Secure Boot keys.

## Firmware Preparation

1. Update the ASUS BIOS/AGESA.
2. Boot the installer in UEFI mode.
3. Disable Secure Boot and put the firmware in Setup Mode by clearing its keys.
4. Disable overclocking, PBO, Curve Optimizer, and EXPO until the base system passes stress tests.

Confirm the installer exposes EFI variables and that the hard-coded Disko
target is the intended drive:

```bash
test -d /sys/firmware/efi/efivars
readlink -f /dev/disk/by-id/nvme-KINGSTON_SFYRDK2000G_50026B7283A261E1
lsblk -o NAME,SIZE,MODEL,SERIAL,FSTYPE,MOUNTPOINTS
```

Disconnect or back up any drive that cannot be safely wiped.

## Disk Installation

From the repository root, create the temporary passphrase file in the
installer's memory-backed `/run`. Enter the intended passphrase carefully;
Disko consumes the file non-interactively.

```bash
read -rsp "LUKS passphrase: " luks_pass && printf '\n'
read -rsp "Confirm LUKS passphrase: " luks_confirm && printf '\n'
[ "$luks_pass" = "$luks_confirm" ] || { unset luks_pass luks_confirm; exit 1; }
sudo install -m 600 /dev/null /run/disko-luks-password
printf %s "$luks_pass" | sudo tee /run/disko-luks-password >/dev/null
unset luks_pass luks_confirm
sudo disko --mode disko --flake .#mellon
sudo rm -f /run/disko-luks-password
```

The resulting storage stack remains:

```text
2G ESP + LUKS cryptlvm + LVM vg
vg-root: 500G Btrfs, including a 64G swapfile
vg-home: remaining space, Btrfs
```

Generate only detected hardware details; Disko remains the sole source of
filesystem and swap declarations:

```bash
sudo nixos-generate-config --root /mnt --no-filesystems --show-hardware-config \
  > hosts/mellon/hardware-configuration.nix
nix eval .#nixosConfigurations.mellon.config.system.build.toplevel.drvPath
```

## Secure Boot Bootstrap

Install without a bootloader first because the target's signing keys do not
exist yet:

```bash
sudo nixos-install --root /mnt --flake .#mellon --no-root-passwd --no-bootloader
sudo nixos-enter --root /mnt -c 'sbctl create-keys'
sudo nixos-enter --root /mnt -c '/nix/var/nix/profiles/system/bin/switch-to-configuration boot'
sudo nixos-enter --root /mnt -c 'passwd noghartt'
```

Reboot once with Secure Boot still disabled. Confirm the installation boots,
then enroll the generated keys while the firmware remains in Setup Mode:

```bash
sudo sbctl verify
sudo sbctl enroll-keys --microsoft
```

Including Microsoft certificates keeps firmware and NVIDIA option ROMs
bootable. Reboot into firmware settings, enable Secure Boot, and verify:

```bash
sbctl status
bootctl status
```

Back up `/var/lib/sbctl` to a secure offline location. It contains private
Secure Boot keys and must never enter Git or the Nix store.

## Encryption Recovery

Add a distinct recovery passphrase after the first boot and store it outside
the machine, such as in 1Password:

```bash
sudo cryptsetup luksAddKey /dev/disk/by-partlabel/disk-main-lvm
sudo cryptsetup luksDump /dev/disk/by-partlabel/disk-main-lvm
```

Normal boot and hibernation resume prompt for a LUKS passphrase in the signed
initrd. No passphrase or key is embedded in this repository.

## Post-Install Validation

Calculate the new swapfile offset, add it to `hosts/mellon/boot.nix`, rebuild,
and test hibernation. Recalculate this value whenever the swapfile is recreated.

```bash
sudo btrfs inspect-internal map-swapfile -r /swap/swapfile
sudo nixos-rebuild boot --flake .#mellon
```

Validate the hardware and maintenance paths before enabling firmware tuning:

```bash
iw reg get
resolvectl status
systemctl --failed
systemctl list-timers
swapon --show
sudo smartctl -a /dev/nvme0
nvidia-smi
```

Test TTY login, `sudo`, Ethernet at 2.5 Gb/s, Wi-Fi with Bluetooth active,
audio, monitor refresh rates, Docker GPU passthrough, repeated suspend/resume,
and hibernation with substantial GPU memory in use.

Mellon's kernel, NVIDIA module, Linux firmware, wireless regulatory data, and
AMD microcode come from the independently locked `nixpkgs-hardware` input.
Update it separately from userspace only after repeating these hardware tests.
