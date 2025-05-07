vim.g.mapleader = " "
vim.g.maplocalleader = " "

local lazypath = vim.fn.stdpath "data" .. "/lazy/lazy.nvim"
if not (vim.uv or vim.loop).fs_stat(lazypath) then
  local lazyrepo = "https://github.com/folke/lazy.nvim.git"
  local out = vim.fn.system {
    "git",
    "clone",
    "--filter=blob:none",
    "--branch=stable",
    lazyrepo,
    lazypath,
  }
  if vim.v.shell_error ~= 0 then
    vim.api.nvim_echo({
      { "Failed to clone lazy.nvim:\n", "ErrorMsg" },
      { out, "WarningMsg" },
      { "\nPress any key to exit..." },
    }, true, {})
    vim.fn.getchar()
    os.exit(1)
  end
end
vim.opt.rtp:prepend(lazypath)

vim.o.swapfile = false
vim.o.hlsearch = false
vim.wo.number = true
vim.o.mouse = "a"
vim.o.clipboard = "unnamedplus"
vim.o.breakindent = true
vim.o.undofile = true
vim.o.ignorecase = true
vim.o.smartcase = true
vim.wo.signcolumn = "yes"
vim.o.updatetime = 250
vim.o.timeoutlen = 300
vim.o.completeopt = "menuone,noselect"
vim.o.termguicolors = true
vim.wo.wrap = false
vim.o.textwidth = 0

vim.bo.softtabstop = 2
vim.opt.tabstop = 2
vim.opt.expandtab = true

vim.g.netrw_keepdir = false
vim.g.netrw_winsize = 30
vim.g.netrw_banner = false
vim.g.netrw_localcopydircmd = "cp -r"

require("lazy").setup {
  spec = {
    { import = "plugins" },
  },
  checker = { enabled = true },
}

vim.schedule(function() vim.opt.clipboard = "unnamedplus" end)

vim.filetype.add {
  extension = {
    nix = "nix",
  },
}

local lang_config = {
  {
    pattern = "javascript",
    callback = function()
      vim.opt_local.tabstop = 2
      vim.opt_local.shiftwidth = 2
    end,
  },
  {
    pattern = "typescript",
    callback = function()
      vim.opt_local.tabstop = 2
      vim.opt_local.shiftwidth = 2
    end,
  },
  {
    pattern = "typescriptreact",
    callback = function()
      vim.opt_local.tabstop = 2
      vim.opt_local.shiftwidth = 2
    end,
  },
  {
    pattern = "javascriptreact",
    callback = function()
      vim.opt_local.tabstop = 2
      vim.opt_local.shiftwidth = 2
    end,
  },
  {
    pattern = "lua",
    callback = function()
      vim.opt_local.tabstop = 2
      vim.opt_local.shiftwidth = 2
    end,
  },
  {
    pattern = "nix",
    callback = function()
      vim.opt_local.tabstop = 2
      vim.opt_local.shiftwidth = 2
    end,
  },
  {
    pattern = "rust",
    callback = function()
      vim.opt_local.tabstop = 4
      vim.opt_local.shiftwidth = 4
    end,
  },
}

for _, config in ipairs(lang_config) do
  vim.api.nvim_create_autocmd({ "FileType" }, {
    pattern = config.pattern,
    callback = config.callback,
  })
end

require "keymaps"

vim.o.background = "light"
vim.cmd [[ colorscheme gruvbox ]]
