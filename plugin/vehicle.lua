if vim.g.loaded_vehicle_garden == 1 then
  return
end
vim.g.loaded_vehicle_garden = 1

vim.api.nvim_create_user_command("VehicleGardenOpen", function(opts)
  require("vehicle.garden").open(opts.args)
end, { nargs = 1, complete = "file" })

vim.api.nvim_create_user_command("VehicleGardenSave", function()
  require("vehicle.garden").save()
end, {})

vim.api.nvim_create_user_command("VehicleGardenStatus", function()
  require("vehicle.garden").status()
end, {})

vim.api.nvim_create_user_command("VehicleGardenSync", function()
  require("vehicle.garden").sync()
end, {})

vim.api.nvim_create_user_command("VehicleGardenBridgeStop", function()
  require("vehicle.garden").stop_bridge()
end, {})

vim.api.nvim_create_user_command("VehicleGardenTree", function()
  require("vehicle.garden").tree()
end, {})

vim.api.nvim_create_user_command("VehicleGardenComment", function(opts)
  require("vehicle.garden").comment(opts.args, {
    explicit = opts.range > 0,
    line1 = opts.line1,
    line2 = opts.line2,
  })
end, { nargs = "*", range = true, desc = "Add a Garden comment to the selection or current block" })

vim.api.nvim_create_user_command("VehicleGardenComments", function()
  require("vehicle.garden").comments()
end, { desc = "Open Garden comments in the location list" })

vim.api.nvim_create_user_command("VehicleGardenCommentEdit", function(opts)
  require("vehicle.garden").edit_comment(opts.args)
end, { nargs = "*", desc = "Edit the Garden comment at the cursor" })

vim.api.nvim_create_user_command("VehicleGardenCommentResolve", function(opts)
  require("vehicle.garden").resolve_comment(nil, not opts.bang)
end, { bang = true, desc = "Resolve the Garden comment at the cursor; use ! to reopen" })

vim.api.nvim_create_user_command("VehicleGardenCommentDelete", function()
  require("vehicle.garden").delete_comment()
end, { desc = "Delete the Garden comment at the cursor" })

vim.api.nvim_create_user_command("VehicleGardenFootnote", function(opts)
  require("vehicle.garden").footnote(opts.args)
end, { nargs = "*", desc = "Insert a Garden footnote at the cursor" })

vim.api.nvim_create_user_command("VehicleGardenFootnotes", function()
  require("vehicle.garden").footnotes()
end, { desc = "Open Garden footnotes in the location list" })

vim.api.nvim_create_user_command("VehicleGardenFootnoteEdit", function(opts)
  require("vehicle.garden").edit_footnote(opts.args)
end, { nargs = "*", desc = "Edit the nearest Garden footnote" })

vim.api.nvim_create_user_command("VehicleGardenFootnoteDelete", function()
  require("vehicle.garden").delete_footnote()
end, { desc = "Delete the nearest Garden footnote" })
