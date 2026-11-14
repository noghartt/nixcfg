{
  # Downloaded scripts hardcode interpreters (`#!/bin/bash`), but NixOS only
  # ships /bin/sh and /usr/bin/env. envfs serves /bin and /usr/bin from the
  # caller's PATH, so those shebangs resolve without editing each script.
  services.envfs.enable = true;
}
