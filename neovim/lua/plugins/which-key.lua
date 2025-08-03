return {
  {
    "folke/which-key.nvim",
    event = "VimEnter",

    opts = {
      delay = 0,

      spec = {
        { "<leader>s", group = "[S]earch" },

        { "<leader>f", group = "[F]ile" },
        { "<leader>fs", "<cmd>w<CR>", desc = "[F]ile [S]ave" },

        { "<leader>o", group = "[O]pen" },
        { "<leader>oe", "<cmd>Oil<CR>", desc = "[O]pen [E]xplorer" },
        {
          "<leader>ow",
          "<cmd>Telescope workspaces<CR>",
          desc = "[O]pen [W]orkspaces",
        },
        {
          "<leader>ol",
          "<cmd>Lazy<CR>",
          desc = "[O]pen [L]azy",
        },
        {
          "<leader>ou",
          "<cmd>UndotreeToggle<CR>",
          desc = "[O]pen [U]ndotree",
        },
        {
          "<leader>ot",
          "<cmd>tabnew<CR>",
          desc = "[O]pen [T]ab",
        },
      },
    },
  },
}
