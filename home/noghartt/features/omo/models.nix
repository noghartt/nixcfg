# ~/.omo/agent/models.json: per-model overrides of OmO's built-in catalog, plus
# the Refuseless custom provider.
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

  # OmO compacts at a share of the window (0.7 up to 512k, 0.8 above, nudged by
  # past compaction yield), so the native 1M window let these sessions grow to
  # ~800k before compacting, and every turn re-read all of it. A 300k planning
  # window (the served default) compacts them near 210k. It also bounds each
  # request's max_tokens to window - prompt - 4096, ~12k at the hard limit.
  windowCaps.anthropic-subscription =
    lib.genAttrs
      [
        "claude-opus-5-5"
        "claude-sonnet-5-5"
      ]
      (_: {
        contextWindow = 300000;
      });

  # Refuseless: OpenAI-compatible hosting of refusal-removed open weights
  # (https://docs.refuseless.com). The key comes from 1Password through
  # secrets-env.nix, so the model only works in an `omo` started from a shell
  # that has REFUSELESS_API_KEY. Limits, reasoning levels and prices come from
  # GET https://api.refuseless.com/v1/models; GLM 5.3 takes text only.
  refuseless = {
    baseUrl = "https://api.refuseless.com/v1";
    api = "openai-completions";
    apiKey = "$REFUSELESS_API_KEY";
    models = [
      {
        id = "glm-5.3-abliterated";
        name = "GLM 5.3 Abliterated";
        reasoning = true;
        # reasoning_effort accepts only low, high and max here; anything else,
        # including off and medium, is a 400.
        thinkingLevelMap = {
          off = null;
          minimal = null;
          low = "low";
          medium = null;
          high = "high";
          xhigh = null;
          max = "max";
        };
        input = [ "text" ];
        contextWindow = 1048576;
        maxTokens = 131072;
        # USD per million tokens; Refuseless lists no cache-write price.
        cost = {
          input = 1;
          output = 2;
          cacheRead = 0.15;
          cacheWrite = 0;
        };
      }
    ];
  };
in
{
  home.file.".omo/agent/models.json".source = (pkgs.formats.json { }).generate "omo-models.json" {
    providers =
      lib.mapAttrs (provider: ids: {
        modelOverrides = lib.genAttrs ids (
          id: { inherit inputLimits; } // windowCaps.${provider}.${id} or { }
        );
      }) models
      // {
        inherit refuseless;
      };
  };
}
