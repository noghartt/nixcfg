return {
  {
    "nvim-telescope/telescope.nvim",
    branch = "0.1.x",
    dependencies = {
      "nvim-lua/plenary.nvim",
      {
        "nvim-telescope/telescope-fzf-native.nvim",
        build = "make",
        cond = function() return vim.fn.executable "make" == 1 end,
      },
    },

    config = function()
      require("telescope").setup {
        extensions = {
          ["ui-select"] = {
            require("telescope.themes").get_dropdown(),
          },
        },
      }

      pcall(require("telescope").load_extension, "fzf")
      pcall(require("telescope").load_extension, "workspaces")

      local builtin = require "telescope.builtin"
      vim.keymap.set(
        "n",
        "<leader>sh",
        builtin.help_tags,
        { desc = "[S]earch [H]elp" }
      )
      vim.keymap.set(
        "n",
        "<leader>sf",
        function()
          builtin.find_files {
            hidden = true,
          }
        end,
        { desc = "[S]earch [F]iles" }
      )
      vim.keymap.set(
        "n",
        "<leader><leader>",
        builtin.buffers,
        { desc = "Find existing buffers" }
      )

      vim.keymap.set(
        "n",
        "<leader>fo",
        builtin.oldfiles,
        { desc = "Open Oldfiles" }
      )

      vim.keymap.set(
        "n",
        "<leader>/",
        function()
          builtin.current_buffer_fuzzy_find(
            require("telescope.themes").get_dropdown {
              winblend = 10,
              previewer = false,
            }
          )
        end,
        { desc = "Fuzzily search in current buffer" }
      )

      vim.keymap.set(
        "n",
        "<leader>s/",
        function()
          builtin.live_grep {
            grep_open_files = true,
            prompt_title = "Live Grep in Open Files",
          }
        end,
        { desc = "[S]earch [/] in Open Files" }
      )

      vim.keymap.set(
        "n",
        "<leader>f/",
        function() builtin.live_grep { hidden = true } end,
        { desc = "[S]earch [/] in Files" }
      )

      vim.keymap.set("n", "<leader>sc", function()
        local home = os.getenv "HOME"
        local path = home .. "/www/nixcfg"
        builtin.find_files { cwd = path, hidden = true }
      end, { desc = "[S]earch [C]onfig" })
    end,
  },
}
