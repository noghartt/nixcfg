_:

{
  launchd = {
    user = {
      agents = {
        beancount-fava = {
          command = "/opt/homebrew/bin/fava $HOME/ledger/*.bean";
          serviceConfig = {
            UserName = "noghartt";
            KeepAlive = true;
            RunAtLoad = true;
            StandardOutPath = "/tmp/fava_beancount.out.log";
            StandardErrorPath = "/tmp/fava_beancount.err.log";
          };
        };
      };
    };
  };
}
