final: prev:

let
  inherit (prev) callPackage;

  pythonPackageExtensionsOverrides = self: super: {
    bean-price = callPackage ./bean-price {
      inherit (super) buildPythonPackage isPy3k;
    };

    beancount = super.beancount.overrideAttrs (oldAttrs: {
      postInstall = ''
        ${oldAttrs.postInstall or ""}
        if [ -f $out/bin/bean-price ]; then
          rm $out/bin/bean-price
        fi
      '';
    });
  };
in
{
  pythonPackagesExtensions = prev.pythonPackagesExtensions ++ [pythonPackageExtensionsOverrides];

  calibre = callPackage ./calibre { };

  ghostty = callPackage ./ghostty { };

  nodePackages = prev.nodePackages // callPackage ./node-packages { };
}
