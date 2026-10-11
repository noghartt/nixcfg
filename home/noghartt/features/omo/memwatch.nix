# macOS has no per-process memory cap, so a runaway omo (one reached 20 GB)
# swaps the whole machine into the ground. This agent records what such a
# process holds and stops it past a hard limit; see memwatch.sh.
{ pkgs, ... }:
let
  memwatch = pkgs.writeShellApplication {
    name = "omo-memwatch";
    text = builtins.readFile ./memwatch.sh;
  };
in
{
  launchd.agents.omo-memwatch = {
    enable = true;
    config = {
      ProgramArguments = [ "${memwatch}/bin/omo-memwatch" ];
      EnvironmentVariables = {
        OMO_MEMWATCH_WARN_MB = "4096";
        # Half of Palantir's 24 GB.
        OMO_MEMWATCH_KILL_MB = "12288";
      };
      StartInterval = 30;
      RunAtLoad = true;
      ProcessType = "Background";
      LowPriorityIO = true;
    };
  };
}
