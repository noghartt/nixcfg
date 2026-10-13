# ~/.omo/agent/models.json: per-model overrides of OmO's built-in catalog.
{ lib, pkgs, ... }:
let
  # Interactive, task-chain, and orchestrator worker models; keep in sync.
  models = {
    anthropic-subscription = [
      "claude-opus-5-5"
      "claude-sonnet-5-5"
      "claude-fable-5-1"
    ];
    chatgpt-subscription = [
      "gpt-6-sol"
      "gpt-6-astra"
      "gpt-5.6-terra"
    ];
  };

  # Images are stored in the session as encoded, and each turn rebuilds the
  # request around all of them. The 2000px / 4.5 MiB default kept Retina
  # screenshots at ~4.5 MB each: one monobloco session held 217 MB of them,
  # costing ~0.8 GB to load and up to ~0.9 GB more per turn. Claude downscales
  # past ~1568px anyway, so this cap costs no model-visible detail.
  inputLimits.images.resize = {
    maxWidth = 1568;
    maxHeight = 1568;
    maxBytes = 750000;
    jpegQuality = 75;
  };
in
{
  home.file.".omo/agent/models.json".source = (pkgs.formats.json { }).generate "omo-models.json" {
    providers = lib.mapAttrs (_: ids: {
      modelOverrides = lib.genAttrs ids (_: {
        inherit inputLimits;
      });
    }) models;
  };
}
