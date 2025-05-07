_:

{
  programs.ghostty = {
    enable = true;

    # TODO: I need to see a way to overlay the HM program to allow it to override the wrong path.
    # In case, we're retrieving it from vendor_conf.d, it should be vendor_completions.d instead.
    enableFishIntegration = false;

    settings = {
      theme = "GruvboxLight";
    };
  };
}
