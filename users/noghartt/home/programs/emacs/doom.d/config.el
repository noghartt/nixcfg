;;; $DOOMDIR/config.el -*- lexical-binding: t; -*-

(setq user-full-name "Guilherme Ananias"
      user-full-name "hi@noghartt.dev")

; TODO: I don't like this theme, should be changed in the future.
(setq doom-theme 'doom-gruvbox
      doom-font (font-spec :family "Hack Nerd Font Mono" :size 14)
      doom-unicode-font (font-spec :family "LiterationSerif Nerd Font" :size 14))

(setq confirm-kill-emacs nil)

(setq company-idle-delay nil)

(setq org-directory "~/org"
      org-roam-directory (concat org-directory "/roam")
      org-roam-dailies-directory (concat org-roam-directory "/dailies")
      org-agenda-files '(org-roam-dailies-directory))

(after! org
  :config
  (setq org-todo-keywords
      '((sequence  "TODO(t)" "DONE(d)")
        (sequence "[ ](C)" "[-](D)" "[?](W)" "[X](D)")
        (sequence "|" "CANCELED(c)"))
      org-todo-keyword-faces
       '(("TODO" . org-todo)
         ("DONE" . org-done)
         ("CANCELED" . +org-todo-cancel)
         ("[-]" . +org-todo-active)
         ("[?]" . +org-todo-onhold))))

(after! org-roam
  (setq org-roam-capture-templates
        '(("n" "note" plain "%?"
           :if-new (file+head "${slug}.org"
                              "#+title: ${title}\n")
           :unnarrowed t))))

(use-package! websocket
  :after org-roam)

(use-package! org-roam-ui
  :after org-roam
  :config
  (setq org-roam-ui-sync-theme t
        org-roam-ui-follow t
        org-roam-ui-update-on-save t
        org-roam-ui-open-on-start nil))

(setq deft-extensions '("txt" "text" "org" "md")
      deft-directory org-roam-directory
      deft-recursive t)

(when (and (featurep! :completion company) (featurep! :lang nix))
  (after! company
    (setq-hook! 'nix-mode-hook company-idle-delay nil)))

(use-package! nix-mode
  :interpreter ("\\(?:cached-\\)?nix-shell" . +nix-shell-init-mode)
  :mode "\\.nix\\'"
  :init
  (add-to-list 'auto-mode-alist
               (cons "/flake\\.lock\\'"
                     (if (featurep! :lang json)
                         'json-mode
                       'js-mode)))
  :config
  (after! lsp-mode
    (add-to-list 'lsp-language-id-configuration '(nix-mode . "nix"))

    (lsp-register-client
     (make-lsp-client :new-connection (lsp-stdio-connection '("rnix-lsp"))
                      :major-modes '(nix-mode)
                      :server-id 'nix))

    )
  (add-hook 'nix-mode-hook #'lsp!)

  (set-popup-rule! "^\\*nixos-options-doc\\*$" :ttl 0 :quit t)

  (setq-hook! 'nix-mode-hook company-idle-delay nil)

  (map! :localleader
        :map nix-mode-map
        "f" #'nix-update-fetch
        "p" #'nix-format-buffer
        "r" #'nix-repl-show
        "s" #'nix-shell
        "b" #'nix-build
        "u" #'nix-unpack
        "o" #'+nix/lookup-option))

(use-package! nix-drv-mode
  :mode "\\.drv\\'")
