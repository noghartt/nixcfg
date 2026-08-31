# Palantir Installation

This runbook bootstraps the `palantir` nix-darwin configuration on the M5 work
MacBook Pro. It assumes macOS Setup Assistant has already created the existing
`noghartt` administrator account. Nix-darwin does not create or own that account.

Corporate MDM policy takes precedence. If it owns an application or blocks Nix
store applications, adjust the shared feature imported by
`home/noghartt/palantir.nix` rather than installing a second competing copy.

## Prerequisites

1. Finish Setup Assistant and all required MDM enrollment.
2. Confirm the short account name is `noghartt` with `id -un`. Update the user
   factory and `system.primaryUser` before activation if it differs.
3. Install Nix with the official multi-user installer from
   [nixos.org](https://nixos.org/download/). The configuration intentionally
   leaves `nix.enable = true` so nix-darwin can manage that installation.
4. Clone this repository into the existing account and enter the checkout.

## Bootstrap

Evaluate before changing the system:

```bash
nix eval .#darwinConfigurations.palantir.system.drvPath
```

Bootstrap nix-darwin using its upstream runner, then let the pinned flake build
and activate palantir:

```bash
sudo nix run nix-darwin/master#darwin-rebuild -- \
  switch --flake .#palantir
```

Run the first activation from a local graphical session. Home Manager copies
the managed application bundles into `~/Applications/Home Manager Apps`; macOS
may request App Management permission during that activation.

Subsequent updates use the installed command:

```bash
nix eval .#darwinConfigurations.palantir.system.drvPath
sudo darwin-rebuild switch --flake .#palantir
```

## Validate

```bash
scutil --get LocalHostName
darwin-rebuild --list-generations
nix-store --verify --check-contents
```

Confirm Chrome, Firefox, Ghostty, and Claude Code launch, and that Spotlight can
find the three graphical applications. Keep work identities, device serials,
MDM identifiers, tokens, and employer-specific settings outside this repository.
