{
  pname,
  version,
  meta,
  cmake,
  fetchpatch,
  ffmpeg,
  fontconfig,
  hunspell,
  hyphen,
  icu,
  imagemagick,
  libjpeg,
  libmtp,
  libpng,
  libstemmer,
  libuchardet,
  libusb1,
  libwebp,
  optipng,
  piper-tts,
  pkg-config,
  podofo,
  poppler_utils,
  python3Packages,
  qt6,
  speechd-minimal,
  sqlite,
  xdg-utils,
  wrapGAppsHook3,
  popplerSupport ? true,
  speechSupport ? true,
  unrarSupport ? false,
}:

{
  inherit pname version meta;

  src = fetchurl {
    url = "https://download.calibre-ebook.com/${version}/calibre-${version}.tar.xz";
    hash = "sha256-RmCte6tok0F/ts5cacAFBksNYfnLylY4JCmTyb+6IUk=";
  };

  patches = [
    #  allow for plugin update check, but no calibre version check
    (fetchpatch {
      name = "0001-only-plugin-update.patch";
      url = "https://raw.githubusercontent.com/debian-calibre/calibre/debian/${version}+ds-1/debian/patches/0001-only-plugin-update.patch";
      hash = "sha256-mHZkUoVcoVi9XBOSvM5jyvpOTCcM91g9+Pa/lY6L5p8=";
    })
    (fetchpatch {
      name = "0007-Hardening-Qt-code.patch";
      url = "https://raw.githubusercontent.com/debian-calibre/calibre/debian/${version}+ds-1/debian/patches/hardening/0007-Hardening-Qt-code.patch";
      hash = "sha256-9hi4T9LB7aklWASMR8hIuKBgZm2arDvORfmk9S8wgCA=";
    })
  ] ++ lib.optional (!unrarSupport) ./dont_build_unrar_plugin.patch;

  prePatch = ''
    sed -i "s@\[tool.sip.project\]@[tool.sip.project]\nsip-include-dirs = [\"${python3Packages.pyqt6}/${python3Packages.python.sitePackages}/PyQt6/bindings\"]@g" \
      setup/build.py

    # Remove unneeded files and libs
    rm -rf src/odf resources/calibre-portable.*
  '';

  dontUseQmakeConfigure = true;
  dontUseCmakeConfigure = true;

  nativeBuildInputs = [
    cmake
    pkg-config
    qt6.qmake
    qt6.wrapQtAppsHook
    wrapGAppsHook3
  ];

  buildInputs = [
    ffmpeg
    fontconfig
    hunspell
    hyphen
    icu
    imagemagick
    libjpeg
    libmtp
    libpng
    libstemmer
    libuchardet
    libusb1
    piper-tts
    podofo
    poppler_utils
    qt6.qtbase
    qt6.qtwayland
    sqlite
    (python3Packages.python.withPackages (
      ps:
      with ps;
      [
        (apsw.overrideAttrs (_oldAttrs: {
          setupPyBuildFlags = [ "--enable=load_extension" ];
        }))
        beautifulsoup4
        css-parser
        cssselect
        python-dateutil
        dnspython
        faust-cchardet
        feedparser
        html2text
        html5-parser
        lxml
        markdown
        mechanize
        msgpack
        netifaces
        pillow
        pychm
        pykakasi
        pyqt-builder
        pyqt6
        python
        regex
        sip
        setuptools
        zeroconf
        jeepney
        pycryptodome
        xxhash
        # the following are distributed with calibre, but we use upstream instead
        odfpy
      ]
      ++
        lib.optionals (lib.lists.any (p: p == stdenv.hostPlatform.system) pyqt6-webengine.meta.platforms)
          [
            # much of calibre's functionality is usable without a web
            # browser, so we enable building on platforms which qtwebengine
            # does not support by simply omitting qtwebengine.
            pyqt6-webengine
          ]
      ++ lib.optional unrarSupport unrardll
    ))
    xdg-utils
  ] ++ lib.optional speechSupport speechd-minimal;

  installPhase = ''
    runHook preInstall

    export HOME=$TMPDIR/fakehome
    export POPPLER_INC_DIR=${poppler_utils.dev}/include/poppler
    export POPPLER_LIB_DIR=${poppler_utils.out}/lib
    export MAGICK_INC=${imagemagick.dev}/include/ImageMagick
    export MAGICK_LIB=${imagemagick.out}/lib
    export FC_INC_DIR=${fontconfig.dev}/include/fontconfig
    export FC_LIB_DIR=${fontconfig.lib}/lib
    export PODOFO_INC_DIR=${podofo.dev}/include/podofo
    export PODOFO_LIB_DIR=${podofo.lib}/lib
    export XDG_DATA_HOME=$out/share
    export XDG_UTILS_INSTALL_MODE="user"
    export PIPER_TTS_DIR=${piper-tts}/bin

    python setup.py install --root=$out \
      --prefix=$out \
      --libdir=$out/lib \
      --staging-root=$out \
      --staging-libdir=$out/lib \
      --staging-sharedir=$out/share

    PYFILES="$out/bin/* $out/lib/calibre/calibre/web/feeds/*.py
      $out/lib/calibre/calibre/ebooks/metadata/*.py
      $out/lib/calibre/calibre/ebooks/rtf2xml/*.py"

    sed -i "s/env python[0-9.]*/python/" $PYFILES
    sed -i "2i import sys; sys.argv[0] = 'calibre'" $out/bin/calibre

    mkdir -p $out/share
    cp -a man-pages $out/share/man

    runHook postInstall
  '';

  # Wrap manually
  dontWrapQtApps = true;
  dontWrapGApps = true;

  preFixup =
    let
      popplerArgs = "--prefix PATH : ${poppler_utils.out}/bin";
    in
    ''
      for program in $out/bin/*; do
        wrapProgram $program \
          ''${qtWrapperArgs[@]} \
          ''${gappsWrapperArgs[@]} \
          --prefix PATH : ${
            lib.makeBinPath [
              libjpeg
              libwebp
              optipng
            ]
          } \
          ${if popplerSupport then popplerArgs else ""}
      done
    '';

  doInstallCheck = true;
  installCheckInputs = with python3Packages; [
    fonttools
    psutil
  ];

  installCheckPhase = ''
    runHook preInstallCheck

    ETN='--exclude-test-name'
    EXCLUDED_FLAGS=(
      $ETN 'test_7z'  # we don't include 7z support
      $ETN 'test_zstd'  # we don't include zstd support
      $ETN 'test_qt'  # we don't include svg or webp support
      $ETN 'test_import_of_all_python_modules'  # explores actual file paths, gets confused
      $ETN 'test_websocket_basic'  # flakey
      ${lib.optionalString (!unrarSupport) "$ETN 'test_unrar'"}
    )

    python setup.py test ''${EXCLUDED_FLAGS[@]}

    runHook postInstallCheck
  '';
}
