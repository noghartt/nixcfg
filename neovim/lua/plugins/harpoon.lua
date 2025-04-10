return {
  {
    "ThePrimeagen/harpoon",
    branch = "harpoon2",
    dependencies = { "nvim-lua/plenary.nvim" },
    config = function()
      local harpoon = require "harpoon"
      harpoon:setup {}

      local conf = require("telescope.config").values

      local function toggle_telescope(harpoon_files)
        local file_paths = {}
        for _, item in ipairs(harpoon_files.items) do
          table.insert(file_paths, item.value)
        end

        require("telescope.pickers")
          .new({}, {
            prompt_title = "Harpoon",
            finder = require("telescope.finders").new_table {
              results = file_paths,
            },
            previewer = conf.file_previewer {},
            sorter = conf.generic_sorter {},
          })
          :find()
      end

      vim.keymap.set(
        "n",
        "<leader>ba",
        function() harpoon:list():add() end,
        { desc = "[B]uffer [A]dd file" }
      )

      vim.keymap.set(
        "n",
        "<leader>bd",
        function() harpoon:list():remove() end,
        { desc = "[B]uffer [D]elete file" }
      )

      vim.keymap.set(
        "n",
        "<leader>be",
        function() toggle_telescope(harpoon:list()) end,
        { desc = "Open [b]uffers" }
      )
    end,
  },
}
