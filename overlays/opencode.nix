# opencode 2.2.5's node_modules hash went stale when bun moved to 1.4.4 right after the bump
# (NixOS/nixpkgs#582673), and the output differs between Linux and Darwin. This pins the hash
# measured on aarch64-darwin and steps aside once nixpkgs changes the broken one.
_: prev:
let
  broken = "sha256-xfOVcw1+waLVNhFDwzOtzxrUSQEogvn88YomydOlhwc=";
in
{
  opencode =
    if prev.opencode.node_modules.outputHash == broken then
      prev.opencode.overrideAttrs (old: {
        node_modules = old.node_modules.overrideAttrs {
          outputHash = "sha256-dIveiaiPFGSItwLyeMuPDxTE9gpvvnlTCB/+nG24qCc=";
        };
      })
    else
      prev.opencode;
}
