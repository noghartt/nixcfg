# ~/.omo/omo.jsonc, OmO Native's agent and category model chains.
{ version }:
{ pkgs, ... }:
let
  jsonFormat = pkgs.formats.json { };
  rung = model: reasoning: { inherit model reasoning; };
  claude = model: "anthropic-subscription/${model}";
  gpt = model: "chatgpt-subscription/${model}";
in
{
  home.file.".omo/omo.jsonc".source = jsonFormat.generate "omo.jsonc" {
    "$schema" =
      "https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/v${version}/assets/omo.schema.json";

    # OmO rewrites this file for every config migration not recorded here, and
    # a read-only store link would make it retry on each start. The content is
    # already in each migration's target shape: `[native]` scope, `models`
    # chains, `deep-low`, and current provider names.
    _migrations = [
      "2026-08-reasoning-unification"
      "2026-09-category-deep-split"
      "2026-09-harness-native-rename"
      # Only warns about `[opencode]` model settings, and this file has none.
      "2026-09-opencode-routing-notice"
      "2026-09-subscription-provider-rename"
    ];

    # OmO defaults it to {}, but the published schema lists it as required.
    profiles = { };

    # Route tasks among the five models in the interactive picker. Keep
    # cross-provider rungs so a provider-wide outage (429/5xx/529) can fall
    # back to the other login. Claude Haiku 4.5 is never used. No rung goes above
    # `high`: xhigh is reserved for the orchestrator leader, and the builtin
    # plan-consultant/plan-reviewer chains run at max/xhigh.
    # Recheck the builtin chains in omo-task.js when bumping OmO.
    "[native]" = {
      agents = {
        # The builtin chains try providers we have no login for, then Haiku.
        explore.models = [
          (rung (claude "claude-sonnet-5-5") "low")
          (rung (gpt "gpt-6-sol") "low")
        ];
        librarian.models = [
          (rung (claude "claude-sonnet-5-5") "low")
          (rung (gpt "gpt-6-sol") "low")
        ];
        plan-consultant.models = [
          (rung (claude "claude-fable-5-1") "high")
          (rung (claude "claude-opus-5-5") "high")
          (rung (gpt "gpt-6-astra") "high")
        ];
        plan-reviewer.models = [
          (rung (gpt "gpt-6-astra") "high")
          (rung (claude "claude-opus-5-5") "high")
        ];
      };

      categories = {
        visual-engineering.models = [
          (rung (claude "claude-fable-5-1") "high")
          (rung (claude "claude-opus-5-5") "high")
          (rung (gpt "gpt-6-astra") "high")
        ];
        architect.models = [
          (rung (claude "claude-fable-5-1") "high")
          (rung (gpt "gpt-6-astra") "high")
        ];
        ultrabrain.models = [
          (rung (gpt "gpt-6-astra") "high")
          (rung (gpt "gpt-6-sol") "high")
          (rung (claude "claude-fable-5-1") "high")
        ];
        deep-low.models = [
          (rung (gpt "gpt-6-sol") "medium")
          (rung (claude "claude-opus-5-5") "medium")
          (rung (claude "claude-sonnet-5-5") "medium")
        ];
        deep-high.models = [
          (rung (gpt "gpt-6-astra") "high")
          (rung (claude "claude-fable-5-1") "high")
        ];
        artistry.models = [
          (rung (claude "claude-fable-5-1") "high")
          (rung (claude "claude-opus-5-5") "high")
          (rung (gpt "gpt-6-astra") "high")
        ];
        # The builtin quick chain ends on Haiku for our logins.
        quick.models = [
          (rung (claude "claude-sonnet-5-5") "low")
          (rung (gpt "gpt-6-sol") "low")
        ];
        unspecified-high.models = [
          (rung (claude "claude-opus-5-5") "medium")
          (rung (gpt "gpt-6-sol") "medium")
        ];
        writing.models = [
          (rung (claude "claude-opus-5-5") "low")
          (rung (claude "claude-sonnet-5-5") "low")
          (rung (gpt "gpt-6-sol") "low")
        ];
      };
    };
  };
}
