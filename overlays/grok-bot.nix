# Cursor's Grok Bot desktop agent, repackaged from the vendor's .deb: an Electron app that
# ships only as a Debian/Ubuntu package, so its bundled binaries are patched for the Nix store.
_: prev:
let
  version = "0.78.1";
  commit = "72e130b4e6be3fdc47b97e809b6b420908ce2dd8";

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
  grok-bot = prev.stdenv.mkDerivation {
    pname = "grok-bot";
    inherit version;

    src = prev.fetchurl {
      url = "https://downloads.cursor.com/grokbot/stable/${commit}/linux/x64/grok-bot_${version}_amd64.deb";
      hash = "sha256-VdKjTP/3YjQiUf+psTIacPCLYD8if4huGLLBxec97R0=";
    };

    nativeBuildInputs = with prev; [
      autoPatchelfHook
      dpkg
      makeWrapper
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
      libgbm
      libxkbcommon
      nspr
      nss
      pango
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
      dpkg-deb -x "$src" .
      runHook postUnpack
    '';

    dontConfigure = true;
    dontBuild = true;
    # gappsWrapperArgs are folded into the single makeWrapper call below.
    dontWrapGApps = true;

    # The .deb's "/opt/Grok Bot" path holds a space, which Electron's SUID sandbox fallback
    # cannot exec from; the app finds its resources relative to its own binary, so a plain
    # directory name works. NixOS allows unprivileged user namespaces, so the namespace
    # sandbox is used and chrome-sandbox stays unprivileged.
    installPhase = ''
      runHook preInstall

      mkdir -p "$out/bin" "$out/share"
      cp -r "opt/Grok Bot" "$out/libexec"
      cp -r usr/share/icons usr/share/applications "$out/share/"

      substituteInPlace "$out/share/applications/grok-bot.desktop" \
        --replace-fail "Exec=grok-bot" "Exec=$out/bin/grok-bot"

      runHook postInstall
    '';

    # Ozone flags follow nixpkgs' Electron apps: native Wayland only when the session opts in
    # with NIXOS_OZONE_WL and a Wayland display exists, otherwise XWayland.
    postFixup = ''
      makeWrapper "$out/libexec/grok-bot" "$out/bin/grok-bot" \
        "''${gappsWrapperArgs[@]}" \
        --prefix LD_LIBRARY_PATH : ${prev.lib.makeLibraryPath runtimeLibs} \
        --prefix PATH : ${prev.lib.makeBinPath [ prev.xdg-utils ]} \
        --add-flags "\''${NIXOS_OZONE_WL:+\''${WAYLAND_DISPLAY:+--ozone-platform-hint=auto --enable-features=WaylandWindowDecorations --enable-wayland-ime=true}}"
    '';

    meta = {
      description = "Grok Bot desktop agent from Cursor";
      homepage = "https://cursor.com";
      license = prev.lib.licenses.unfree;
      mainProgram = "grok-bot";
      platforms = [ "x86_64-linux" ];
      sourceProvenance = with prev.lib.sourceTypes; [ binaryNativeCode ];
    };
  };
}
