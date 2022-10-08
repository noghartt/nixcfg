{ lib, buildGoModule, fetchFromGitHub }:

buildGoModule rec {
  name = "gh-stars";
  version = "0.19.24";

  src = fetchFromGitHub {
    owner = "gkze";
    repo = "gh-stars";
    rev = "v${version}";
    sha256 = "sha256-quMqXW3O4MYD1rOB8n4F54Lwcel8uH6UI7tBVZnalhM=";
  };

  vendorSha256 = "sha256-wWX0P/xysioCCUS3M2ZIKd8i34Li/ANbgcql3oSE6yc==";

  subPackages = [ "cmd/stars" ];

  meta = with lib; {
    description = "None";
    homepage = "https://github.com/gkze/gh-stars";
    license = licenses.mit;
  };
}