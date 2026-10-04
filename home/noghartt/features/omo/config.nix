# ~/.omo/omo.jsonc, OmO Native's agent and category model chains.
{ version }:
{ pkgs, ... }:
let
  jsonFormat = pkgs.formats.json { };
  rung = model: reasoning: { inherit model reasoning; };
  claude = model: "anthropic/${model}";
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

    # Each chain keeps the builtin rungs (plugin/extensions/omo-task.js) that
    # our two logins reach, in order, then appends the same-tier model from the
    # other provider: outages are provider-wide, so OmO's runtime fallback
    # (429/5xx/529) needs a rung on the other login, and staying in-tier keeps
    # a fallback from jumping price. Tiers: claude-fable-5-1 / gpt-6-astra and
    # claude-opus-5-5 / gpt-5.6-sol. Chains that already cross providers
    # (plan-reviewer, unspecified-low) stay builtin. Claude Haiku 4.5 is never
    # used: chains that fell back to it fall back to Sonnet 5.5 instead.
    # Re-derive these from omo-task.js when bumping the OmO version.
    "[native]" = {
      agents = {
        # The builtin explore/librarian chains try Kimi, DeepSeek, Qwen, and
        # MiniMax rungs we have no login for, then land on claude-haiku-4-5;
        # Sonnet 5.5 is the newest fast Claude, and GPT-6 Luna is its cross-provider pair.
        explore.models = [
          (rung (claude "claude-sonnet-5-5") "low")
          (rung (gpt "gpt-6-luna-fast") "low")
        ];
        librarian.models = [
          (rung (claude "claude-sonnet-5-5") "low")
          (rung (gpt "gpt-6-luna-fast") "low")
        ];
        plan-consultant.models = [
          (rung (claude "claude-fable-5-1") "max")
          (rung (claude "claude-opus-5-5") "max")
          (rung (gpt "gpt-6-astra") "max")
        ];
      };

      categories = {
        visual-engineering.models = [
          (rung (claude "claude-fable-5-1") "max")
          (rung (claude "claude-opus-5-5") "max")
          (rung (gpt "gpt-6-astra") "max")
        ];
        architect.models = [
          (rung (claude "claude-fable-5-1") "max")
          (rung (gpt "gpt-6-astra") "max")
        ];
        ultrabrain.models = [
          (rung (gpt "gpt-6-astra") "max")
          (rung (gpt "gpt-5.6-sol") "max")
          (rung (claude "claude-fable-5-1") "max")
        ];
        deep-low.models = [
          (rung (gpt "gpt-6.1-sol") "medium")
          (rung (gpt "gpt-6.1-sol-fast") "medium")
          (rung (gpt "gpt-5.6-sol") "medium")
          (rung (gpt "gpt-5.6-sol-fast") "medium")
          (rung (claude "claude-opus-5-5") "medium")
        ];
        deep-high.models = [
          (rung (gpt "gpt-6-astra") "high")
          (rung (claude "claude-fable-5-1") "high")
        ];
        artistry.models = [
          (rung (claude "claude-fable-5-1") "max")
          (rung (claude "claude-opus-5-5") "max")
          (rung (gpt "gpt-6-astra") "max")
        ];
        # The builtin quick chain ends on claude-haiku-4-5 for our logins.
        quick.models = [
          (rung (gpt "gpt-6-luna-fast") "low")
          (rung (claude "claude-sonnet-5-5") "low")
        ];
        unspecified-high.models = [
          (rung (claude "claude-opus-5-5") "medium")
          (rung (gpt "gpt-5.6-sol") "medium")
        ];
        writing.models = [
          (rung (claude "claude-opus-5-5") "low")
          (rung (claude "claude-opus-4-6") "max")
          (rung (gpt "gpt-5.6-sol") "low")
        ];
      };
    };
  };
}
