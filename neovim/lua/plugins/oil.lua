return {
  {
    "stevearc/oil.nvim",
    opts = {
      default_file_explorer = true,
      columns = {
        "icons",
        "permissions",
        "size",
        "mtime",
      },
      delete_to_trash = true,
      cleanup_delay_ms = 1000,
      use_default_keymaps = true,
      view_options = {
        show_hidden = true,
      },
    },
    dependencies = {
      "nvim-tree/nvim-web-devicons",
    },
  },
}
