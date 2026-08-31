local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not (vim.uv or vim.loop).fs_stat(lazypath) then
  local lazyrepo = "https://github.com/folke/lazy.nvim.git"
  local out = vim.fn.system({ "git", "clone", "--filter=blob:none", "--branch=stable", lazyrepo, lazypath })
  if vim.v.shell_error ~= 0 then
    vim.api.nvim_echo({
      { "Failed to clone lazy.nvim:\n", "ErrorMsg" },
      { out,                            "WarningMsg" },
      { "\nPress any key to exit..." },
    }, true, {})
    vim.fn.getchar()
    os.exit(1)
  end
end
vim.opt.rtp:prepend(lazypath)

vim.g.mapleader = " "
vim.g.maplocalleader = "\\"

vim.o.swapfile = false
vim.o.tabstop = 2
vim.o.shiftwidth = 2
vim.o.termguicolors = true
vim.o.smartindent = true
vim.o.number = true
vim.o.relativenumber = true
vim.o.hlsearch = false
vim.o.expandtab = true
vim.o.backup = false
vim.o.wrap = false
vim.o.undofile = true
vim.o.signcolumn = 'yes'
vim.o.updatetime = 250
vim.o.timeoutlen = 300
vim.o.scrolloff = 0
vim.o.splitright = true
vim.o.splitbelow = true
vim.o.inccommand = 'split'
vim.o.ignorecase = true
vim.o.smartcase = true
vim.o.cursorline = true
vim.o.list = true
vim.opt.listchars = { tab = '» ', trail = '·', nbsp = '␣' }
vim.opt.ruler = true
vim.opt.colorcolumn = "80"
vim.o.mousescroll = "ver:1,hor:1"
vim.o.foldmethod = 'expr'
vim.o.foldexpr = 'v:lua.vim.treesitter.foldexpr()'
vim.o.foldlevel = 99
vim.o.foldlevelstart = 99

vim.schedule(function()
  vim.o.clipboard = 'unnamedplus'
end)

vim.api.nvim_create_autocmd('TextYankPost', {
  callback = function() vim.hl.on_yank() end,
})

require("lazy").setup({
  checker = {
    enabled = true,
    notify = false,
  },
  spec = {
    {
      "catppuccin/nvim",
      name = "catppuccin",
      priority = 1000,
      config = function()
        vim.cmd [[colorscheme catppuccin-mocha]]
      end
    },

    {
      "f-person/git-blame.nvim",
      event = "VeryLazy",
      opts = {
        enable = true,
      },
    },

    { 'nvim-treesitter/nvim-treesitter', lazy = false, build = ':TSUpdate' },

    {
      "NeogitOrg/neogit",
      lazy = true,
      dependencies = {
        "nvim-lua/plenary.nvim",  -- required

        "sindrets/diffview.nvim", -- optional

        -- For a custom log pager
        "m00qek/baleia.nvim", -- optional

        -- Only one of these is needed.
        "nvim-telescope/telescope.nvim", -- optional
      },
      cmd = "Neogit",
      keys = {
        { "<leader>gg", "<cmd>Neogit<cr>", desc = "Show Neogit UI" }
      }
    },

    {
      'dmtrKovalenko/fff.nvim',
      build = function()
        -- this will download prebuild binary or try to use existing rustup toolchain to build from source
        -- (if you are using lazy you can use gb for rebuilding a plugin if needed)
        require("fff.download").download_or_build_binary()
      end,
      -- if you are using nixos
      -- build = "nix run .#release",
      opts = {                -- (optional)
        debug = {
          enabled = true,     -- we expect your collaboration at least during the beta
          show_scores = true, -- to help us optimize the scoring system, feel free to share your scores!
        },
      },
      -- No need to lazy-load with lazy.nvim.
      -- This plugin initializes itself lazily.
      lazy = false,
      keys = {
        {
          "ff", -- try it if you didn't it is a banger keybinding for a picker
          function() require('fff').find_files() end,
          desc = 'FFFind files',
        },
        {
          "fg",
          function() require('fff').live_grep() end,
          desc = 'LiFFFe grep',
        },
        {
          "fz",
          function()
            require('fff').live_grep({
              grep = {
                modes = { 'fuzzy', 'plain' }
              }
            })
          end,
          desc = 'Live fffuzy grep',
        },
        {
          "fc",
          function() require('fff').live_grep({ query = vim.fn.expand("<cword>") }) end,
          desc = 'Search current word',
        },
      }
    },

    -- lua type annotations for neovim config
    {
      'folke/lazydev.nvim',
      ft = 'lua',
      opts = {
        library = {
          { path = '${3rd}/luv/library', words = { 'vim%.uv' } },
        },
      },
    },

    -- lsp stuffs
    {
      'mason-org/mason-lspconfig.nvim',
      opts = {},
      dependencies = {
        { 'mason-org/mason.nvim', opts = {} },
        'neovim/nvim-lspconfig',
        { 'j-hui/fidget.nvim',    opts = {} },
      },
      config = function()
        vim.api.nvim_create_autocmd('LspAttach', {
          callback = function(event)
            local client = vim.lsp.get_client_by_id(event.data.client_id)
            if client and client:supports_method('textDocument/inlayHint', event.buf) then
              vim.keymap.set(
                'n',
                '<leader>lh',
                function()
                  vim.lsp.inlay_hint.enable(not vim.lsp.inlay_hint.is_enabled { bufnr = event.buf })
                end,
                { desc = "Toggle Inlay Hint" }
              )
            end
          end
        })
      end,
    },

    {
      'stevearc/oil.nvim',
      ---@module 'oil'
      ---@type oil.SetupOpts
      opts = {},
      -- Optional dependencies
      dependencies = { { "nvim-mini/mini.icons", opts = {} } },
      -- Lazy loading is not recommended because it is very tricky to make it work correctly in all situations.
      lazy = false,
    },

    -- autocomplete
    {
      'saghen/blink.cmp',
      version = '1.*',
      opts = {
        keymap = {
          preset = 'default',
          ['<CR>'] = { 'accept', 'fallback' },
        },
        signature = { enabled = true },
        fuzzy = {
          implementation = "lua",
        },
        completion = {
          accept = {
            resolve_timeout_ms = 0
          },
          list = {
            selection = {
              auto_insert = true,
            },
          },
          documentation = { auto_show = true, auto_show_delay_ms = 500 },
          menu = {
            auto_show = true,
            draw = {
              treesitter = { "lsp" },
              columns = { { "kind_icon", "label", "label_description", gap = 1 }, { "kind" } },
            },
          },
        },
        sources = {
          default = { 'lazydev', 'lsp', 'path', 'snippets', 'buffer' },
          providers = {
            lazydev = {
              name = 'LazyDev',
              module = 'lazydev.integrations.blink',
              score_offset = 100,
            },
          },
        },
      },
    },

    -- fzf
    {
      'nvim-telescope/telescope.nvim',
      version = '*',
      dependencies = {
        'nvim-lua/plenary.nvim',
        -- optional but recommended
        { 'nvim-telescope/telescope-fzf-native.nvim', build = 'make' },
      },
      config = function()
        require('telescope').setup({
          extensions = {
            ['ui-select'] = { require('telescope.themes').get_dropdown() },
          }
        })

        pcall(require('telescope').load_extension, 'fzf')
        pcall(require('telescope').load_extension, 'ui-select')

        -- Telescope related
        local builtin = require('telescope.builtin')
        vim.keymap.set('n', '<leader>ff', builtin.find_files, { desc = "Find file" })
        vim.keymap.set('n', '<leader>?', builtin.live_grep, { desc = "File grep" })
        vim.keymap.set('n', '<leader><leader>', builtin.buffers, { desc = "Buffers" })
        vim.keymap.set('n', '<leader>hh', builtin.help_tags, { desc = "Help" })
        vim.keymap.set('n', '<leader>/', builtin.current_buffer_fuzzy_find, { desc = "Find in current file" })

        vim.api.nvim_create_autocmd('LspAttach', {
          group = vim.api.nvim_create_augroup('telescope-lsp-attach', { clear = true }),
          callback = function(event)
            local buf = event.buf

            vim.keymap.set('n', 'glr', builtin.lsp_references, { buffer = buf, desc = '[G]oto [R]eferences' })
            vim.keymap.set('n', 'gld', builtin.lsp_definitions, { buffer = buf, desc = '[G]oto [D]efinition' })
            vim.keymap.set('n', 'gli', builtin.lsp_implementations, { buffer = buf, desc = '[G]oto [I]mplementation' })
            vim.keymap.set('n', 'gO', builtin.lsp_document_symbols, { buffer = buf, desc = 'Open Document Symbols' })
            vim.keymap.set('n', 'gW', builtin.lsp_dynamic_workspace_symbols,
              { buffer = buf, desc = 'Open Workspace Symbols' })
            vim.keymap.set('n', 'glt', builtin.lsp_type_definitions, { buffer = buf, desc = '[G]oto [T]ype Definition' })
          end
        })
      end
    },

    {
      "folke/which-key.nvim",
      event = "VeryLazy",
      opts = {},
    },

    {
      "windwp/nvim-autopairs",
      event = "InsertEnter",
      config = true
    },

    {
      "lukas-reineke/indent-blankline.nvim",
      main = "ibl",
      ---@module "ibl"
      ---@type ibl.config
      opts = {},
    },

    {
      "greggh/claude-code.nvim",
      dependencies = {
        "nvim-lua/plenary.nvim", -- Required for git operations
      },
      config = function()
        require("claude-code").setup()
      end
    },

    {
      'mrcjkb/rustaceanvim',
      version = '^8', -- Recommended
      lazy = false,   -- This plugin is already lazy
    },

    -- git
    {
      'lewis6991/gitsigns.nvim',
      opts = {},
    },

    -- formatting
    {
      'stevearc/conform.nvim',
      event = { 'BufWritePre' },
      cmd = { 'ConformInfo' },
      keys = {
        {
          '<leader>f',
          function()
            require('conform').format({ async = true, lsp_format = 'fallback' })
          end,
          mode = '',
          desc = 'Format buffer',
        },
      },
      opts = {
        formatters_by_ft = {
          lua = { 'stylua' },
          python = { 'ruff_format' },
          rust = { 'rustfmt', lsp_format = 'fallback' },
          javascript = { 'prettierd', 'prettier', stop_after_first = true },
          typescript = { 'prettierd', 'prettier', stop_after_first = true },
        },
        format_on_save = {
          timeout_ms = 500,
          lsp_format = 'fallback',
        },
      },
    },

    -- text editing
    {
      'nvim-mini/mini.nvim',
      version = "*",
      config = function()
        require('mini.ai').setup()
        require('mini.surround').setup()
        require('mini.statusline').setup()
      end,
    },

    -- highlight TODO/FIXME/HACK in comments
    {
      'folke/todo-comments.nvim',
      dependencies = { 'nvim-lua/plenary.nvim' },
      opts = {},
    },

    -- auto-detect indentation
    {
      'NMAC427/guess-indent.nvim',
      opts = {},
    },
  }
})

vim.api.nvim_create_autocmd("VimEnter", {
  once = true,
  callback = function()
    vim.schedule(function()
      local valid_langs = { "lua", "javascript", "typescript", "rust", "vim", "vimdoc", "terraform" }
      require('nvim-treesitter').setup {
        install_dir = vim.fn.stdpath('data') .. '/site',
        ensure_installed = valid_langs,
        auto_install = true,
        sync_install = false,
      }
    end)
  end,
})

require("mason-lspconfig").setup({
  ensure_installed = { "lua_ls", "rust_analyzer", "basedpyright", "eslint", "ts_ls", "gopls", "terraformls" },
})

vim.lsp.config.lua_ls = {
  settings = {
    Lua = {
      telemetry = { enable = false },
    },
  },
}

vim.diagnostic.config({ virtual_text = true })

-- keymaps
vim.keymap.set('n', '<leader>fs', vim.cmd.write, { desc = "Save file" })

local wk = require('which-key')

wk.add({
  { '<leader>h', group = 'help' }
})

vim.keymap.set('n', '<leader>ol', ':Lazy<CR>', { desc = "Open Lazy" })
vim.keymap.set('n', '<leader>oo', ':Oil<CR>', { desc = "Open Oil" })
vim.keymap.set('n', '<leader>q', vim.diagnostic.setloclist, { desc = "Diagnostics quickfix" })
vim.keymap.set('t', '<Esc><Esc>', '<C-\\><C-n>', { desc = "Exit terminal mode" })

-- split navigation
vim.keymap.set('n', '<C-h>', '<C-w><C-h>', { desc = "Focus left split" })
vim.keymap.set('n', '<C-j>', '<C-w><C-j>', { desc = "Focus lower split" })
vim.keymap.set('n', '<C-k>', '<C-w><C-k>', { desc = "Focus upper split" })
vim.keymap.set('n', '<C-l>', '<C-w><C-l>', { desc = "Focus right split" })

-- clear search highlight on Esc
vim.keymap.set('n', '<Esc>', '<cmd>nohlsearch<CR>')
