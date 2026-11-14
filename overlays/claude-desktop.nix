# Anthropic's Claude Desktop for Linux (beta), repackaged from the official .deb: Anthropic
# ships the Linux build only through its apt repository, so the bundled binaries are patched
# for the Nix store. The app does not update itself on Linux; bump version and hash here
# (newest `Filename:` in
# https://downloads.claude.ai/claude-desktop/apt/stable/dists/stable/main/binary-amd64/Packages).
_: prev:
let
  version = "5.11492.2";

  # Loaded with dlopen at runtime, so autoPatchelf cannot see them in DT_NEEDED.
  runtimeLibs = with prev; [
    libGL
    libnotify
    libpulseaudio
    libsecret
    libxkbcommon
    libdrm
    mesa
    pipewire
    systemd
    wayland
    libxscrnsaver
    libxtst
  ];
in
{
  claude-desktop = prev.stdenv.mkDerivation {
    pname = "claude-desktop";
    inherit version;

    src = prev.fetchurl {
      url = "https://downloads.claude.ai/claude-desktop/apt/stable/pool/main/c/claude-desktop/claude-desktop_${version}_amd64.deb";
      hash = "sha256-0QlE+lZjuZdADPZsXHc4/WrPZU+KrqyluZTrFHqms18=";
    };

    nativeBuildInputs = with prev; [
      autoPatchelfHook
      dpkg
      makeShellWrapper
      wrapGAppsHook3
    ];

    buildInputs = with prev; [
      alsa-lib
      at-spi2-atk
      at-spi2-core
      cairo
      cups
      dbus
      expat
      glib
      gtk3
      libcap_ng
      libgbm
      libseccomp
      libxkbcommon
      nspr
      nss
      pango
      pipewire
      systemd
      stdenv.cc.cc.lib
      libx11
      libxcb
      libxcomposite
      libxdamage
      libxext
      libxfixes
      libxrandr
    ];

    runtimeDependencies = runtimeLibs;

    unpackPhase = ''
      runHook preUnpack
      # chrome-sandbox is setuid in the .deb, which the build sandbox refuses to recreate.
      dpkg-deb --fsys-tarfile "$src" | tar -x --no-same-owner --no-same-permissions
      runHook postUnpack
    '';

    dontConfigure = true;
    dontBuild = true;
    # gappsWrapperArgs are folded into the single makeWrapper call below.
    dontWrapGApps = true;

    # The postinst only registers the apt repo, the MIME types, and a GNOME search provider;
    # the MIME types are the part worth keeping. NixOS allows unprivileged user namespaces,
    # so the namespace sandbox is used and chrome-sandbox stays unprivileged.
    installPhase = ''
      runHook preInstall

      mkdir -p "$out/bin" "$out/lib" "$out/share/mime/packages"
      cp -r usr/lib/claude-desktop "$out/lib/"
      cp -r usr/share/icons usr/share/applications "$out/share/"
      cp usr/lib/claude-desktop/resources/linux-mime/com.anthropic.Claude.xml \
        "$out/share/mime/packages/"

      substituteInPlace "$out/share/applications/com.anthropic.Claude.desktop" \
        --replace-fail "Exec=claude-desktop" "Exec=$out/bin/claude-desktop"

      runHook postInstall
    '';

    # Ozone flags follow nixpkgs' Electron apps: native Wayland only when the session opts in
    # with NIXOS_OZONE_WL and a Wayland display exists, otherwise XWayland. A shell wrapper,
    # since wrapGAppsHook3 makes makeWrapper binary, which cannot expand that. bubblewrap and
    # socat are the package's recommends for sandboxing Claude Code sessions.
    postFixup = ''
      makeShellWrapper "$out/lib/claude-desktop/claude-desktop" "$out/bin/claude-desktop" \
        "''${gappsWrapperArgs[@]}" \
        --prefix LD_LIBRARY_PATH : ${prev.lib.makeLibraryPath runtimeLibs} \
        --prefix PATH : ${prev.lib.makeBinPath [ prev.xdg-utils ]} \
        --suffix PATH : ${
          prev.lib.makeBinPath [
            prev.bubblewrap
            prev.socat
          ]
        } \
        --add-flags "\''${NIXOS_OZONE_WL:+\''${WAYLAND_DISPLAY:+--ozone-platform-hint=auto --enable-features=WaylandWindowDecorations --enable-wayland-ime=true}}"
    '';

    meta = {
      description = "Anthropic's Claude desktop app (Linux beta)";
      homepage = "https://claude.ai";
      license = prev.lib.licenses.unfree;
      mainProgram = "claude-desktop";
      platforms = [ "x86_64-linux" ];
      sourceProvenance = with prev.lib.sourceTypes; [ binaryNativeCode ];
    };
  };
}
