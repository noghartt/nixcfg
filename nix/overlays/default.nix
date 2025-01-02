final: prev:

let
  pythonOverrides = {
    packageOverrides = self: super: {
      bean-price = prev.callPackage ./bean-price {
        inherit (super) buildPythonPackage isPy3k;
      };

      beancount = super.beancount.overrideAttrs (oldAttrs: {
        postInstall = ''
          ${oldAttrs.postInstall or ""}
          rm $out/bin/bean-price
        '';
      });
    };
  };
in
{
  python39 = prev.python39.override pythonOverrides;
  python312 = prev.python312.override pythonOverrides;
}
