final: prev:

let
  pythonOverrides = {
    packageOverrides = self: super: {
      bean-price = prev.callPackage ./bean-price {
        inherit (super) buildPythonPackage isPy3k;
      };
    };
  };
in
{
  python39 = prev.python39.override pythonOverrides;
  python312 = prev.python312.override pythonOverrides;
}
