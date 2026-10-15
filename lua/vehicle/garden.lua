local M = {}

local state = {
  adapter = {
    kind = "json-file",
    root = vim.env.VEHICLE_GARDEN_ROOT or "fixtures/garden-docs",
    bridge = vim.env.VEHICLE_BRIDGE_BIN,
  },
  ns = vim.api.nvim_create_namespace("vehicle-garden-blocks"),
  block_ns = vim.api.nvim_create_namespace("vehicle-garden-block-rendering"),
  mark_ns = vim.api.nvim_create_namespace("vehicle-garden-marks"),
  presence_ns = vim.api.nvim_create_namespace("vehicle-garden-presence"),
  tree_ns = vim.api.nvim_create_namespace("vehicle-garden-tree"),
  trees = {},
  live = {
    job = nil,
    next_id = 0,
    pending = {},
    events = {},
    stdout = "",
    stopping = false,
    stream_generation = {},
    streaming = {},
    applying_remote = {},
    presence_generation = {},
    awareness = nil,
  },
}

local refresh_from_projection
local adopt_projection_if_buffer_matches
local render_blocks
local render_presence
local refresh_tree_for_document
local sync_tree_cursor

local MARK_HIGHLIGHTS = {
  bold = "VehicleGardenBold",
  italic = "VehicleGardenItalic",
  strike = "VehicleGardenStrike",
  code = "VehicleGardenCode",
  link = "VehicleGardenLink",
  highlight = "VehicleGardenHighlight",
  commentMark = "VehicleGardenComment",
  wireMark = "VehicleGardenWire",
}

local function join_path(root, leaf)
  if root:sub(-1) == "/" then
    return root .. leaf
  end
  return root .. "/" .. leaf
end

local function doc_path(document_id)
  return join_path(state.adapter.root, document_id .. ".json")
end

local function ydoc_path(document_id)
  if state.adapter.path then
    return state.adapter.path
  end
  return join_path(state.adapter.root, document_id .. ".update-v1.bin")
end

local function room_url(document_id)
  if state.adapter.url then
    return state.adapter.url:gsub("{document_id}", document_id)
  end
  error("adapter.kind='bridge-ydoc-room' requires adapter.url")
end

local function add_room_auth_args(args)
  table.insert(args, "--token-env")
  table.insert(args, state.adapter.token_env or "VEHICLE_GARDEN_TOKEN")
  if state.adapter.on_behalf_of then
    table.insert(args, "--on-behalf-of")
    table.insert(args, state.adapter.on_behalf_of)
  elseif state.adapter.on_behalf_of_env then
    table.insert(args, "--on-behalf-of-env")
    table.insert(args, state.adapter.on_behalf_of_env)
  end
  return args
end

local function read_file(path)
  local fd = assert(io.open(path, "r"))
  local body = fd:read("*a")
  fd:close()
  return body
end

local function write_file(path, body)
  local fd = assert(io.open(path, "w"))
  fd:write(body)
  fd:close()
end

local function current_doc()
  local doc = vim.b.vehicle_garden_document
  if not doc then
    error("current buffer is not a vehicle Garden document")
  end
  return doc
end

local function bridge_bin()
  return state.adapter.bridge or vim.env.VEHICLE_BRIDGE_BIN or "vehicle"
end

local function run_bridge(args, stdin)
  local cmd = { bridge_bin() }
  for _, arg in ipairs(args) do
    table.insert(cmd, arg)
  end
  local output = vim.fn.system(cmd, stdin or "")
  if vim.v.shell_error ~= 0 then
    error("vehicle bridge failed: " .. table.concat(cmd, " ") .. "\n" .. tostring(output))
  end
  local ok, decoded = pcall(vim.json.decode, output)
  if not ok then
    error("vehicle bridge returned invalid JSON: " .. tostring(output))
  end
  return decoded
end

local function stop_live_bridge()
  if state.live.job then
    local job = state.live.job
    state.live.stopping = true
    pcall(vim.fn.chansend, job, vim.json.encode({ id = "shutdown", method = "shutdown", params = {} }) .. "\n")
    local waited = vim.fn.jobwait({ job }, 250)[1]
    if waited == -1 then
      pcall(vim.fn.jobstop, job)
    end
  end
  state.live.job = nil
  state.live.pending = {}
  state.live.events = {}
  state.live.stdout = ""
  state.live.stream_generation = {}
  state.live.streaming = {}
  state.live.applying_remote = {}
  state.live.presence_generation = {}
  state.live.awareness = nil
  for _, bufnr in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_valid(bufnr) then
      pcall(vim.api.nvim_buf_clear_namespace, bufnr, state.presence_ns, 0, -1)
    end
  end
end

local function buffer_for_document(document_id)
  for _, bufnr in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_valid(bufnr) then
      local doc = vim.b[bufnr].vehicle_garden_document
      if type(doc) == "table" and doc.document_id == document_id then
        return bufnr, doc
      end
    end
  end
  return nil, nil
end

local function handle_live_message(line)
  local ok, decoded = pcall(vim.json.decode, line)
  if not ok or type(decoded) ~= "table" then
    return
  end
  if decoded.id ~= nil then
    state.live.pending[tostring(decoded.id)] = decoded
    return
  end
  table.insert(state.live.events, decoded)
  if decoded.event == "remote-update" and decoded.payload then
    vim.schedule(function()
      local bufnr, doc = buffer_for_document(decoded.payload.document_id)
      if not bufnr or not doc or not refresh_from_projection then
        return
      end
      if vim.bo[bufnr].modified then
        vim.notify(
          "VehicleGarden deferred a remote update for "
            .. tostring(doc.document_id)
            .. " because the buffer has unsaved edits; save or undo, then run :VehicleGardenSync",
          vim.log.levels.WARN
        )
        return
      end
      if adopt_projection_if_buffer_matches and adopt_projection_if_buffer_matches(doc, decoded.payload, bufnr) then
        return
      end
      refresh_from_projection(doc, decoded.payload, bufnr)
    end)
  elseif decoded.event == "awareness" and decoded.payload then
    state.live.awareness = decoded.payload
    vim.schedule(function()
      if render_presence then
        local document_id = decoded.payload.document_id
        local bufnr, doc = buffer_for_document(document_id)
        if bufnr and doc then
          render_presence(bufnr, doc)
        end
      end
    end)
  end
end

local function ensure_live_bridge()
  if state.live.job then
    return
  end
  state.live.job = vim.fn.jobstart({ bridge_bin(), "bridge", "live" }, {
    stdout_buffered = false,
    stderr_buffered = true,
    on_stdout = function(_, data, _)
      data = data or {}
      if #data == 0 then
        return
      end
      data[1] = state.live.stdout .. data[1]
      state.live.stdout = data[#data] or ""
      for index = 1, #data - 1 do
        local line = data[index]
        if line and line ~= "" then
          handle_live_message(line)
        end
      end
    end,
    on_stderr = function(_, data, _)
      local lines = {}
      for _, line in ipairs(data or {}) do
        if line and line ~= "" then
          table.insert(lines, line)
        end
      end
      if #lines > 0 then
        vim.notify(table.concat(lines, "\n"), vim.log.levels.WARN)
      end
    end,
    on_exit = function(_, code, _)
      local stopping = state.live.stopping
      state.live.job = nil
      state.live.stopping = false
      if code ~= 0 and not stopping then
        vim.schedule(function()
          vim.notify("vehicle bridge live process exited with " .. tostring(code), vim.log.levels.ERROR)
        end)
      end
    end,
  })
  if state.live.job <= 0 then
    error("failed to start vehicle bridge live process")
  end
end

local function live_request(method, params)
  ensure_live_bridge()
  state.live.next_id = state.live.next_id + 1
  local id = tostring(state.live.next_id)
  state.live.pending[id] = nil
  local message = vim.json.encode({ id = id, method = method, params = params or {} }) .. "\n"
  local ok = vim.fn.chansend(state.live.job, message)
  if ok == 0 then
    error("failed to send request to vehicle bridge live process")
  end
  local timeout_ms = state.adapter.timeout_ms or 5000
  local received = vim.wait(timeout_ms, function()
    return state.live.pending[id] ~= nil
  end, 10)
  if not received then
    error("vehicle bridge live request timed out: " .. method)
  end
  local response = state.live.pending[id]
  state.live.pending[id] = nil
  if not response.ok then
    error("vehicle bridge live request failed: " .. tostring(response.error))
  end
  return response.result
end

local function setup_highlights()
  vim.api.nvim_set_hl(0, "VehicleGardenBold", { bold = true })
  vim.api.nvim_set_hl(0, "VehicleGardenItalic", { italic = true })
  vim.api.nvim_set_hl(0, "VehicleGardenStrike", { strikethrough = true })
  vim.api.nvim_set_hl(0, "VehicleGardenCode", { link = "DiagnosticVirtualTextInfo", default = true })
  vim.api.nvim_set_hl(0, "VehicleGardenLink", { underline = true })
  vim.api.nvim_set_hl(0, "VehicleGardenHighlight", { link = "Search", default = true })
  vim.api.nvim_set_hl(0, "VehicleGardenComment", { link = "DiagnosticVirtualTextHint", default = true })
  vim.api.nvim_set_hl(0, "VehicleGardenCommentResolved", { link = "NonText", default = true })
  vim.api.nvim_set_hl(0, "VehicleGardenCommentIndicator", { link = "DiagnosticWarn", default = true })
  vim.api.nvim_set_hl(0, "VehicleGardenFootnote", { link = "DiagnosticInfo", default = true })
  vim.api.nvim_set_hl(0, "VehicleGardenWire", { link = "DiagnosticVirtualTextWarn", default = true })
  vim.api.nvim_set_hl(0, "VehicleGardenIndent", { link = "NonText", default = true })
  vim.api.nvim_set_hl(0, "VehicleGardenHeading", { link = "Title", default = true })
  vim.api.nvim_set_hl(0, "VehicleGardenHeadingPrefix", { link = "Special", default = true })
  vim.api.nvim_set_hl(0, "VehicleGardenListPrefix", { link = "Special", default = true })
  vim.api.nvim_set_hl(0, "VehicleGardenQuote", { link = "Comment", default = true })
  vim.api.nvim_set_hl(0, "VehicleGardenQuotePrefix", { link = "Comment", default = true })
  vim.api.nvim_set_hl(0, "VehicleGardenCodeBlock", { link = "String", default = true })
  vim.api.nvim_set_hl(0, "VehicleGardenCodePrefix", { link = "DiagnosticVirtualTextInfo", default = true })
  vim.api.nvim_set_hl(0, "VehicleGardenPresenceCursor", { link = "DiagnosticVirtualTextInfo", default = true })
  vim.api.nvim_set_hl(0, "VehicleGardenPresenceLabel", { link = "DiagnosticVirtualTextInfo", default = true })
  vim.api.nvim_set_hl(0, "VehicleGardenTreeTitle", { link = "Title", default = true })
  vim.api.nvim_set_hl(0, "VehicleGardenTreeHeading", { link = "Function", default = true })
  vim.api.nvim_set_hl(0, "VehicleGardenTreeQuote", { link = "Comment", default = true })
  vim.api.nvim_set_hl(0, "VehicleGardenTreeList", { link = "Special", default = true })
  vim.api.nvim_set_hl(0, "VehicleGardenTreeCode", { link = "String", default = true })
  vim.api.nvim_set_hl(0, "VehicleGardenTreeComment", { link = "DiagnosticWarn", default = true })
  vim.api.nvim_set_hl(0, "VehicleGardenTreeFootnote", { link = "DiagnosticInfo", default = true })
  vim.api.nvim_set_hl(0, "VehicleGardenTreeDim", { link = "NonText", default = true })
end

function M.setup(opts)
  opts = opts or {}
  if opts.adapter then
    state.adapter = vim.tbl_deep_extend("force", state.adapter, opts.adapter)
  end
  setup_highlights()
end

local function byte_index_for_utf16(text, offset)
  if offset <= 0 then
    return 0
  end
  local units = 0
  local byte_index = 0
  while byte_index < #text do
    if units >= offset then
      return byte_index
    end
    local first_byte = string.byte(text, byte_index + 1)
    local width
    if first_byte < 0x80 then
      width = 1
    elseif first_byte < 0xE0 then
      width = 2
    elseif first_byte < 0xF0 then
      width = 3
    elseif first_byte < 0xF8 then
      width = 4
    else
      width = 1
    end
    local char_units = width == 4 and 2 or 1
    if units + char_units > offset then
      return byte_index
    end
    units = units + char_units
    byte_index = math.min(byte_index + width, #text)
  end
  return #text
end

local function utf16_offset_for_byte(text, byte_offset)
  local units = 0
  local byte_index = 0
  local target = math.max(0, math.min(byte_offset or 0, #text))
  while byte_index < target do
    local first_byte = string.byte(text, byte_index + 1)
    local width
    if first_byte < 0x80 then
      width = 1
    elseif first_byte < 0xE0 then
      width = 2
    elseif first_byte < 0xF0 then
      width = 3
    elseif first_byte < 0xF8 then
      width = 4
    else
      width = 1
    end
    if byte_index + width > target then
      break
    end
    units = units + (width == 4 and 2 or 1)
    byte_index = byte_index + width
  end
  return units
end

local function projection_to_document(document_id, projection)
  local lines = {}
  local blocks = {}
  for index, line in ipairs(projection.lines or {}) do
    lines[index] = line.text or ""
    blocks[index] = {
      block_id = line.block_id,
      kind = line.node_type,
      support = line.support,
      attrs = line.attrs or {},
      marks = line.marks or {},
      inline_atoms = line.inline_atoms or {},
      original_text = line.text or "",
      mark_id = nil,
    }
  end
  local title = projection.title
  if title == nil or title == vim.NIL then
    title = projection.document_id or document_id
  end
  return {
    document_id = projection.document_id or document_id,
    title = title,
    projection = projection,
    blocks = blocks,
    comments = projection.comments or {},
    lines = lines,
  }
end

local function read_document(document_id)
  if state.adapter.kind == "json-file" then
    local path = doc_path(document_id)
    local document = vim.json.decode(read_file(path))
    local lines = {}
    local blocks = {}

    for index, block in ipairs(document.blocks or {}) do
      lines[index] = block.text or ""
      blocks[index] = {
        block_id = block.block_id,
        kind = block.kind,
        support = "editable-text",
        attrs = {},
        marks = {},
        inline_atoms = {},
        original_text = block.text or "",
        mark_id = nil,
      }
    end
    return {
      document_id = document.document_id,
      title = document.title,
      path = path,
      blocks = blocks,
      comments = {},
      lines = lines,
    }
  elseif state.adapter.kind == "bridge-json" then
    local projection = run_bridge({
      "bridge",
      "project-json",
      "--root",
      state.adapter.root,
      "--document-id",
      document_id,
    })
    local doc = projection_to_document(document_id, projection)
    doc.path = doc_path(document_id)
    return doc
  elseif state.adapter.kind == "bridge-ydoc-file" then
    local projection = run_bridge({
      "bridge",
      "project-ydoc",
      "--path",
      ydoc_path(document_id),
      "--document-id",
      document_id,
    })
    local doc = projection_to_document(document_id, projection)
    doc.path = ydoc_path(document_id)
    return doc
  elseif state.adapter.kind == "bridge-ydoc-room" then
    local projection = run_bridge(add_room_auth_args({
      "bridge",
      "sync-ydoc-once",
      "--path",
      ydoc_path(document_id),
      "--url",
      room_url(document_id),
      "--document-id",
      document_id,
    }))
    local doc = projection_to_document(document_id, projection)
    doc.path = ydoc_path(document_id)
    return doc
  elseif state.adapter.kind == "live-ydoc-file" then
    local projection = live_request("open-ydoc-file", {
      path = ydoc_path(document_id),
      document_id = document_id,
    })
    local doc = projection_to_document(document_id, projection)
    doc.path = ydoc_path(document_id)
    return doc
  elseif state.adapter.kind == "live-ydoc-room" then
    local projection = live_request("open-ydoc-room", {
      path = ydoc_path(document_id),
      document_id = document_id,
      url = room_url(document_id),
      token_env = state.adapter.token_env or "VEHICLE_GARDEN_TOKEN",
      on_behalf_of = state.adapter.on_behalf_of,
      on_behalf_of_env = state.adapter.on_behalf_of_env,
      timeout_ms = state.adapter.timeout_ms or 5000,
    })
    local doc = projection_to_document(document_id, projection)
    doc.path = ydoc_path(document_id)
    return doc
  else
    error("unsupported vehicle.nvim adapter.kind=" .. tostring(state.adapter.kind))
  end
end

local function render_marks(bufnr, doc)
  vim.api.nvim_buf_clear_namespace(bufnr, state.mark_ns, 0, -1)
  local comments = {}
  for _, comment in ipairs(doc.comments or {}) do
    comments[comment.comment_id] = comment
  end
  for index, block in ipairs(doc.blocks or {}) do
    for _, mark in ipairs(block.marks or {}) do
      local hl = MARK_HIGHLIGHTS[mark.mark_type]
      if mark.mark_type == "commentMark" then
        local attrs = type(mark.attrs) == "table" and mark.attrs or {}
        local comment_id = attrs.commentId or attrs["data-comment-id"]
        local comment = comment_id and comments[comment_id] or nil
        if comment and type(comment.data) == "table" and comment.data.resolved == true then
          hl = "VehicleGardenCommentResolved"
        end
      end
      if hl then
        local position = block.mark_id
            and vim.api.nvim_buf_get_extmark_by_id(bufnr, state.ns, block.mark_id, {})
          or {}
        local line = #position > 0 and position[1] or (index - 1)
        local text = vim.api.nvim_buf_get_lines(bufnr, line, line + 1, false)[1] or ""
        local start_col = byte_index_for_utf16(text, mark.start_utf16 or 0)
        local end_col = byte_index_for_utf16(text, mark.end_utf16 or 0)
        vim.api.nvim_buf_set_extmark(bufnr, state.mark_ns, line, start_col, {
          end_col = end_col,
          hl_group = hl,
          right_gravity = false,
          end_right_gravity = true,
        })
      end
    end
  end
end

local function numeric_attr(attrs, key, fallback)
  local value = attrs and attrs[key]
  if value == nil or value == vim.NIL then
    return fallback
  end
  return tonumber(value) or fallback
end

local function block_prefix(block)
  local indent = math.max(0, math.min(6, numeric_attr(block.attrs, "indent", 0)))
  local chunks = {}
  if indent > 0 then
    table.insert(chunks, { string.rep("  ", indent), "VehicleGardenIndent" })
  end

  if block.kind == "heading" then
    local level = math.max(1, math.min(6, numeric_attr(block.attrs, "level", 1)))
    table.insert(chunks, { string.rep("#", level) .. " ", "VehicleGardenHeadingPrefix" })
  elseif block.kind == "blockquote" then
    table.insert(chunks, { "│ ", "VehicleGardenQuotePrefix" })
  elseif block.kind == "listItem" then
    local list_type = block.attrs and (block.attrs.listType or block.attrs["data-list-type"])
    local marker = list_type == "ordered" and "1. " or (list_type == "task" and "☐ " or "• ")
    table.insert(chunks, { marker, "VehicleGardenListPrefix" })
  elseif block.kind == "codeBlock" then
    table.insert(chunks, { "▏ ", "VehicleGardenCodePrefix" })
  end
  return chunks
end

render_blocks = function(bufnr, doc)
  vim.api.nvim_buf_clear_namespace(bufnr, state.block_ns, 0, -1)
  local comments_by_block = {}
  for _, comment in ipairs(doc.comments or {}) do
    local block_id = comment.block_id
    if block_id and block_id ~= vim.NIL then
      comments_by_block[block_id] = comments_by_block[block_id] or { open = 0, resolved = 0 }
      local data = type(comment.data) == "table" and comment.data or {}
      local key = data.resolved == true and "resolved" or "open"
      comments_by_block[block_id][key] = comments_by_block[block_id][key] + 1
    end
  end
  local footnote_number = 0
  for index, block in ipairs(doc.blocks or {}) do
    local position = block.mark_id
        and vim.api.nvim_buf_get_extmark_by_id(bufnr, state.ns, block.mark_id, {})
      or {}
    local line = #position > 0 and position[1] or (index - 1)
    local text = vim.api.nvim_buf_get_lines(bufnr, line, line + 1, false)[1] or ""
    local prefix = block_prefix(block)
    if #prefix > 0 then
      vim.api.nvim_buf_set_extmark(bufnr, state.block_ns, line, 0, {
        virt_text = prefix,
        virt_text_pos = "inline",
        priority = 80,
      })
    end

    local text_highlight = block.kind == "heading" and "VehicleGardenHeading"
      or (block.kind == "blockquote" and "VehicleGardenQuote")
      or (block.kind == "codeBlock" and "VehicleGardenCodeBlock")
      or nil
    if text_highlight and #text > 0 then
      vim.api.nvim_buf_set_extmark(bufnr, state.block_ns, line, 0, {
        end_col = #text,
        hl_group = text_highlight,
        priority = 70,
      })
    end

    for _, atom in ipairs(block.inline_atoms or {}) do
      if atom.atom_type == "footnote" then
        footnote_number = footnote_number + 1
        local col = byte_index_for_utf16(text, tonumber(atom.offset_utf16) or 0)
        vim.api.nvim_buf_set_extmark(bufnr, state.block_ns, line, col, {
          virt_text = { { "[" .. tostring(footnote_number) .. "]", "VehicleGardenFootnote" } },
          virt_text_pos = "inline",
          priority = 110,
          right_gravity = false,
        })
      end
    end

    local eol = {}
    local comment_counts = comments_by_block[block.block_id]
    if comment_counts and comment_counts.open > 0 then
      table.insert(eol, { "  💬" .. tostring(comment_counts.open), "VehicleGardenCommentIndicator" })
    end
    if comment_counts and comment_counts.resolved > 0 then
      table.insert(eol, { "  ✓" .. tostring(comment_counts.resolved), "VehicleGardenCommentResolved" })
    end
    if block.support ~= nil and block.support ~= "editable-text" then
      table.insert(eol, { " [" .. tostring(block.support) .. "]", "DiagnosticVirtualTextWarn" })
    end
    if #eol > 0 then
      vim.api.nvim_buf_set_extmark(bufnr, state.block_ns, line, 0, {
        virt_text = eol,
        virt_text_pos = "eol",
        priority = 80,
      })
    end
  end
end

local function presence_highlights(client_id, color)
  local suffix = tostring(client_id or "remote"):gsub("[^%w]", "")
  local cursor_group = "VehicleGardenPresenceCursor" .. suffix
  local label_group = "VehicleGardenPresenceLabel" .. suffix
  if type(color) == "string" and (color:match("^#%x%x%x%x%x%x$") or color:match("^#%x%x%x$")) then
    vim.api.nvim_set_hl(0, cursor_group, { fg = color, bold = true })
    vim.api.nvim_set_hl(0, label_group, { fg = color, bold = true })
  else
    vim.api.nvim_set_hl(0, cursor_group, { link = "VehicleGardenPresenceCursor" })
    vim.api.nvim_set_hl(0, label_group, { link = "VehicleGardenPresenceLabel" })
  end
  return cursor_group, label_group
end

render_presence = function(bufnr, doc)
  vim.api.nvim_buf_clear_namespace(bufnr, state.presence_ns, 0, -1)
  local awareness = state.live.awareness
  if type(awareness) ~= "table" or awareness.document_id ~= doc.document_id then
    return
  end

  local blocks = {}
  for _, block in ipairs(doc.blocks or {}) do
    blocks[block.block_id] = block
  end
  for _, client in ipairs(awareness.clients or {}) do
    local block_id = client.block_id
    local block = block_id and block_id ~= vim.NIL and blocks[block_id] or nil
    if not client["local"] and block then
      local position = vim.api.nvim_buf_get_extmark_by_id(bufnr, state.ns, block.mark_id, {})
      if #position > 0 then
        local line = position[1]
        local text = vim.api.nvim_buf_get_lines(bufnr, line, line + 1, false)[1] or ""
        local offset_utf16 = tonumber(client.offset_utf16) or 0
        local byte_col = byte_index_for_utf16(text, offset_utf16)
        local user = type(client.state) == "table" and client.state.user or {}
        user = type(user) == "table" and user or {}
        local name = user.name or "collaborator"
        local cursor_group, label_group = presence_highlights(client.client_id, user.color)
        vim.api.nvim_buf_set_extmark(bufnr, state.presence_ns, line, byte_col, {
          virt_text = { { "▏", cursor_group } },
          virt_text_pos = "inline",
          priority = 220,
          right_gravity = false,
        })
        vim.api.nvim_buf_set_extmark(bufnr, state.presence_ns, line, 0, {
          virt_text = { { "  " .. tostring(name), label_group } },
          virt_text_pos = "eol",
          priority = 220,
        })
      end
    end
  end
end

local function render_document(bufnr, doc)
  render_blocks(bufnr, doc)
  render_marks(bufnr, doc)
  if render_presence then
    render_presence(bufnr, doc)
  end
  if refresh_tree_for_document then
    refresh_tree_for_document(bufnr)
  end
end

adopt_projection_if_buffer_matches = function(doc, projection, bufnr)
  local next_doc = projection_to_document(doc.document_id, projection)
  local current_lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
  if not vim.deep_equal(current_lines, next_doc.lines) then
    return false
  end

  local old_by_id = {}
  for _, block in ipairs(doc.blocks or {}) do
    old_by_id[block.block_id] = block
  end
  for _, block in ipairs(next_doc.blocks) do
    local old = old_by_id[block.block_id]
    if not old or not old.mark_id then
      return false
    end
    block.mark_id = old.mark_id
  end

  doc.title = next_doc.title
  doc.blocks = next_doc.blocks
  doc.comments = next_doc.comments
  doc.projection = projection
  vim.b[bufnr].vehicle_garden_document = doc
  vim.bo[bufnr].modified = false
  render_document(bufnr, doc)
  return true
end

local function streaming_enabled()
  return state.adapter.stream_changes ~= false
    and (state.adapter.kind == "live-ydoc-file" or state.adapter.kind == "live-ydoc-room")
end

local function presence_enabled()
  return state.adapter.kind == "live-ydoc-room" and state.adapter.presence ~= false
end

local function presence_user()
  local configured = type(state.adapter.presence) == "table" and state.adapter.presence or {}
  local username = vim.env.USER or "Neovim"
  local hostname = (vim.uv and vim.uv.os_gethostname and vim.uv.os_gethostname()) or "local"
  return {
    userId = configured.user_id or configured.userId or (username .. "@" .. hostname .. ":vehicle-neovim"),
    name = configured.name or (username .. " · Neovim"),
    avatar = configured.avatar or "",
    color = configured.color or "#7aa2f7",
    type = configured.type or "human",
    lastActive = os.time() * 1000,
  }
end

local function block_at_line(doc, bufnr, line)
  for _, block in ipairs(doc.blocks or {}) do
    local position = vim.api.nvim_buf_get_extmark_by_id(bufnr, state.ns, block.mark_id, {})
    if #position > 0 and position[1] + 1 == line then
      return block
    end
  end
  return nil
end

local function schedule_presence(bufnr)
  if not presence_enabled() or state.live.applying_remote[bufnr] then
    return
  end
  local generation = (state.live.presence_generation[bufnr] or 0) + 1
  state.live.presence_generation[bufnr] = generation
  vim.defer_fn(function()
    if state.live.presence_generation[bufnr] ~= generation then
      return
    end
    if not vim.api.nvim_buf_is_valid(bufnr) or not vim.api.nvim_buf_is_loaded(bufnr) then
      return
    end
    if vim.bo[bufnr].modified or state.live.streaming[bufnr] then
      schedule_presence(bufnr)
      return
    end
    local winid = vim.fn.bufwinid(bufnr)
    if winid == -1 then
      return
    end
    local doc = vim.b[bufnr].vehicle_garden_document
    if type(doc) ~= "table" then
      return
    end
    local cursor = vim.api.nvim_win_get_cursor(winid)
    local block = block_at_line(doc, bufnr, cursor[1])
    if not block then
      return
    end
    local text = vim.api.nvim_buf_get_lines(bufnr, cursor[1] - 1, cursor[1], false)[1] or ""
    local offset_utf16 = utf16_offset_for_byte(text, cursor[2])
    local ok, payload = pcall(live_request, "set-awareness", {
      user = presence_user(),
      block_id = block.block_id,
      offset_utf16 = offset_utf16,
    })
    if not ok then
      vim.notify("VehicleGarden presence failed: " .. tostring(payload), vim.log.levels.WARN)
      return
    end
    state.live.awareness = payload
    if render_presence then
      render_presence(bufnr, doc)
    end
  end, state.adapter.presence_debounce_ms or 80)
end

local function schedule_stream(bufnr)
  if not streaming_enabled() or state.live.applying_remote[bufnr] then
    return
  end
  local generation = (state.live.stream_generation[bufnr] or 0) + 1
  state.live.stream_generation[bufnr] = generation
  vim.defer_fn(function()
    if state.live.stream_generation[bufnr] ~= generation then
      return
    end
    if not vim.api.nvim_buf_is_valid(bufnr) or not vim.api.nvim_buf_is_loaded(bufnr) then
      return
    end
    if not vim.bo[bufnr].modified then
      return
    end
    if state.live.streaming[bufnr] then
      schedule_stream(bufnr)
      return
    end

    state.live.streaming[bufnr] = true
    local ok, err = pcall(vim.api.nvim_buf_call, bufnr, function()
      M.save({ quiet = true, skip_sync = true })
    end)
    state.live.streaming[bufnr] = nil
    if not ok then
      vim.notify("VehicleGarden stream failed: " .. tostring(err), vim.log.levels.ERROR)
    end
  end, state.adapter.stream_debounce_ms or 120)
end

function M.open(document_id)
  local document = read_document(document_id)
  local lines = document.lines
  local blocks = document.blocks

  vim.cmd("noswapfile enew")
  local bufnr = vim.api.nvim_get_current_buf()
  vim.bo[bufnr].swapfile = false
  vim.bo[bufnr].filetype = "vehicle-garden"
  vim.bo[bufnr].buftype = ""
  vim.bo[bufnr].bufhidden = "hide"
  vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, lines)
  vim.api.nvim_buf_set_name(bufnr, "vehicle://" .. document_id)

  for index, block in ipairs(blocks) do
    block.mark_id = vim.api.nvim_buf_set_extmark(bufnr, state.ns, index - 1, 0, {
      right_gravity = false,
      undo_restore = true,
      invalidate = false,
    })
  end
  render_document(bufnr, document)

  vim.b[bufnr].vehicle_garden_document = {
    document_id = document.document_id,
    title = document.title,
    path = document.path,
    adapter_kind = state.adapter.kind,
    projection = document.projection,
    blocks = blocks,
    comments = document.comments or {},
  }
  vim.api.nvim_create_autocmd("BufWriteCmd", {
    buffer = bufnr,
    callback = function()
      M.save()
    end,
    desc = "Save the current Garden document through Vehicle",
  })
  vim.api.nvim_create_autocmd("CursorMoved", {
    buffer = bufnr,
    callback = function(args)
      if sync_tree_cursor then
        sync_tree_cursor(args.buf)
      end
    end,
    desc = "Keep the Garden tree on the current block",
  })
  if streaming_enabled() then
    vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI" }, {
      buffer = bufnr,
      callback = function(args)
        schedule_stream(args.buf)
      end,
      desc = "Stream Neovim changes to the live Garden document",
    })
  end
  if presence_enabled() then
    vim.api.nvim_create_autocmd({ "CursorMoved", "CursorMovedI" }, {
      buffer = bufnr,
      callback = function(args)
        schedule_presence(args.buf)
      end,
      desc = "Publish the Neovim cursor through Garden awareness",
    })
    vim.schedule(function()
      if vim.api.nvim_buf_is_valid(bufnr) then
        schedule_presence(bufnr)
      end
    end)
  end
  local function mapped_indent(delta, first_line, last_line, explicit_range)
    local ok, err = pcall(M.indent, delta, first_line, last_line, explicit_range)
    if not ok then
      vim.notify("VehicleGarden indent failed: " .. tostring(err), vim.log.levels.ERROR)
    end
  end
  vim.keymap.set("n", ">>", function()
    mapped_indent(1)
  end, { buffer = bufnr, desc = "Indent Garden block (and its children)" })
  vim.keymap.set("n", "<<", function()
    mapped_indent(-1)
  end, { buffer = bufnr, desc = "Dedent Garden block (and its children)" })
  vim.keymap.set("n", "<Tab>", function()
    mapped_indent(1)
  end, { buffer = bufnr, desc = "Indent Garden block (and its children)" })
  vim.keymap.set("n", "<S-Tab>", function()
    mapped_indent(-1)
  end, { buffer = bufnr, desc = "Dedent Garden block (and its children)" })
  local function insert_tab(delta)
    local cursor_line = vim.api.nvim_win_get_cursor(0)[1]
    local doc = vim.b[bufnr].vehicle_garden_document
    for _, block in ipairs((doc and doc.blocks) or {}) do
      local position = vim.api.nvim_buf_get_extmark_by_id(bufnr, state.ns, block.mark_id, {})
      if #position > 0 and position[1] + 1 == cursor_line then
        if block.kind == "codeBlock" and delta > 0 then
          return "\t"
        end
        break
      end
    end
    vim.schedule(function()
      if vim.api.nvim_buf_is_valid(bufnr) then
        vim.api.nvim_buf_call(bufnr, function()
          mapped_indent(delta)
        end)
      end
    end)
    return ""
  end
  vim.keymap.set("i", "<Tab>", function()
    return insert_tab(1)
  end, { buffer = bufnr, expr = true, desc = "Indent Garden block" })
  vim.keymap.set("i", "<S-Tab>", function()
    return insert_tab(-1)
  end, { buffer = bufnr, expr = true, desc = "Dedent Garden block" })
  vim.keymap.set("i", "<CR>", function()
    if vim.fn.pumvisible() == 1 then
      return vim.api.nvim_replace_termcodes("<C-y>", true, false, true)
    end
    local cursor = vim.api.nvim_win_get_cursor(0)
    vim.schedule(function()
      if vim.api.nvim_buf_is_valid(bufnr) then
        vim.api.nvim_buf_call(bufnr, function()
          local ok, err = pcall(M.split_block, cursor[1], cursor[2], true)
          if not ok then
            vim.notify("VehicleGarden split failed: " .. tostring(err), vim.log.levels.ERROR)
          end
        end)
      end
    end)
    return ""
  end, { buffer = bufnr, expr = true, desc = "Split the current Garden block" })
  vim.keymap.set("i", "<BS>", function()
    local cursor = vim.api.nvim_win_get_cursor(0)
    if cursor[2] > 0 or cursor[1] <= 1 then
      return vim.api.nvim_replace_termcodes("<BS>", true, false, true)
    end
    vim.schedule(function()
      if vim.api.nvim_buf_is_valid(bufnr) then
        vim.api.nvim_buf_call(bufnr, function()
          local ok, err = pcall(M.join_previous, cursor[1], true)
          if not ok then
            vim.notify("VehicleGarden join failed: " .. tostring(err), vim.log.levels.ERROR)
          end
        end)
      end
    end)
    return ""
  end, { buffer = bufnr, expr = true, desc = "Join with the previous Garden block" })
  vim.keymap.set("n", "o", function()
    local ok, err = pcall(M.insert_block, vim.api.nvim_win_get_cursor(0)[1], false, true)
    if not ok then
      vim.notify("VehicleGarden insert failed: " .. tostring(err), vim.log.levels.ERROR)
    end
  end, { buffer = bufnr, desc = "Insert a Garden block below" })
  vim.keymap.set("n", "O", function()
    local ok, err = pcall(M.insert_block, vim.api.nvim_win_get_cursor(0)[1], true, true)
    if not ok then
      vim.notify("VehicleGarden insert failed: " .. tostring(err), vim.log.levels.ERROR)
    end
  end, { buffer = bufnr, desc = "Insert a Garden block above" })
  vim.keymap.set("n", "J", function()
    local ok, err = pcall(M.join_next, vim.api.nvim_win_get_cursor(0)[1], false)
    if not ok then
      vim.notify("VehicleGarden join failed: " .. tostring(err), vim.log.levels.ERROR)
    end
  end, { buffer = bufnr, desc = "Join the next Garden block" })
  vim.keymap.set("x", ">", function()
    local first_line = math.min(vim.fn.line("v"), vim.fn.line("."))
    local last_line = math.max(vim.fn.line("v"), vim.fn.line("."))
    mapped_indent(1, first_line, last_line, true)
    vim.cmd("normal! gv")
  end, { buffer = bufnr, desc = "Indent selected Garden blocks" })
  vim.keymap.set("x", "<", function()
    local first_line = math.min(vim.fn.line("v"), vim.fn.line("."))
    local last_line = math.max(vim.fn.line("v"), vim.fn.line("."))
    mapped_indent(-1, first_line, last_line, true)
    vim.cmd("normal! gv")
  end, { buffer = bufnr, desc = "Dedent selected Garden blocks" })
  vim.bo[bufnr].modified = false
end

refresh_from_projection = function(doc, projection, bufnr)
  bufnr = bufnr or vim.api.nvim_get_current_buf()
  local next_doc = projection_to_document(doc.document_id, projection)
  state.live.applying_remote[bufnr] = true
  vim.api.nvim_buf_clear_namespace(bufnr, state.ns, 0, -1)
  vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, next_doc.lines)
  for index, block in ipairs(next_doc.blocks) do
    block.mark_id = vim.api.nvim_buf_set_extmark(bufnr, state.ns, index - 1, 0, {
      right_gravity = false,
      undo_restore = true,
      invalidate = false,
    })
  end
  doc.blocks = next_doc.blocks
  doc.comments = next_doc.comments
  doc.title = next_doc.title
  doc.projection = projection
  vim.b[bufnr].vehicle_garden_document = doc
  vim.bo[bufnr].modified = false
  state.live.applying_remote[bufnr] = nil
  render_document(bufnr, doc)
end

local function line_by_block(doc)
  local bufnr = vim.api.nvim_get_current_buf()
  local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
  if #lines ~= #doc.blocks then
    error(
      string.format(
        "vehicle.nvim v0 preserves one line per Garden block; got %d lines for %d blocks",
        #lines,
        #doc.blocks
      )
    )
  end

  local by_id = {}
  local occupied = {}
  for _, block in ipairs(doc.blocks) do
    local position = vim.api.nvim_buf_get_extmark_by_id(bufnr, state.ns, block.mark_id, {})
    if #position == 0 then
      error("Garden block lost its Neovim extmark: " .. tostring(block.block_id))
    end
    local line_index = position[1] + 1
    if occupied[line_index] then
      error(
        string.format(
          "multiple Garden block extmarks occupy line %d: %s and %s",
          line_index,
          occupied[line_index],
          block.block_id
        )
      )
    end
    occupied[line_index] = block.block_id
    by_id[block.block_id] = lines[line_index]
  end

  local occupied_count = 0
  for _ in pairs(occupied) do
    occupied_count = occupied_count + 1
  end
  if occupied_count ~= #lines then
    error("at least one buffer line has no Garden block extmark")
  end

  return by_id
end

local function is_ydoc_adapter(kind)
  return kind == "bridge-ydoc-file"
    or kind == "bridge-ydoc-room"
    or kind == "live-ydoc-file"
    or kind == "live-ydoc-room"
end

local function apply_ydoc_request(doc, request, opts)
  opts = opts or {}
  local projection
  if doc.adapter_kind == "live-ydoc-file" or doc.adapter_kind == "live-ydoc-room" then
    projection = live_request("apply", { request = request })
  else
    projection = run_bridge(
      {
        "bridge",
        "apply-ydoc",
        "--path",
        doc.path,
        "--document-id",
        doc.document_id,
      },
      vim.json.encode(request)
    )
  end
  if doc.adapter_kind == "bridge-ydoc-room" then
    projection = run_bridge(add_room_auth_args({
      "bridge",
      "sync-ydoc-once",
      "--path",
      doc.path,
      "--url",
      room_url(doc.document_id),
      "--document-id",
      doc.document_id,
    }))
  elseif doc.adapter_kind == "live-ydoc-room" and not opts.skip_sync then
    projection = live_request("sync", {})
  end
  return projection
end

local OUTLINER_KINDS = {
  paragraph = true,
  heading = true,
  listItem = true,
  blockquote = true,
}

local function ordered_outliner_blocks(doc, bufnr)
  local result = {}
  for _, block in ipairs(doc.blocks or {}) do
    if OUTLINER_KINDS[block.kind] then
      local position = vim.api.nvim_buf_get_extmark_by_id(bufnr, state.ns, block.mark_id, {})
      if #position > 0 then
        table.insert(result, {
          block = block,
          line = position[1] + 1,
          indent = math.max(0, math.min(6, numeric_attr(block.attrs, "indent", 0))),
        })
      end
    end
  end
  table.sort(result, function(left, right)
    return left.line < right.line
  end)
  return result
end

function M.indent(delta, first_line, last_line, explicit_range)
  delta = delta >= 0 and 1 or -1
  local doc = current_doc()
  local bufnr = vim.api.nvim_get_current_buf()
  if not is_ydoc_adapter(doc.adapter_kind) then
    error("structural indentation requires a Y.Doc-backed Vehicle adapter")
  end
  if #M.changed_blocks() > 0 then
    M.save({ quiet = true, skip_sync = true })
    doc = current_doc()
  end

  first_line = first_line or vim.api.nvim_win_get_cursor(0)[1]
  last_line = last_line or first_line
  if first_line > last_line then
    first_line, last_line = last_line, first_line
  end

  local ordered = ordered_outliner_blocks(doc, bufnr)
  local targets = {}
  if explicit_range then
    for _, item in ipairs(ordered) do
      if item.line >= first_line and item.line <= last_line then
        table.insert(targets, item)
      end
    end
  else
    local parent_index
    for index, item in ipairs(ordered) do
      if item.line == first_line then
        parent_index = index
        break
      end
    end
    if not parent_index then
      error("the current line is not an indentable Garden block")
    end
    local parent = ordered[parent_index]
    if (delta > 0 and parent.indent >= 6) or (delta < 0 and parent.indent <= 0) then
      return doc.projection
    end
    table.insert(targets, parent)
    for index = parent_index + 1, #ordered do
      local child = ordered[index]
      if child.indent <= parent.indent then
        break
      end
      table.insert(targets, child)
    end
  end

  local operations = {}
  for _, item in ipairs(targets) do
    local next_indent = math.max(0, math.min(6, item.indent + delta))
    if next_indent ~= item.indent then
      table.insert(operations, {
        type = "set-block-attrs",
        block_id = item.block.block_id,
        attrs = { indent = next_indent },
      })
    end
  end
  if #operations == 0 then
    return doc.projection
  end

  local projection = apply_ydoc_request(doc, {
    document_id = doc.document_id,
    operations = operations,
  }, { skip_sync = true })
  if projection and not adopt_projection_if_buffer_matches(doc, projection, bufnr) then
    refresh_from_projection(doc, projection, bufnr)
  else
    render_document(bufnr, doc)
  end
  vim.notify(
    string.format("VehicleGarden %s %d block%s", delta > 0 and "indented" or "dedented", #operations, #operations == 1 and "" or "s")
  )
  return projection
end

local function new_block_id()
  local seed = table.concat({ tostring(vim.uv.hrtime()), tostring(math.random()), tostring(os.time()) }, ":")
  return "block-" .. vim.fn.sha256(seed):sub(1, 8)
end

local function require_structural_adapter(doc)
  if not is_ydoc_adapter(doc.adapter_kind) then
    error("structural block editing requires a Y.Doc-backed Vehicle adapter")
  end
end

local function flush_local_changes(doc)
  if #M.changed_blocks() > 0 then
    M.save({ quiet = true, skip_sync = true })
    return current_doc()
  end
  return doc
end

local function refresh_after_structure(doc, operations, bufnr)
  local projection = apply_ydoc_request(doc, {
    document_id = doc.document_id,
    operations = operations,
  }, { skip_sync = true })
  refresh_from_projection(doc, projection, bufnr)
  return projection, current_doc()
end

local function line_for_block(doc, bufnr, block_id)
  for _, block in ipairs(doc.blocks or {}) do
    if block.block_id == block_id then
      local position = vim.api.nvim_buf_get_extmark_by_id(bufnr, state.ns, block.mark_id, {})
      if #position > 0 then
        return position[1] + 1, block
      end
    end
  end
  return nil, nil
end

function M.split_block(line, byte_col, enter_insert)
  local doc = current_doc()
  local bufnr = vim.api.nvim_get_current_buf()
  require_structural_adapter(doc)
  line = line or vim.api.nvim_win_get_cursor(0)[1]
  local text = vim.api.nvim_buf_get_lines(bufnr, line - 1, line, false)[1] or ""
  byte_col = math.max(0, math.min(byte_col or vim.api.nvim_win_get_cursor(0)[2], #text))
  local offset_utf16 = utf16_offset_for_byte(text, byte_col)
  local block = block_at_line(doc, bufnr, line)
  if not block or block.support ~= "editable-text" then
    error("the current Garden block cannot be split")
  end
  doc = flush_local_changes(doc)
  block = block_at_line(doc, bufnr, line)
  if not block then
    error("the Garden block moved while preparing the split")
  end

  local created_id = new_block_id()
  local _, next_doc = refresh_after_structure(doc, {
    {
      type = "split-block",
      block_id = block.block_id,
      offset_utf16 = offset_utf16,
      new_block_id = created_id,
    },
  }, bufnr)
  local new_line = line_for_block(next_doc, bufnr, created_id)
  if not new_line then
    error("the split succeeded but the new Garden block was not projected")
  end
  vim.api.nvim_win_set_cursor(0, { new_line, 0 })
  if enter_insert and vim.fn.mode() ~= "i" then
    vim.cmd("startinsert")
  end
  return created_id
end

local function inserted_block_shape(block, block_id)
  local indent = math.max(0, math.min(6, numeric_attr(block.attrs, "indent", 0)))
  if block.kind == "listItem" then
    local list_type = block.attrs.listType or block.attrs["data-list-type"] or "bullet"
    return {
      type = "listItem",
      attrs = {
        ["data-block-id"] = block_id,
        listType = list_type,
        indent = indent,
        checked = false,
      },
      content = { { type = "paragraph" } },
    }
  end
  return {
    type = "paragraph",
    attrs = { ["data-block-id"] = block_id, indent = indent },
  }
end

function M.insert_block(line, before, enter_insert)
  local doc = current_doc()
  local bufnr = vim.api.nvim_get_current_buf()
  require_structural_adapter(doc)
  line = line or vim.api.nvim_win_get_cursor(0)[1]
  doc = flush_local_changes(doc)
  local block = block_at_line(doc, bufnr, line)
  if not block then
    error("the current line has no Garden block")
  end
  local after_block_id = block.block_id
  if before then
    after_block_id = nil
    local ordered = {}
    for _, candidate in ipairs(doc.blocks or {}) do
      local position = vim.api.nvim_buf_get_extmark_by_id(bufnr, state.ns, candidate.mark_id, {})
      if #position > 0 then
        table.insert(ordered, { block = candidate, line = position[1] + 1 })
      end
    end
    table.sort(ordered, function(left, right)
      return left.line < right.line
    end)
    for index, item in ipairs(ordered) do
      if item.block.block_id == block.block_id and index > 1 then
        after_block_id = ordered[index - 1].block.block_id
        break
      end
    end
  end

  local created_id = new_block_id()
  local _, next_doc = refresh_after_structure(doc, {
    {
      type = "insert-block",
      after_block_id = after_block_id,
      block = inserted_block_shape(block, created_id),
    },
  }, bufnr)
  local new_line = line_for_block(next_doc, bufnr, created_id)
  if not new_line then
    error("the insert succeeded but the new Garden block was not projected")
  end
  vim.api.nvim_win_set_cursor(0, { new_line, 0 })
  if enter_insert then
    vim.cmd("startinsert")
  end
  return created_id
end

function M.join_next(line, enter_insert)
  local doc = current_doc()
  local bufnr = vim.api.nvim_get_current_buf()
  require_structural_adapter(doc)
  line = line or vim.api.nvim_win_get_cursor(0)[1]
  doc = flush_local_changes(doc)
  local block = block_at_line(doc, bufnr, line)
  local next_block = block_at_line(doc, bufnr, line + 1)
  if not block or not next_block then
    return doc.projection
  end
  if block.support ~= "editable-text" or next_block.support ~= "editable-text" then
    error("both Garden blocks must be editable to join them")
  end
  local join_byte_col = #(vim.api.nvim_buf_get_lines(bufnr, line - 1, line, false)[1] or "")
  local block_id = block.block_id
  local projection, next_doc = refresh_after_structure(doc, {
    { type = "join-next", block_id = block_id },
  }, bufnr)
  local joined_line = line_for_block(next_doc, bufnr, block_id)
  if joined_line then
    vim.api.nvim_win_set_cursor(0, { joined_line, join_byte_col })
  end
  if enter_insert and vim.fn.mode() ~= "i" then
    vim.cmd("startinsert")
  end
  return projection
end

function M.join_previous(line, enter_insert)
  line = line or vim.api.nvim_win_get_cursor(0)[1]
  if line <= 1 then
    return current_doc().projection
  end
  return M.join_next(line - 1, enter_insert)
end

function M.changed_blocks()
  local doc = current_doc()
  local by_id = line_by_block(doc)

  local changed = {}
  for _, block in ipairs(doc.blocks) do
    local line = by_id[block.block_id]
    if line ~= block.original_text then
      table.insert(changed, {
        block_id = block.block_id,
        kind = block.kind,
        support = block.support,
        text = line,
      })
    end
  end
  return changed
end

function M.save(opts)
  opts = opts or {}
  local doc = current_doc()
  local bufnr = vim.api.nvim_get_current_buf()
  local by_id = line_by_block(doc)
  local changed = M.changed_blocks()
  local changed_count = #changed

  for _, block in ipairs(changed) do
    if block.support ~= nil and block.support ~= "editable-text" then
      error("refusing to edit non-editable Garden block " .. block.block_id .. " (" .. tostring(block.support) .. ")")
    end
  end

  if changed_count == 0 then
    vim.bo[bufnr].modified = false
    if not opts.quiet then
      vim.notify("VehicleGarden is already synchronized")
    end
    return doc.projection
  end

  local projection
  if doc.adapter_kind == "bridge-json" then
    local request = { lines = {} }
    for _, block in ipairs(changed) do
      table.insert(request.lines, { block_id = block.block_id, text = block.text })
    end
    run_bridge(
      {
        "bridge",
        "save-json",
        "--root",
        state.adapter.root,
        "--document-id",
        doc.document_id,
      },
      vim.json.encode(request)
    )
  elseif is_ydoc_adapter(doc.adapter_kind) then
    local request = { document_id = doc.document_id, operations = {} }
    for _, block in ipairs(changed) do
      table.insert(request.operations, {
        type = "replace-block-text",
        block_id = block.block_id,
        text = block.text,
      })
    end
    projection = apply_ydoc_request(doc, request, opts)
  else
    local document = vim.json.decode(read_file(doc.path))

    for _, block in ipairs(document.blocks or {}) do
      if by_id[block.block_id] ~= nil then
        block.text = by_id[block.block_id]
      end
    end

    write_file(doc.path, vim.json.encode(document))
  end

  if projection and not adopt_projection_if_buffer_matches(doc, projection, bufnr) then
    doc.projection = projection
  end
  for _, block in ipairs(doc.blocks) do
    block.original_text = by_id[block.block_id]
  end
  vim.b[bufnr].vehicle_garden_document = doc
  vim.bo[bufnr].modified = false
  render_document(bufnr, doc)
  if not opts.quiet then
    vim.notify("VehicleGardenSave wrote " .. tostring(changed_count) .. " changed blocks")
  end
  return projection
end

function M.sync()
  local doc = current_doc()
  if doc.adapter_kind ~= "bridge-ydoc-room" and doc.adapter_kind ~= "live-ydoc-room" then
    error("VehicleGardenSync requires adapter.kind='bridge-ydoc-room' or 'live-ydoc-room'")
  end
  if #M.changed_blocks() > 0 then
    error("refusing to sync over unsaved local edits")
  end
  local projection
  if doc.adapter_kind == "live-ydoc-room" then
    projection = live_request("sync", {})
  else
    projection = run_bridge(add_room_auth_args({
      "bridge",
      "sync-ydoc-once",
      "--path",
      doc.path,
      "--url",
      room_url(doc.document_id),
      "--document-id",
      doc.document_id,
    }))
  end
  refresh_from_projection(doc, projection)
  vim.notify("VehicleGardenSync refreshed " .. doc.document_id)
end

local function trim(value)
  return tostring(value or ""):gsub("^%s+", ""):gsub("%s+$", "")
end

local function annotation_text(value)
  if value == nil or value == vim.NIL then
    return ""
  end
  return tostring(value)
end

local function document_bufnr_or_current(document_bufnr)
  local bufnr = document_bufnr or vim.api.nvim_get_current_buf()
  if not vim.api.nvim_buf_is_valid(bufnr) then
    error("the Garden document buffer is no longer valid")
  end
  local doc = vim.b[bufnr].vehicle_garden_document
  if type(doc) ~= "table" then
    error("this operation requires a Garden document buffer")
  end
  return bufnr, doc
end

local function apply_document_operations(document_bufnr, operations)
  local bufnr = document_bufnr_or_current(document_bufnr)
  return vim.api.nvim_buf_call(bufnr, function()
    local doc = current_doc()
    require_structural_adapter(doc)
    doc = flush_local_changes(doc)
    local projection = apply_ydoc_request(doc, {
      document_id = doc.document_id,
      operations = operations,
    }, { skip_sync = true })
    if not adopt_projection_if_buffer_matches(doc, projection, bufnr) then
      refresh_from_projection(doc, projection, bufnr)
    end
    return projection
  end)
end

local function prompt_for_annotation(document_bufnr, prompt, default, callback)
  vim.ui.input({ prompt = prompt, default = default }, function(value)
    value = value and trim(value) or ""
    if value == "" then
      return
    end
    local ok, err = pcall(vim.api.nvim_buf_call, document_bufnr, function()
      callback(value)
    end)
    if not ok then
      vim.notify("VehicleGarden annotation failed: " .. tostring(err), vim.log.levels.ERROR)
    end
  end)
end

local function next_utf8_byte(text, byte_col)
  if byte_col >= #text then
    return #text
  end
  local first = string.byte(text, byte_col + 1) or 0
  local width = first < 0x80 and 1 or (first < 0xE0 and 2 or (first < 0xF0 and 3 or 4))
  return math.min(#text, byte_col + width)
end

local function comment_target(document_bufnr, selection)
  local doc = vim.b[document_bufnr].vehicle_garden_document
  local winid = vim.fn.bufwinid(document_bufnr)
  if winid == -1 then
    error("the Garden document must be visible to add a comment")
  end
  local cursor = vim.api.nvim_win_get_cursor(winid)
  local line = cursor[1]
  if selection and selection.explicit then
    if selection.line1 ~= selection.line2 then
      error("inline comments currently require a selection within one Garden block")
    end
    line = selection.line1
  end
  local block = block_at_line(doc, document_bufnr, line)
  if not block then
    error("the selected line has no Garden block")
  end
  if not selection or not selection.explicit then
    return { block_id = block.block_id }
  end

  local text = vim.api.nvim_buf_get_lines(document_bufnr, line - 1, line, false)[1] or ""
  local start_byte = 0
  local end_byte = #text
  local start_mark = vim.fn.getpos("'<")
  local end_mark = vim.fn.getpos("'>")
  if start_mark[2] == line and end_mark[2] == line and vim.fn.visualmode() ~= "V" then
    start_byte = math.max(0, math.min((start_mark[3] or 1) - 1, #text))
    local end_start = math.max(0, math.min((end_mark[3] or 1) - 1, #text))
    if start_byte > end_start then
      start_byte, end_start = end_start, start_byte
    end
    end_byte = next_utf8_byte(text, end_start)
  end
  local offset_utf16 = utf16_offset_for_byte(text, start_byte)
  local end_utf16 = utf16_offset_for_byte(text, end_byte)
  if end_utf16 <= offset_utf16 then
    error("inline comments require a non-empty text selection")
  end
  return {
    block_id = block.block_id,
    offset_utf16 = offset_utf16,
    len_utf16 = end_utf16 - offset_utf16,
  }
end

local function new_comment_id()
  local now = tostring(os.time() * 1000)
  local seed = table.concat({ now, tostring(vim.uv.hrtime()), tostring(math.random()) }, ":")
  return "comment-" .. now .. "-" .. vim.fn.sha256(seed):sub(1, 9)
end

function M.comment(text, selection, document_bufnr)
  local bufnr = document_bufnr_or_current(document_bufnr)
  local target = vim.api.nvim_buf_call(bufnr, function()
    return comment_target(bufnr, selection)
  end)
  local function create(value)
    local user = presence_user()
    local operation = {
      type = target.len_utf16 and "create-inline-comment" or "create-block-comment",
      comment_id = new_comment_id(),
      block_id = target.block_id,
      text = value,
      author = user.name,
      author_id = user.userId,
    }
    if target.len_utf16 then
      operation.offset_utf16 = target.offset_utf16
      operation.len_utf16 = target.len_utf16
    end
    apply_document_operations(bufnr, { operation })
    vim.notify("VehicleGarden added a comment")
    return operation.comment_id
  end
  text = trim(text)
  if text == "" then
    prompt_for_annotation(bufnr, "Comment: ", "", create)
    return nil
  end
  return create(text)
end

local function comment_by_id(doc, comment_id)
  for _, comment in ipairs(doc.comments or {}) do
    if comment.comment_id == comment_id then
      return comment
    end
  end
  return nil
end

local function nearest_comment(document_bufnr, comment_id)
  local doc = vim.b[document_bufnr].vehicle_garden_document
  if comment_id then
    return comment_by_id(doc, comment_id)
      or error("Garden comment " .. tostring(comment_id) .. " was not found")
  end
  local winid = vim.fn.bufwinid(document_bufnr)
  if winid == -1 then
    error("the Garden document must be visible")
  end
  local cursor = vim.api.nvim_win_get_cursor(winid)
  local block = block_at_line(doc, document_bufnr, cursor[1])
  if not block then
    error("the current line has no Garden block")
  end
  local text = vim.api.nvim_buf_get_lines(document_bufnr, cursor[1] - 1, cursor[1], false)[1] or ""
  local offset = utf16_offset_for_byte(text, cursor[2])
  local block_fallback
  local closest
  local closest_distance
  for _, comment in ipairs(doc.comments or {}) do
    if comment.block_id == block.block_id then
      local start_offset = tonumber(comment.start_utf16)
      local end_offset = tonumber(comment.end_utf16)
      if start_offset and end_offset and offset >= start_offset and offset <= end_offset then
        return comment
      elseif start_offset then
        local distance = math.abs(offset - start_offset)
        if not closest_distance or distance < closest_distance then
          closest = comment
          closest_distance = distance
        end
      else
        block_fallback = block_fallback or comment
      end
    end
  end
  return closest or block_fallback or error("there is no comment on the current Garden block")
end

function M.edit_comment(text, comment_id, document_bufnr)
  local bufnr, doc = document_bufnr_or_current(document_bufnr)
  local comment = nearest_comment(bufnr, comment_id)
  local current = type(comment.data) == "table" and annotation_text(comment.data.text) or ""
  local function update(value)
    apply_document_operations(bufnr, {
      { type = "update-comment", comment_id = comment.comment_id, text = value },
    })
    vim.notify("VehicleGarden updated the comment")
  end
  text = trim(text)
  if text == "" then
    prompt_for_annotation(bufnr, "Edit comment: ", current, update)
    return nil
  end
  update(text)
  return comment.comment_id, doc
end

function M.resolve_comment(comment_id, resolved, document_bufnr)
  local bufnr = document_bufnr_or_current(document_bufnr)
  local comment = nearest_comment(bufnr, comment_id)
  local data = type(comment.data) == "table" and comment.data or {}
  if resolved == nil then
    resolved = data.resolved ~= true
  end
  apply_document_operations(bufnr, {
    { type = "update-comment", comment_id = comment.comment_id, resolved = resolved },
  })
  vim.notify("VehicleGarden " .. (resolved and "resolved" or "reopened") .. " the comment")
  return resolved
end

function M.delete_comment(comment_id, document_bufnr, confirm)
  local bufnr = document_bufnr_or_current(document_bufnr)
  local comment = nearest_comment(bufnr, comment_id)
  if confirm ~= false then
    local choice = vim.fn.confirm("Delete this Garden comment?", "&Delete\n&Cancel", 2)
    if choice ~= 1 then
      return false
    end
  end
  apply_document_operations(bufnr, {
    { type = "delete-comment", comment_id = comment.comment_id },
  })
  vim.notify("VehicleGarden deleted the comment")
  return true
end

local function comments_in_document_order(doc)
  local block_order = {}
  for index, block in ipairs(doc.blocks or {}) do
    block_order[block.block_id] = index
  end
  local comments = vim.deepcopy(doc.comments or {})
  table.sort(comments, function(left, right)
    local left_block = block_order[left.block_id] or math.huge
    local right_block = block_order[right.block_id] or math.huge
    if left_block ~= right_block then
      return left_block < right_block
    end
    local left_offset = tonumber(left.start_utf16) or -1
    local right_offset = tonumber(right.start_utf16) or -1
    if left_offset ~= right_offset then
      return left_offset < right_offset
    end
    return tostring(left.comment_id) < tostring(right.comment_id)
  end)
  return comments
end

function M.comments()
  local bufnr, doc = document_bufnr_or_current()
  local items = {}
  for _, comment in ipairs(comments_in_document_order(doc)) do
    local lnum = line_for_block(doc, bufnr, comment.block_id)
    if lnum then
      local line = vim.api.nvim_buf_get_lines(bufnr, lnum - 1, lnum, false)[1] or ""
      local col = byte_index_for_utf16(line, tonumber(comment.start_utf16) or 0) + 1
      local data = type(comment.data) == "table" and comment.data or {}
      local status = data.resolved == true and "resolved" or "open"
      local body = annotation_text(data.text)
      local author = annotation_text(data.author)
      table.insert(items, {
        bufnr = bufnr,
        lnum = lnum,
        col = col,
        text = string.format("[%s] %s%s", status, author ~= "" and (author .. ": ") or "", body),
        user_data = { kind = "comment", comment_id = comment.comment_id },
      })
    end
  end
  vim.fn.setloclist(0, {}, " ", { title = "Garden comments: " .. doc.document_id, items = items })
  if #items == 0 then
    vim.notify("VehicleGarden found no comments")
    return items
  end
  vim.cmd("lopen")
  return items
end

local function current_footnote(document_bufnr, block_id, atom_index)
  local doc = vim.b[document_bufnr].vehicle_garden_document
  local block
  if block_id then
    for _, candidate in ipairs(doc.blocks or {}) do
      if candidate.block_id == block_id then
        block = candidate
        break
      end
    end
  else
    local winid = vim.fn.bufwinid(document_bufnr)
    if winid == -1 then
      error("the Garden document must be visible")
    end
    block = block_at_line(doc, document_bufnr, vim.api.nvim_win_get_cursor(winid)[1])
  end
  if not block then
    error("the Garden footnote block was not found")
  end
  local footnotes = {}
  for _, atom in ipairs(block.inline_atoms or {}) do
    if atom.atom_type == "footnote" then
      table.insert(footnotes, atom)
    end
  end
  if atom_index ~= nil then
    for _, atom in ipairs(footnotes) do
      if tonumber(atom.atom_index) == tonumber(atom_index) then
        return block, atom
      end
    end
    error("Garden footnote " .. tostring(atom_index) .. " was not found")
  end
  if #footnotes == 0 then
    error("there is no footnote on the current Garden block")
  end
  local line = line_for_block(doc, document_bufnr, block.block_id)
  local winid = vim.fn.bufwinid(document_bufnr)
  local cursor = vim.api.nvim_win_get_cursor(winid)
  local text = vim.api.nvim_buf_get_lines(document_bufnr, line - 1, line, false)[1] or ""
  local offset = utf16_offset_for_byte(text, cursor[2])
  local closest = footnotes[1]
  local distance = math.abs(offset - (tonumber(closest.offset_utf16) or 0))
  for index = 2, #footnotes do
    local candidate_distance = math.abs(offset - (tonumber(footnotes[index].offset_utf16) or 0))
    if candidate_distance < distance then
      closest = footnotes[index]
      distance = candidate_distance
    end
  end
  return block, closest
end

function M.footnote(content, document_bufnr)
  local bufnr, doc = document_bufnr_or_current(document_bufnr)
  local winid = vim.fn.bufwinid(bufnr)
  if winid == -1 then
    error("the Garden document must be visible to add a footnote")
  end
  local cursor = vim.api.nvim_win_get_cursor(winid)
  local block = block_at_line(doc, bufnr, cursor[1])
  if not block or block.support ~= "editable-text" then
    error("the current Garden block cannot contain a footnote")
  end
  local line = vim.api.nvim_buf_get_lines(bufnr, cursor[1] - 1, cursor[1], false)[1] or ""
  local offset_utf16 = utf16_offset_for_byte(line, cursor[2])
  local function create(value)
    apply_document_operations(bufnr, {
      {
        type = "insert-footnote",
        block_id = block.block_id,
        offset_utf16 = offset_utf16,
        content = value,
      },
    })
    vim.notify("VehicleGarden added a footnote")
  end
  content = trim(content)
  if content == "" then
    prompt_for_annotation(bufnr, "Footnote: ", "", create)
    return nil
  end
  create(content)
  return true
end

function M.edit_footnote(content, block_id, atom_index, document_bufnr)
  local bufnr = document_bufnr_or_current(document_bufnr)
  local block, atom = current_footnote(bufnr, block_id, atom_index)
  local attrs = type(atom.attrs) == "table" and atom.attrs or {}
  local current = annotation_text(attrs.content)
  local function update(value)
    apply_document_operations(bufnr, {
      {
        type = "update-footnote",
        block_id = block.block_id,
        atom_index = tonumber(atom.atom_index) or 0,
        content = value,
      },
    })
    vim.notify("VehicleGarden updated the footnote")
  end
  content = trim(content)
  if content == "" then
    prompt_for_annotation(bufnr, "Edit footnote: ", current, update)
    return nil
  end
  update(content)
  return true
end

function M.delete_footnote(block_id, atom_index, document_bufnr, confirm)
  local bufnr = document_bufnr_or_current(document_bufnr)
  local block, atom = current_footnote(bufnr, block_id, atom_index)
  if confirm ~= false then
    local choice = vim.fn.confirm("Delete this Garden footnote?", "&Delete\n&Cancel", 2)
    if choice ~= 1 then
      return false
    end
  end
  apply_document_operations(bufnr, {
    {
      type = "delete-footnote",
      block_id = block.block_id,
      atom_index = tonumber(atom.atom_index) or 0,
    },
  })
  vim.notify("VehicleGarden deleted the footnote")
  return true
end

local function numbered_footnotes(doc)
  local result = {}
  local number = 0
  for _, block in ipairs(doc.blocks or {}) do
    for _, atom in ipairs(block.inline_atoms or {}) do
      if atom.atom_type == "footnote" then
        number = number + 1
        table.insert(result, { number = number, block = block, atom = atom })
      end
    end
  end
  return result
end

function M.footnotes()
  local bufnr, doc = document_bufnr_or_current()
  local items = {}
  for _, entry in ipairs(numbered_footnotes(doc)) do
    local lnum = line_for_block(doc, bufnr, entry.block.block_id)
    if lnum then
      local line = vim.api.nvim_buf_get_lines(bufnr, lnum - 1, lnum, false)[1] or ""
      local col = byte_index_for_utf16(line, tonumber(entry.atom.offset_utf16) or 0) + 1
      local attrs = type(entry.atom.attrs) == "table" and entry.atom.attrs or {}
      table.insert(items, {
        bufnr = bufnr,
        lnum = lnum,
        col = col,
        text = string.format("[%d] %s", entry.number, annotation_text(attrs.content)),
        user_data = {
          kind = "footnote",
          block_id = entry.block.block_id,
          atom_index = entry.atom.atom_index,
        },
      })
    end
  end
  vim.fn.setloclist(0, {}, " ", { title = "Garden footnotes: " .. doc.document_id, items = items })
  if #items == 0 then
    vim.notify("VehicleGarden found no footnotes")
    return items
  end
  vim.cmd("lopen")
  return items
end

local function tree_glyph(block)
  if block.kind == "heading" then
    return "#", "VehicleGardenTreeHeading"
  elseif block.kind == "blockquote" then
    return "│", "VehicleGardenTreeQuote"
  elseif block.kind == "listItem" then
    local list_type = block.attrs and (block.attrs.listType or block.attrs["data-list-type"])
    return list_type == "ordered" and "1." or (list_type == "task" and "☐" or "•"), "VehicleGardenTreeList"
  elseif block.kind == "codeBlock" then
    return "{}", "VehicleGardenTreeCode"
  end
  return "·", "VehicleGardenTreeDim"
end

local function tree_record_for_buffer(bufnr)
  local tree_doc_id = vim.b[bufnr].vehicle_garden_tree_document_id
  if tree_doc_id then
    return state.trees[tree_doc_id]
  end
  local doc = vim.b[bufnr].vehicle_garden_document
  if type(doc) == "table" then
    return state.trees[doc.document_id]
  end
  return nil
end

local function tree_item_key(item)
  if not item then
    return nil
  elseif item.kind == "comment" then
    return "comment:" .. tostring(item.comment_id)
  elseif item.kind == "footnote" then
    return "footnote:" .. tostring(item.block_id) .. ":" .. tostring(item.atom_index)
  elseif item.kind == "block" then
    return "block:" .. tostring(item.block_id)
  end
  return tostring(item.kind)
end

refresh_tree_for_document = function(document_bufnr)
  if not vim.api.nvim_buf_is_valid(document_bufnr) then
    return
  end
  local doc = vim.b[document_bufnr].vehicle_garden_document
  if type(doc) ~= "table" then
    return
  end
  local record = state.trees[doc.document_id]
  if not record or not vim.api.nvim_buf_is_valid(record.bufnr) then
    return
  end

  local previous_item
  if vim.api.nvim_win_is_valid(record.winid) then
    local cursor_line = vim.api.nvim_win_get_cursor(record.winid)[1]
    previous_item = (vim.b[record.bufnr].vehicle_garden_tree_items or {})[cursor_line]
  end

  local lines = { "▾ " .. tostring(doc.title or doc.document_id) }
  local items = { { kind = "document", document_bufnr = document_bufnr } }
  local highlights = { "VehicleGardenTreeTitle" }
  local comments_by_block = {}
  for _, comment in ipairs(comments_in_document_order(doc)) do
    if comment.block_id and comment.block_id ~= vim.NIL then
      comments_by_block[comment.block_id] = comments_by_block[comment.block_id] or {}
      table.insert(comments_by_block[comment.block_id], comment)
    end
  end
  local footnote_numbers = {}
  for _, entry in ipairs(numbered_footnotes(doc)) do
    local key = tostring(entry.block.block_id) .. ":" .. tostring(entry.atom.atom_index)
    footnote_numbers[key] = entry.number
  end
  for _, block in ipairs(doc.blocks or {}) do
    local indent = math.max(0, math.min(6, numeric_attr(block.attrs, "indent", 0)))
    local glyph, highlight = tree_glyph(block)
    local text = (block.original_text or ""):gsub("%s+", " "):gsub("^%s+", ""):gsub("%s+$", "")
    if text == "" then
      text = "[empty " .. tostring(block.kind) .. "]"
    end
    table.insert(lines, string.rep("  ", indent + 1) .. glyph .. " " .. text)
    table.insert(items, {
      kind = "block",
      block_id = block.block_id,
      document_bufnr = document_bufnr,
    })
    table.insert(highlights, highlight)

    for _, comment in ipairs(comments_by_block[block.block_id] or {}) do
      local data = type(comment.data) == "table" and comment.data or {}
      local resolved = data.resolved == true
      local body = annotation_text(data.text)
      if body == "" then
        body = annotation_text(data.quotedText)
      end
      body = body:gsub("%s+", " ")
      local author = annotation_text(data.author)
      local label = (resolved and "✓ " or "💬 ") .. (author ~= "" and (author .. ": ") or "") .. body
      table.insert(lines, string.rep("  ", indent + 2) .. label)
      table.insert(items, {
        kind = "comment",
        comment_id = comment.comment_id,
        block_id = block.block_id,
        offset_utf16 = tonumber(comment.start_utf16) or 0,
        document_bufnr = document_bufnr,
      })
      table.insert(highlights, resolved and "VehicleGardenTreeDim" or "VehicleGardenTreeComment")
    end

    for _, atom in ipairs(block.inline_atoms or {}) do
      if atom.atom_type == "footnote" then
        local attrs = type(atom.attrs) == "table" and atom.attrs or {}
        local key = tostring(block.block_id) .. ":" .. tostring(atom.atom_index)
        local number = footnote_numbers[key] or "?"
        local body = annotation_text(attrs.content):gsub("%s+", " ")
        table.insert(lines, string.rep("  ", indent + 2) .. "[" .. tostring(number) .. "] " .. body)
        table.insert(items, {
          kind = "footnote",
          block_id = block.block_id,
          atom_index = atom.atom_index,
          offset_utf16 = tonumber(atom.offset_utf16) or 0,
          document_bufnr = document_bufnr,
        })
        table.insert(highlights, "VehicleGardenTreeFootnote")
      end
    end
  end

  vim.bo[record.bufnr].modifiable = true
  vim.api.nvim_buf_set_lines(record.bufnr, 0, -1, false, lines)
  vim.bo[record.bufnr].modifiable = false
  vim.b[record.bufnr].vehicle_garden_tree_items = items
  vim.api.nvim_buf_clear_namespace(record.bufnr, state.tree_ns, 0, -1)
  for index, highlight in ipairs(highlights) do
    local line = lines[index] or ""
    if #line > 0 then
      vim.api.nvim_buf_set_extmark(record.bufnr, state.tree_ns, index - 1, 0, {
        end_col = #line,
        hl_group = highlight,
      })
    end
  end

  if previous_item and vim.api.nvim_win_is_valid(record.winid) then
    local previous_key = tree_item_key(previous_item)
    for line, item in ipairs(items) do
      if tree_item_key(item) == previous_key then
        pcall(vim.api.nvim_win_set_cursor, record.winid, { line, 0 })
        break
      end
    end
  end
end

sync_tree_cursor = function(document_bufnr)
  local doc = vim.b[document_bufnr].vehicle_garden_document
  if type(doc) ~= "table" then
    return
  end
  local record = state.trees[doc.document_id]
  if not record or not vim.api.nvim_win_is_valid(record.winid) or not vim.api.nvim_buf_is_valid(record.bufnr) then
    return
  end
  local document_win = vim.fn.bufwinid(document_bufnr)
  if document_win == -1 then
    return
  end
  local block = block_at_line(doc, document_bufnr, vim.api.nvim_win_get_cursor(document_win)[1])
  if not block then
    return
  end
  for line, item in ipairs(vim.b[record.bufnr].vehicle_garden_tree_items or {}) do
    if item.block_id == block.block_id then
      pcall(vim.api.nvim_win_set_cursor, record.winid, { line, 0 })
      return
    end
  end
end

function M.tree_activate()
  local tree_bufnr = vim.api.nvim_get_current_buf()
  local record = tree_record_for_buffer(tree_bufnr)
  if not record then
    return
  end
  local line = vim.api.nvim_win_get_cursor(0)[1]
  local item = (vim.b[tree_bufnr].vehicle_garden_tree_items or {})[line]
  if not item or not vim.api.nvim_buf_is_valid(item.document_bufnr) then
    return
  end
  local document_win = vim.fn.bufwinid(item.document_bufnr)
  if document_win == -1 then
    vim.cmd("rightbelow vsplit")
    document_win = vim.api.nvim_get_current_win()
    vim.api.nvim_win_set_buf(document_win, item.document_bufnr)
  else
    vim.api.nvim_set_current_win(document_win)
  end
  if item.block_id then
    local doc = vim.b[item.document_bufnr].vehicle_garden_document
    local target_line = line_for_block(doc, item.document_bufnr, item.block_id)
    if target_line then
      local text = vim.api.nvim_buf_get_lines(item.document_bufnr, target_line - 1, target_line, false)[1] or ""
      local col = byte_index_for_utf16(text, tonumber(item.offset_utf16) or 0)
      vim.api.nvim_win_set_cursor(document_win, { target_line, col })
      vim.cmd("normal! zz")
    end
  end
end

local function current_tree_item()
  local tree_bufnr = vim.api.nvim_get_current_buf()
  local line = vim.api.nvim_win_get_cursor(0)[1]
  return (vim.b[tree_bufnr].vehicle_garden_tree_items or {})[line]
end

function M.tree_edit()
  local item = current_tree_item()
  if not item then
    return
  elseif item.kind == "comment" then
    return M.edit_comment(nil, item.comment_id, item.document_bufnr)
  elseif item.kind == "footnote" then
    return M.edit_footnote(nil, item.block_id, item.atom_index, item.document_bufnr)
  end
  vim.notify("VehicleGarden tree item has nothing to edit")
end

function M.tree_toggle_comment()
  local item = current_tree_item()
  if not item or item.kind ~= "comment" then
    vim.notify("VehicleGarden tree item is not a comment")
    return
  end
  return M.resolve_comment(item.comment_id, nil, item.document_bufnr)
end

function M.tree_delete()
  local item = current_tree_item()
  if not item then
    return
  elseif item.kind == "comment" then
    return M.delete_comment(item.comment_id, item.document_bufnr)
  elseif item.kind == "footnote" then
    return M.delete_footnote(item.block_id, item.atom_index, item.document_bufnr)
  end
  vim.notify("VehicleGarden tree item cannot be deleted")
end

function M.tree_close()
  local record = tree_record_for_buffer(vim.api.nvim_get_current_buf())
  if record and vim.api.nvim_win_is_valid(record.winid) then
    vim.api.nvim_win_close(record.winid, true)
  end
end

function M.tree()
  local current_bufnr = vim.api.nvim_get_current_buf()
  local doc = vim.b[current_bufnr].vehicle_garden_document
  if type(doc) ~= "table" then
    local existing = tree_record_for_buffer(current_bufnr)
    if existing and vim.api.nvim_win_is_valid(existing.winid) then
      M.tree_close()
      return
    end
    error("VehicleGardenTree requires a Garden document buffer")
  end

  local existing = state.trees[doc.document_id]
  if existing and vim.api.nvim_win_is_valid(existing.winid) then
    vim.api.nvim_set_current_win(existing.winid)
    return
  end

  local document_bufnr = current_bufnr
  local width = math.max(24, tonumber(state.adapter.tree_width) or 38)
  vim.cmd("topleft " .. tostring(width) .. "vnew")
  local tree_winid = vim.api.nvim_get_current_win()
  local tree_bufnr = vim.api.nvim_get_current_buf()
  vim.api.nvim_buf_set_name(tree_bufnr, "vehicle-tree://" .. doc.document_id)
  vim.bo[tree_bufnr].buftype = "nofile"
  vim.bo[tree_bufnr].bufhidden = "wipe"
  vim.bo[tree_bufnr].swapfile = false
  vim.bo[tree_bufnr].modifiable = false
  vim.bo[tree_bufnr].filetype = "vehicle-garden-tree"
  vim.wo[tree_winid].number = false
  vim.wo[tree_winid].relativenumber = false
  vim.wo[tree_winid].signcolumn = "no"
  vim.wo[tree_winid].foldcolumn = "0"
  vim.wo[tree_winid].cursorline = true
  vim.wo[tree_winid].winfixwidth = true
  vim.wo[tree_winid].wrap = false
  vim.b[tree_bufnr].vehicle_garden_tree_document_id = doc.document_id
  state.trees[doc.document_id] = {
    bufnr = tree_bufnr,
    winid = tree_winid,
    document_bufnr = document_bufnr,
  }
  vim.keymap.set("n", "<CR>", M.tree_activate, { buffer = tree_bufnr, desc = "Open Garden tree item" })
  vim.keymap.set("n", "o", M.tree_activate, { buffer = tree_bufnr, desc = "Open Garden tree item" })
  vim.keymap.set("n", "l", M.tree_activate, { buffer = tree_bufnr, desc = "Open Garden tree item" })
  vim.keymap.set("n", "e", M.tree_edit, { buffer = tree_bufnr, desc = "Edit Garden comment or footnote" })
  vim.keymap.set("n", "R", M.tree_toggle_comment, { buffer = tree_bufnr, desc = "Resolve or reopen Garden comment" })
  vim.keymap.set("n", "x", M.tree_delete, { buffer = tree_bufnr, desc = "Delete Garden comment or footnote" })
  vim.keymap.set("n", "q", M.tree_close, { buffer = tree_bufnr, desc = "Close Garden tree" })
  vim.keymap.set("n", "h", M.tree_close, { buffer = tree_bufnr, desc = "Close Garden tree" })
  vim.keymap.set("n", "r", function()
    refresh_tree_for_document(document_bufnr)
  end, { buffer = tree_bufnr, desc = "Refresh Garden tree" })
  vim.api.nvim_create_autocmd("BufWipeout", {
    buffer = tree_bufnr,
    once = true,
    callback = function()
      if state.trees[doc.document_id] and state.trees[doc.document_id].bufnr == tree_bufnr then
        state.trees[doc.document_id] = nil
      end
    end,
  })
  refresh_tree_for_document(document_bufnr)
end

function M.stop_bridge()
  stop_live_bridge()
end

function M.status()
  local doc = current_doc()
  local changed = M.changed_blocks()
  local message = string.format(
    "vehicle.nvim doc=%s title=%s adapter=%s changed_blocks=%d",
    doc.document_id,
    doc.title,
    state.adapter.kind,
    #changed
  )
  print(message)
  return message
end

function M.adapter_root()
  return state.adapter.root
end

function M.presence()
  return state.live.awareness
end

return M
