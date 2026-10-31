# Live guitar through Guitarix on PipeWire's JACK layer (enabled in desktop.nix).
{
  # The default 1024-frame quantum (~21 ms per period) is audible between
  # picking a string and hearing the amp. Only Guitarix asks for 128 frames, so
  # the graph runs that small only while it plays, and games and Bluetooth keep
  # the larger default otherwise. The binary is the Nix wrapper's .guitarix-wrapped.
  services.pipewire.extraConfig.jack."10-guitarix-latency"."jack.rules" = [
    {
      matches = [ { "application.process.binary" = "~^\\.?guitarix"; } ];
      actions.update-props."node.latency" = "128/48000";
    }
  ];

  # Guitarix mlockall()s so its audio thread never waits on paged-out memory;
  # the default 8 MiB memlock limit makes that fail. Applied at login (greetd's
  # PAM stack), so it needs a fresh session after the rebuild.
  security.pam.loginLimits = [
    {
      domain = "@audio";
      item = "memlock";
      type = "-";
      value = "unlimited";
    }
  ];
}
