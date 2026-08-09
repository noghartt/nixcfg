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
    version = "0.6.3";

    src = pkgs.fetchFromGitHub {
      owner = "elidickinson";
      repo = "pi-claude-bridge";
      rev = "fac372c4fedabc247eda48ddec2363a52dc8c4d8";
      hash = "sha256-nqGVZfiMb9g4NyP/WcPNvq8U8mtAT+a+JI0uwKaTTQE=";
    };

    npmDepsHash = "sha256-d/MUvK4pSmd8wH3Po9h8YH6l6IKUIKoN7JwobnlmeW0=";
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
