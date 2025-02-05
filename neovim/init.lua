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

local lang_config = {
  {
    pattern = "*.js",
    callback = function()
      vim.o.tabstop = 2
      vim.o.shiftwidth = 2
    end,
  },
}

for _, config in ipairs(lang_config) do
  vim.api.nvim_create_autocmd({ "BufEnter", "BufWinEnter" }, {
    pattern = config.pattern,
    callback = config.callback,
  })
end
