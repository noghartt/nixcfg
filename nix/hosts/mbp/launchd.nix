_:

let
  beancount_ledger_folder = "$HOME/ledger";
in
{
  launchd = {
    user = {
      agents = {
        beancount-fava = {
          command = "/opt/homebrew/bin/fava ${beancount_ledger_folder}/2025.bean";
          serviceConfig = {
            UserName = "noghartt";
            KeepAlive = true;
            RunAtLoad = true;
            StandardOutPath = "/tmp/fava_beancount.out.log";
            StandardErrorPath = "/tmp/fava_beancount.err.log";
          };
        };

        beancount-commit = {
          serviceConfig = {
            UserName = "noghartt";
            KeepAlive = true;
            RunAtLoad = true;
            StandardOutPath = "/tmp/beancount-commit.out.log";
            StandardErrorPath = "/tmp/beancount-commit.err.log";
            StartInterval = 3600;
          };

          command = ''
            cd ${beancount_ledger_folder} && \
            if [[ -n $(git status -s) ]]; then \
                git add . && \
                git commit -m "*" && \
                git push; \
            fi
          '';
        };
      };
    };
  };
}
