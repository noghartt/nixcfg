# Reports Pi and OmO session state to Herdr, so both show in its agent list.
# Herdr only spots agents by process name: `omo` is not one it knows, and an
# OmO pane whose Claude subscription child is in the foreground passes for
# `claude`. Herdr's own Pi integration (`herdr integration install pi`)
# already reports state from Pi's lifecycle hooks, but it writes into the
# home directory, and OmO, which loads this same package list, would report
# itself as `pi`. This builds it from the pinned Herdr source, so it follows
# Herdr bumps, and names OmO sessions `omo` with a source of their own.
# `--replace-fail` stops the build if upstream reshapes the lines it patches.
{ flake, pkgs, ... }:
let
  piHerdrState = pkgs.runCommand "pi-herdr-state" { } ''
    mkdir -p "$out"
    cp ${flake.inputs.herdr}/src/integration/assets/pi/herdr-agent-state.ts "$out/index.ts"
    chmod u+w "$out/index.ts"
    substituteInPlace "$out/index.ts" \
      --replace-fail 'const source = "herdr:pi";' \
        'const agentName = process.env.OMO_NATIVE ? "omo" : "pi";
    const source = process.env.OMO_NATIVE ? "nixcfg:omo" : "herdr:pi";' \
      --replace-fail 'agent: "pi",' 'agent: agentName,'
    cat > "$out/package.json" <<'EOF'
    {
      "name": "pi-herdr-state",
      "version": "1.0.0",
      "private": true,
      "keywords": ["pi-package"],
      "pi": { "extensions": ["./index.ts"] }
    }
    EOF
  '';
in
{
  programs.pi-coding-agent.settings.packages = [ piHerdrState ];
}
