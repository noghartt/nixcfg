{
  lib,
  pkgs,
  ...
}:
let
  fakeSha512 = lib.convertHash {
    hash = lib.fakeSha512;
    toHashFormat = "sri";
    hashAlgo = "sha512";
  };

  piClaudeBridge = pkgs.buildNpmPackage {
    pname = "pi-claude-bridge";
    version = "0.5.0";

    src = pkgs.fetchFromGitHub {
      owner = "elidickinson";
      repo = "pi-claude-bridge";
      rev = "0c0feef83284b71a7cf2b5779e86ca2e8f75ce4c";
      hash = "sha256-N6hRLcbOlQyQ0coP6YTqn1k5JQlwP/qx/m8tWfySxyI=";
    };

    npmDepsHash = "sha256-ulsVwgw9cdZpQaOf21XvospYs6goPiF/jvpFe1OSAQo=";
    npmDepsFetcherVersion = 2;
    npmInstallFlags = [ "--omit=dev" ];
    dontNpmBuild = true;

    # Pi package lock files can omit integrity hashes for development dependencies.
    prePatch = ''
      ${lib.getExe pkgs.jq} 'walk(if type == "object" and has("resolved") and (has("integrity") | not) then . + {"integrity": "${fakeSha512}"} else . end)' package-lock.json > fixed-package-lock.json
      mv fixed-package-lock.json package-lock.json
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out
      cp -r . $out/
      runHook postInstall
    '';
  };
in
{
  programs.pi-coding-agent.settings.packages = [ piClaudeBridge ];

  home.file.".pi/agent/claude-bridge.json".text = builtins.toJSON {
    askClaude.enabled = false;
    provider = {
      plan = "max";
      strictMcpConfig = true;
      pathToClaudeCodeExecutable = lib.getExe pkgs.claude-code;
    };
  };
}
