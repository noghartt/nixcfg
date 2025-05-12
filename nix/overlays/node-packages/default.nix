{ lib, buildNpmPackage, fetchurl, nodejs }:

{
  "@github/copilot-language-server" = buildNpmPackage rec {
    name = "copilot-language-server-release";
    packageName = "@github/copilot-language-server";
    version = "1.318.0";

    src = fetchurl {
      url = "https://registry.npmjs.org/@github/copilot-language-server/-/copilot-language-server-${version}.tgz";
      sha512 = "sha512-tP+0AWrPJMOxOG4P+FOk3VJelzwMymhPqbhPWuQ9512UbZdz9aMvXL3SYieZpV5oAqX5evLKiArEXY6tu/aXtA==";
    };

    dontNpmBuild = true;

    npmDepsHash = "sha256-OvXOSDLQJuoQMh/AZQR+doJe+5N+aJ3Hadb06t49I8I=";

    postPatch = ''
      touch package-lock.json
      ls -la .
      cat << EOF > package-lock.json
        {
          "name": "@github/copilot-language-server",
          "version": "1.318.0",
          "lockfileVersion": 3,
          "requires": true,
          "packages": {
            "": {
                "name": "@github/copilot-language-server",
                "version": "1.318.0",
                "license": "https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features",
                "dependencies": {
                    "vscode-languageserver-protocol": "^3.17.5"
                },
                "bin": {
                    "copilot-language-server": "dist/language-server.js"
                }
            },
            "node_modules/vscode-jsonrpc": {
                "version": "8.2.0",
                "resolved": "https://registry.npmjs.org/vscode-jsonrpc/-/vscode-jsonrpc-8.2.0.tgz",
                "integrity": "sha512-C+r0eKJUIfiDIfwJhria30+TYWPtuHJXHtI7J0YlOmKAo7ogxP20T0zxB7HZQIFhIyvoBPwWskjxrvAtfjyZfA==",
                "license": "MIT",
                "engines": {
                    "node": ">=14.0.0"
                }
            },
            "node_modules/vscode-languageserver-protocol": {
                "version": "3.17.5",
                "resolved": "https://registry.npmjs.org/vscode-languageserver-protocol/-/vscode-languageserver-protocol-3.17.5.tgz",
                "integrity": "sha512-mb1bvRJN8SVznADSGWM9u/b07H7Ecg0I3OgXDuLdn307rl/J3A9YD6/eYOssqhecL27hK1IPZAsaqh00i/Jljg==",
                "license": "MIT",
                "dependencies": {
                    "vscode-jsonrpc": "8.2.0",
                    "vscode-languageserver-types": "3.17.5"
                }
            },
            "node_modules/vscode-languageserver-types": {
                "version": "3.17.5",
                "resolved": "https://registry.npmjs.org/vscode-languageserver-types/-/vscode-languageserver-types-3.17.5.tgz",
                "integrity": "sha512-Ld1VelNuX9pdF39h2Hgaeb5hEZM2Z3jUrrMgWQAu82jMtZp7p3vJT3BzToKtZI7NgQssZje5o0zryOrhQvzQAg==",
                "license": "MIT"
            }
          }
      }
      EOF
      '';

    meta = with lib; {
      description = "GitHub Copilot language server";
      homepage = "https://github.com/github/copilot-language-server";
      license = licenses.unfree; # Adjust as needed
    };
  };
}
