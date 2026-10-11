# Mellon runs 24/7 as an agent host: it never suspends or hibernates. The
# screen still locks and blanks (Noctalia's idle settings); only system sleep
# is refused, so a stray suspend key or menu entry cannot take it offline.
{
  systemd.sleep.settings.Sleep = {
    AllowSuspend = "no";
    AllowHibernation = "no";
    AllowHybridSleep = "no";
    AllowSuspendThenHibernate = "no";
  };

  services.logind.settings.Login = {
    HandleSuspendKey = "ignore";
    HandleHibernateKey = "ignore";
    IdleAction = "ignore";
  };
}
