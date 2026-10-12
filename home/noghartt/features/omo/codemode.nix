# OmO's eval tool (senpi-codemode) reads this from ~/.senpi/agent, not ~/.omo.
{ pkgs, ... }:
{
  home.file.".senpi/agent/codemode.json".source = (pkgs.formats.json { }).generate "codemode.json" {
    # A worker-thread kernel shares the omo process, so browser and screenshot
    # cells left gigabytes there that only quitting the session gave back. In a
    # child process that memory is freed when the kernel restarts, and a kernel
    # crash or OOM no longer takes the session down. The child runs on the
    # nixpkgs `bun` the omo launcher puts on PATH (default.nix).
    isolation.js = "process";
    memory = {
      # Default is a quarter of RAM (6 GB here); recycle the kernel sooner.
      ceilingMb = 4096;
      # Idle sessions pile up across Herdr tabs; close their kernels after
      # 30 minutes (globals are lost, the next cell starts a fresh kernel).
      idleParkMinutes = 30;
    };
  };
}
