{ fetchFromGitHub
, stdenvNoCC
, makeWrapper
, img2pdf
, zathura
, lib 
}:

let
  pname = "manga-cli";
  version = "1.0";
in
stdenvNoCC.mkDerivation {
  inherit pname version;

  src = fetchFromGitHub {
    owner = "7USTIN";
    repo = "manga-cli";
    rev = "a69fe935341eaf96618a6b2064d4dcb36c8690b5";
    sha256 = "sha256-AnpOEgOBt2a9jtPNvfBnETGtc5Q1WBmSRFDvQB7uBE4=";
  };

  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall

    install -Dm755 manga-cli $out/bin/manga-cli

    wrapProgram $out/bin/manga-cli \
      --prefix PATH : ${lib.makeBinPath [ img2pdf zathura ]}

    runHook postInstall
  '';

  meta = with lib; {
    homepage = "https://github.com/7USTIN/manga-cli";
    description = "A CLI tool to browse and read mangas similar to ani-cli";
    license = licenses.gpl3Plus;
    maintainers = with maintainers; [ ];
    platforms = platforms.unix;
  };
}
