return {
  {
    "folke/which-key.nvim",
    event = "VimEnter",

    opts = {
      delay = 0,

      spec = {
        { "<leader>a", "<cmd>Alpha<CR>", desc = "Go to [A]lpha" },
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
      },
    },
  },
}
