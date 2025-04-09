return {
  { -- Highlight, edit, and navigate code
    "nvim-treesitter/nvim-treesitter",
    build = ":TSUpdate",
    main = "nvim-treesitter.configs", -- Sets main module to use for opts
    -- [[ Configure Treesitter ]] See `:help nvim-treesitter`,
    dependencies = {
      "nvim-treesitter/nvim-treesitter-context",
    },
    config = function()
      require("nvim-treesitter.configs").setup {
        ignore_install = {},
        sync_install = false,
        modules = {},
        ensure_installed = {
          "bash",
          "c",
          "diff",
          "html",
          "lua",
          "luadoc",
          "markdown",
          "markdown_inline",
          "query",
          "vim",
          "vimdoc",
          "nix",
          "javascript",
          "typescript",
          "zig",
          "rust",
        },
        -- Autoinstall languages that are not installed
        auto_install = true,
        highlight = {
          enable = true,
        },
      }

      -- [[ Configure Treesitter Context ]]
      require("treesitter-context").setup {
        enable = true,
        multiwindow = true,
        min_window_height = 0,
        max_lines = 0,
        line_numbers = true,
        mode = "cursor",
      }
    end,
    -- There are additional nvim-treesitter modules that you can use to interact
    -- with nvim-treesitter. You should go explore a few and see what interests you:
    --
    --    - Incremental selection: Included, see `:help nvim-treesitter-incremental-selection-mod`
    --    - Show your current context: https://github.com/nvim-treesitter/nvim-treesitter-context
    --    - Treesitter + textobjects: https://github.com/nvim-treesitter/nvim-treesitter-textobjects
  },
}
