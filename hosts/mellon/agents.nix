# Mellon as the always-on host for coding agents (OmO sessions and, later,
# their sandboxes; see TASK.md).
{
  # Prebuilt glibc binaries expect /lib64/ld-linux-x86-64.so.2, which NixOS
  # lacks: the OmO release binary, the runtime it unpacks, and whatever tools
  # agents download. nix-ld supplies that loader.
  programs.nix-ld.enable = true;

  # Keep the user manager running with nobody logged in, so user services and
  # OmO's per-session scopes work over SSH and after a reboot.
  users.users.noghartt.linger = true;
}
