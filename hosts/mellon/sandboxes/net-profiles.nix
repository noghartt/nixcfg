# Egress profiles for agent sandboxes (`agentbox net NAME PROFILE`, or
# `agentbox ensure ... --net PROFILE`). A profile either allows any public IPv4
# (`any = true`) or only the addresses its `domains` (each with all of its
# subdomains) resolve to through the sandbox resolver; no domains means no
# egress at all, not even DNS. New sandboxes get `default`; sandboxes created
# before profiles existed have none recorded and stay `open`.
#
# Domain allowlists are enforced on resolved IPv4 addresses, so they leak: CDNs
# (Fastly, Cloudflare, Akamai, cloud load balancers) serve many unrelated sites
# from the addresses an allowed name resolves to, and an address stays allowed
# until the resolver restarts. They keep well-behaved tools on the expected
# hosts; they do not contain hostile code, which can also reach an allowed
# service (a GitHub repo, a registry) with its own credentials.
{
  default = "dev";
  profiles = {
    none = { };

    dev.domains = [
      # GitHub: web, API, codeload, raw/objects/release assets, container registry.
      "github.com"
      "githubusercontent.com"
      "ghcr.io"
      # Nix substituters and channels.
      "nixos.org"
      "cachix.org"
      "flakehub.com"
      # JavaScript registries (bun installs from npm's).
      "npmjs.org"
      "npmjs.com"
      "yarnpkg.com"
      "bun.sh"
      # Python.
      "pypi.org"
      "pythonhosted.org"
      # Rust (crates and rustup).
      "crates.io"
      "rust-lang.org"
      # Go module proxy and checksum database.
      "golang.org"
      # Docker Hub (registry, auth, blob CDN).
      "docker.io"
      "docker.com"
      # Model APIs the harnesses inside a sandbox call, and Jev (TypeSafe).
      "anthropic.com"
      "claude.ai"
      "openai.com"
      "chatgpt.com"
      "typesafe.ai"
    ];

    open.any = true;
  };
}
