return {
  {
    'folke/which-key.nvim',
    event = "VimEnter",

    opts = {
      delay = 0,

      spec = {
        { "<leader>o", group = "[O]pen" },
        { "<leader>oe", "<cmd>Oil<CR>", desc = "Explore" },
      },
    },
  },
}
