(set-face-attribute 'default t
		    :family "Iosevka"
		    :height 180)

(when (string= system-type "darwin")
  (setq dired-use-ls-dired nil))

(defvar bootstrap-version)
(let ((bootstrap-file
       (expand-file-name
        "straight/repos/straight.el/bootstrap.el"
        (or (bound-and-true-p straight-base-dir)
            user-emacs-directory)))
      (bootstrap-version 7))
  (unless (file-exists-p bootstrap-file)
    (with-current-buffer
        (url-retrieve-synchronously
         "https://raw.githubusercontent.com/radian-software/straight.el/develop/install.el"
         'silent 'inhibit-cookies)
      (goto-char (point-max))
      (eval-print-last-sexp)))
  (load bootstrap-file nil 'nomessage))

(straight-use-package 'use-package)
(setq straight-use-package-by-default t)

(menu-bar-mode -1)
(tool-bar-mode -1)
(tooltip-mode -1)
(scroll-bar-mode -1)
(blink-cursor-mode 0)
(global-hl-line-mode 1)
(tab-line-mode 1)
(global-display-line-numbers-mode)

(which-key-mode 1)
(which-key-setup-side-window-bottom)

(use-package copilot
  :ensure t
  :straight (:host github :repo "copilot-emacs/copilot.el" :files ("*.el"))
  :config
  (custom-set-variables
   '(copilot-install-dir "/etc/profiles/per-user/noghartt")
   '(copilot-indent-offset-warning-disable t))
  (define-key copilot-completion-map (kbd "<tab>") 'copilot-accept-completion)
  (define-key copilot-completion-map (kbd "<backtab>") 'copilot-accept-completion-by-word)
  :init
  (add-hook 'prog-mode-hook 'copilot-mode))

(use-package corfu
  :ensure t
  :init
  (global-corfu-mode)
  (corfu-history-mode)
  (corfu-popupinfo-mode)
  :config
  (setq corfu-auto t
	corfu-auto-delay 0.1
	corfu-auto-prefix 2)

  (keymap-global-set "C-SPC" #'completion-at-point))

(use-package lsp-mode
  :init
  (setq lsp-keymap-prefix "C-c l")
  :config
  (setq lsp-log-io nil)
  :hook ((lsp-mode . lsp-enable-which-key-integration)))

(use-package lsp-ui
  :hook (lsp-mode . lsp-ui-mode))

(use-package smartparens
	     :ensure smartparens
	     :config
	     (require 'smartparens-config)
	     :init
             (add-hook 'emacs-lisp-mode-hook #'smartparens-mode))

(use-package general)

(use-package evil
  :ensure t
  :config
  (define-key evil-window-map (kbd "N") 'evil-window-vnew)
  :init
  (setq evil-want-keybinding nil)
  (evil-mode))

(setq-default display-fill-column-indicator 79)
(global-display-fill-column-indicator-mode 1)

(use-package vertico
  :init
  (vertico-mode))

(use-package consult
  :hook (completion-list-mode . consult-preview-at-point-mode)
  :init
  (advice-add #'register-preview :override #'consult-register-window)
  (setq register-preview-delay 0.5)
  (setq xref-show-xrefs-function #'consult-xref
	xref-show-definitions-function #'consult-xref)
  :config
  (setq consult-narrow-key "<"))

(use-package consult-lsp
  :defer t)

(use-package marginalia
  :init
  (marginalia-mode))

(defconst leader-key "SPC"
  "The leader key for evil-mode")
(defconst localleader-key "SPC m"
  "The localleader prefix key, for major-mode specific commands")

(general-create-definer leader-def
  :prefix leader-key)
(general-create-definer localleader-def
  :prefix localleader-key)

(defvar my/keybinds-buffer-map (make-sparse-keymap))
(general-define-key
 :keymaps 'my/keybinds-buffer-map
 "i" #'ibuffer
 "kb" #'kill-buffer
 "kc" #'kill-current-buffer)

(defvar my/keybinds-files-map (make-sparse-keymap))
(general-define-key
 :keymaps 'my/keybinds-files-map
 "s" #'save-buffer
 "f" #'find-file)

(defvar my/keybinds-local-lisp-map (make-sparse-keymap))
(general-define-key
  :keymaps 'my/keybinds-local-lisp-map
  :wk "buffer"
  "b" #'eval-buffer
  "r" #'eval-region
  "e" #'eval-expression
  "f" #'eval-defun)

(localleader-def
  :states 'normal
  :keymaps '(emacs-lisp-mode-map lisp-interaction-mode-map)
  "e" '(:keymap my/keybinds-local-lisp-map :wk "eval"))

(leader-def
  :states 'normal
  "h" '(:keymap help-map :wk "help")
  "b" '(:keymap my/keybinds-buffer-map :wk "buffer")
  "f" '(:keymap my/keybinds-files-map :wk "files"))
