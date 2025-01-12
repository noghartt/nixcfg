return {
  {
    'folke/which-key.nvim',
    event = "VeryLazy",
    opts = {},
    keys = {
      { "<leader>", group = "global" },
      { "<leader><space>", "<cmd>Telescope buffers<CR>", desc = "List buffers" },
      {
        "<leader>/",
        function()
          require('telescope.builtin').current_buffer_fuzzy_find(require('telescope.themes').get_dropdown({
            winblend = 10,
            previewer = false,
          }))
        end,
        desc = "Fuzzy search in current buffer",
      },
      { "<leader>o", group = "open", name = "open" },
      { "<leader>oe", "<cmd>Oil<CR>", desc = "Explore" },
    },
  },
}
