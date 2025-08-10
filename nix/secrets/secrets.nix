let
  noghartt = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIARS+0vXFBYyjIDpf5bngDMJ5TwUE39BW/FiEpXdC2YY";
in
{
  "user-name.age".publicKeys  = [ noghartt ];
  "user-email.age".publicKeys = [ noghartt ];
}
