args @ { lib, inputs, ... }:

let
  inherit (inputs) home-manager;
in
config:
lib.forEach config.imports (imp: import imp (args // { inherit (home-manager) lib; inherit (config) username; }))
