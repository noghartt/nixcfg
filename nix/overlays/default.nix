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
        rm $out/bin/bean-price
      '';
    });
  };
in
{
  pythonPackagesExtensions = prev.pythonPackagesExtensions ++ [pythonPackageExtensionsOverrides];

  calibre = callPackage ./calibre { };
}
