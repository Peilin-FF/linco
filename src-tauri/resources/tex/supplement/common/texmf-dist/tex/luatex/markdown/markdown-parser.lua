--
-- Copyright (C) 2009-2016 John MacFarlane, Hans Hagen
--
-- Permission is hereby granted, free of charge, to any person obtaining
-- a copy of this software and associated documentation files (the
-- "Software"), to deal in the Software without restriction, including
-- without limitation the rights to use, copy, modify, merge, publish,
-- distribute, sublicense, and/or sell copies of the Software, and to
-- permit persons to whom the Software is furnished to do so, subject to
-- the following conditions:
--
-- The above copyright notice and this permission notice shall be
-- included in all copies or substantial portions of the Software.
--
-- THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
-- EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
-- MERCHANTABILITY, FITNESS FOR PARTICULAR PURPOSE AND NONINFRINGEMENT.
-- IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
-- CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
-- TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
-- SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
--
-- Copyright (C) 2016-2026 Vít Starý Novotný, Andrej Genčur
--
-- This work may be distributed and/or modified under the
-- conditions of the LaTeX Project Public License, either version 1.3
-- of this license or (at your option) any later version.
-- The latest version of this license is in
--
--     http://www.latex-project.org/lppl.txt
--
-- and version 1.3 or later is part of all distributions of LaTeX
-- version 2005/12/01 or later.
--
-- This work has the LPPL maintenance status `maintained'.
-- The Current Maintainer of this work is Vít Starý Novotný.
--
-- Send bug reports, requests for additions and questions
-- either to the GitHub issue tracker at
--
--     https://github.com/witiko/markdown/issues
--
-- or to the e-mail address <witiko@mail.muni.cz>.
--
-- MODIFICATION ADVICE:
--
-- If you want to customize this file, it is best to make a copy of
-- the source file(s) from which it was produced. Use a different
-- name for your copy(ies) and modify the copy(ies); this will ensure
-- that your modifications do not get overwritten when you install a
-- new release of the standard system. You should also ensure that
-- your modified source file does not generate any modified file with
-- the same name as a standard file.
--
-- You will also need to produce your own, suitably named, .ins file to
-- control the generation of files from your source file; this file
-- should contain your own preambles for the files it generates, not
-- those in the standard .ins files.
--
local metadata = {
    version   = "3.16.0-0-g4d0fb773",
    comment   = "A module for the conversion from markdown "
             .. "to plain TeX",
    author    = "John MacFarlane, Hans Hagen, Vít Starý Novotný, "
             .. "Andrej Genčur",
    copyright = {"2009-2016 John MacFarlane, Hans Hagen",
                 "2016-2026 Vít Starý Novotný, Andrej Genčur"},
    license   = "LPPL 1.3c"
}

if not modules then modules = { } end
modules['markdown'] = metadata
local lpeg = require("lpeg")
local md5 = require("md5")
if resolvers == nil then
  (function()
    local should_initialize = package.loaded.kpse == nil
                         or tex.initialize ~= nil
    kpse = require("kpse")
    if should_initialize then
      kpse.set_program_name("luatex")
    end
  end)()
end
local M = {metadata = metadata}
local walkable_syntax = {
  Block = {
    "Blockquote",
    "Verbatim",
    "ThematicBreak",
    "BulletList",
    "OrderedList",
    "DisplayHtml",
    "Heading",
  },
  BlockOrParagraph = {
    "Block",
    "Paragraph",
    "Plain",
  },
  Inline = {
    "Str",
    "Space",
    "Endline",
    "EndlineBreak",
    "LinkAndEmph",
    "Code",
    "AutoLinkUrl",
    "AutoLinkEmail",
    "AutoLinkRelativeReference",
    "InlineHtml",
    "HtmlEntity",
    "EscapedChar",
    "Smart",
    "Symbol",
  },
}
local defaultOptions = {}
local experimentalOptions = {}
setmetatable(experimentalOptions, { __index = function (_, key)
  return defaultOptions[key] end })
defaultOptions.eagerCache = true
defaultOptions.experimental = false
defaultOptions.singletonCache = true
local singletonCache = {
  convert = nil,
  options = nil,
}
defaultOptions.unicodeNormalization = true
defaultOptions.unicodeNormalizationForm = "nfc"
defaultOptions.cacheDir = "."
defaultOptions.contentBlocksLanguageMap = "markdown-languages.json"
defaultOptions.debugExtensionsFileName = "debug-extensions.json"
defaultOptions.frozenCacheFileName = "frozenCache.tex"
defaultOptions.acronyms = {}
defaultOptions.autoIdentifiers = false
defaultOptions.blankBeforeBlockquote = false
defaultOptions.blankBeforeCodeFence = false
defaultOptions.blankBeforeDivFence = false
defaultOptions.blankBeforeHeading = false
defaultOptions.blankBeforeHtmlBlock = false
defaultOptions.blankBeforeList = false
defaultOptions.bracketedSpans = false
defaultOptions.breakableBlockquotes = true
defaultOptions.citationNbsps = true
defaultOptions.citations = false
defaultOptions.codeSpans = true
defaultOptions.contentBlocks = false
defaultOptions.contentLevel = "block"
defaultOptions.debugExtensions = false
defaultOptions.definitionLists = false
defaultOptions.ensureJekyllData = false
defaultOptions.expectJekyllData = false
metadata.user_extension_api_version = 2
metadata.grammar_version = 4
defaultOptions.extensions = {}
defaultOptions.fancyLists = false
defaultOptions.fencedCode = true
defaultOptions.fencedCodeAttributes = false
defaultOptions.fencedDivs = false
defaultOptions.finalizeCache = false
defaultOptions.frozenCacheCounter = 0
defaultOptions.gfmAutoIdentifiers = false
defaultOptions.hashEnumerators = false
defaultOptions.headerAttributes = false
defaultOptions.html = true
defaultOptions.htmlOutput = "basic"
defaultOptions.htmlOverLinks = false
experimentalOptions.htmlOverLinks = true
defaultOptions.hybrid = false
defaultOptions.inlineCodeAttributes = false
defaultOptions.inlineNotes = false
defaultOptions.jekyllData = false
defaultOptions.linkAttributes = false
defaultOptions.lineBlocks = false
defaultOptions.mark = false
defaultOptions.notes = false
defaultOptions.pipeTables = false
defaultOptions.preserveTabs = true
defaultOptions.rawAttribute = false
defaultOptions.relativeReferences = false
defaultOptions.shiftHeadings = 0
defaultOptions.slice = "^ $"
defaultOptions.smartEllipses = false
defaultOptions.startNumber = true
defaultOptions.strikeThrough = false
defaultOptions.stripIndent = false
defaultOptions.subscripts = false
defaultOptions.superscripts = false
defaultOptions.tableAttributes = false
defaultOptions.tableCaptions = false
defaultOptions.taskLists = false
defaultOptions.texComments = false
defaultOptions.texMathDollars = false
defaultOptions.texMathDoubleBackslash = false
defaultOptions.texMathSingleBackslash = false
defaultOptions.tightLists = true
defaultOptions.underscores = true
local upper, format, length =
  string.upper, string.format, string.len
local P, R, S, V, C, Cg, Cb, Cmt, Cc, Ct, B, Cs, Cp, any =
  lpeg.P, lpeg.R, lpeg.S, lpeg.V, lpeg.C, lpeg.Cg, lpeg.Cb,
  lpeg.Cmt, lpeg.Cc, lpeg.Ct, lpeg.B, lpeg.Cs, lpeg.Cp, lpeg.P(1)
local early_warnings = {}
local unicode_data = require("markdown-unicode-data")
if metadata.version ~= unicode_data.metadata.version then
  table.insert(
    early_warnings,
    "markdown.lua " .. metadata.version .. " used with " ..
    "markdown-unicode-data.lua " .. unicode_data.metadata.version .. "."
  )
end
local function depth_first_search(node, path, visit, leave)
  assert(node._type == "intermediate")
  visit(node, path)
  for label, child in pairs(node) do
    if label == "_type" then
      goto continue
    end
    if child._type ~= "intermediate" then
      goto continue
    end
    depth_first_search(child, path .. label, visit, leave)
    ::continue::
  end
  for label, child in pairs(node) do
    if label == "_type" then
      goto continue
    end
    if child._type ~= "leaf" then
      goto continue
    end
    visit(child, path)
    ::continue::
  end
  leave(node, path)
end
local util = {}
function util.err(msg, exit_code)
  io.stderr:write("markdown.lua: " .. msg .. "\n")
  os.exit(exit_code or 1)
end
function util.cache(dir, string, salt, transform, suffix)
  local digest = md5.sumhexa(string .. (salt or ""))
  local name = util.pathname(dir, digest .. suffix)
  local file = io.open(name, "r")
  local result = nil
  if file == nil then -- If no cache entry exists, create a new one.
    file = assert(io.open(name, "w"),
      [[Could not open file "]] .. name .. [[" for writing]])
    result = string
    if transform ~= nil then
      result = transform(result)
    end
    assert(file:write(result))
    assert(file:close())
  end
  return name, result
end
function util.cache_verbatim(dir, string)
  local name = util.cache(dir, string, nil, nil, ".verbatim")
  return name
end
function util.table_copy(t)
  local u = { }
  for k, v in pairs(t) do u[k] = v end
  return setmetatable(u, getmetatable(t))
end
function util.encode_json_string(s)
  s = s:gsub([[\]], [[\\]])
  s = s:gsub([["]], [[\"]])
  return [["]] .. s .. [["]]
end
function util.expand_tabs_in_line(s, tabstop)
  local tab = tabstop or 4
  local corr = 0
  return (s:gsub("()\t", function(p)
            local sp = tab - (p - 1 + corr) % tab
            corr = corr - 1 + sp
            return string.rep(" ", sp)
          end))
end
function util.walk(t, f)
  local typ = type(t)
  if typ == "string" then
    f(t)
  elseif typ == "table" then
    local i = 1
    local n
    n = t[i]
    while n do
      util.walk(n, f)
      i = i + 1
      n = t[i]
    end
  elseif typ == "function" then
    local ok, val = pcall(t)
    if ok then
      util.walk(val,f)
    end
  else
    f(tostring(t))
  end
end
function util.flatten(ary)
  local new = {}
  for _,v in ipairs(ary) do
    if type(v) == "table" then
      for _,w in ipairs(util.flatten(v)) do
        new[#new + 1] = w
      end
    else
      new[#new + 1] = v
    end
  end
  return new
end
function util.rope_to_string(rope)
  local buffer = {}
  util.walk(rope, function(x) buffer[#buffer + 1] = x end)
  return table.concat(buffer)
end
function util.rope_last(rope)
  if #rope == 0 then
    return nil
  else
    local l = rope[#rope]
    if type(l) == "table" then
      return util.rope_last(l)
    else
      return l
    end
  end
end
function util.intersperse(ary, x)
  local new = {}
  local l = #ary
  for i,v in ipairs(ary) do
    local n = #new
    new[n + 1] = v
    if i ~= l then
      new[n + 2] = x
    end
  end
  return new
end
function util.map(ary, f)
  local new = {}
  for i,v in ipairs(ary) do
    new[i] = f(v)
  end
  return new
end
function util.escaper(char_escapes, string_escapes)
  local char_escapes_list = ""
  for i,_ in pairs(char_escapes) do
    char_escapes_list = char_escapes_list .. i
  end
  local escapable = S(char_escapes_list) / char_escapes
  if string_escapes then
    for k,v in pairs(string_escapes) do
      escapable = P(k) / v + escapable
    end
  end
  local escape_string = Cs((escapable + any)^0)
  return function(s)
    return lpeg.match(escape_string, s)
  end
end
function util.pathname(dir, file)
  if #dir == 0 then
    return file
  else
    return dir .. "/" .. file
  end
end
function util.salt(options)
  local opt_string = {}
  for k, _ in pairs(defaultOptions) do
    local v = options[k]
    if type(v) == "table" then
      for _, i in ipairs(v) do
        opt_string[#opt_string+1] = k .. "=" .. tostring(i)
      end
    elseif k ~= "cacheDir" then
      opt_string[#opt_string+1] = k .. "=" .. tostring(v)
    end
  end
  table.sort(opt_string)
  local salt = table.concat(opt_string, ",")
            .. "," .. metadata.version
  return salt
end
util.warning = (function()
  local function warning(s)
    io.stderr:write("Warning: " .. s .. "\n")
  end
  for _, message in ipairs(early_warnings) do
    warning(message)
  end
  return warning
end)()
util.casefold = (function()
  local fail, any = P(false), P(1)
  local eof = -any
  local fold_character = fail
  for n = 1, 4 do
    fold_character
      = fold_character
      + unicode_data.casefold_mapping[n]
  end
  fold_character
    = fold_character
    + C(any)
  local fold_string = Ct(fold_character^0) * eof
  return function(s, form)
    local result = table.concat(lpeg.match(fold_string, s))
    assert(result ~= nil)
    if form == "nfd" or form == "nfkd" then
      result = util.normalize(result, form)
      result = table.concat(lpeg.match(fold_string, result))
      assert(result ~= nil)
      result = util.normalize(result, form)
    end
    return result
  end
end)()
util.canonically_order = (function()
  local fail, any = P(false), P(1)
  local eof = -any
  local cont = R("\128\191")
  local utf8_character
    = R("\0\127")
    + R("\194\223") * cont
    + R("\224\239") * cont * cont
    + R("\240\244") * cont * cont * cont
  local classify_character = fail
  for n = 1, 4 do
    classify_character
      = classify_character
      + unicode_data.ccc[n]
  end
  classify_character
    = classify_character
    + utf8_character * Cc(0)
  local classify_string = Ct(classify_character^0) * eof
  return function(s)
    local s_len = utf8.len(s)
    if s == false or s_len <= 1 then
      return s
    end
    local classes = lpeg.match(classify_string, s)
    if classes == nil then
      return s
    end
    assert(#classes == s_len)
    local non_starter_ranges = {}
    local first_non_starter, last_non_starter = nil, nil
    for i = 1, #classes do
      if first_non_starter == nil then
        if classes[i] ~= 0 then
          first_non_starter, last_non_starter = i, i
        end
      else
        if classes[i] == 0 then
          table.insert(
            non_starter_ranges,
            {first_non_starter, last_non_starter}
          )
          first_non_starter, last_non_starter = nil, nil
        else
          last_non_starter = i
        end
      end
    end
    if first_non_starter ~= nil then
      table.insert(
        non_starter_ranges,
        {first_non_starter, last_non_starter}
      )
    end
    if #non_starter_ranges == 0 then
      return s
    end
    local max_range_length = 0
    for _, range in ipairs(non_starter_ranges) do
      local range_start, range_end = table.unpack(range)
      local range_length = range_end - range_start + 1
      if range_length > max_range_length then
        max_range_length = range_length
      end
    end
    if max_range_length <= 1 then
      return s
    end
    local buffer = {}
    for _, code in utf8.codes(s) do
      local char = utf8.char(code)
      table.insert(buffer, char)
    end
    assert(#buffer == s_len)
    for _, range in ipairs(non_starter_ranges) do
      local range_start, range_end = table.unpack(range)
      local range_length = range_end - range_start + 1
      for _ = 1, range_length - 1 do
        local swapped = false
        for i = range_start, range_end - 1 do
          local j = i + 1
          if classes[i] > classes[j] then
            classes[i], classes[j] = classes[j], classes[i]
            buffer[i], buffer[j] = buffer[j], buffer[i]
            swapped = true
          end
        end
        if not swapped then
          break
        end
      end
    end
    return table.concat(buffer, "")
  end
end)()
util.decompose = (function()
  local fail, any = P(false), P(1)
  local eof = -any
  local decomposition_types = {"canonical", "compatibility"}
  local decompose_character = {}
  for _, decomposition_type in ipairs(decomposition_types) do
    decompose_character[decomposition_type] = fail
    for n = 1, 4 do
      decompose_character[decomposition_type]
        = decompose_character[decomposition_type]
        + unicode_data.decomposition_mapping[decomposition_type][n]
    end
    decompose_character[decomposition_type]
      = decompose_character[decomposition_type]
      + C(any)
  end
  local hangul = unicode_data.decomposition_mapping.hangul
  decompose_character.hangul = {}
  for syllable_type, _ in pairs(hangul) do
    decompose_character.hangul[syllable_type] = fail
    for n = 1, 4 do
      decompose_character.hangul[syllable_type]
        = decompose_character.hangul[syllable_type]
        + hangul[syllable_type][n]
    end
    decompose_character.hangul[syllable_type]
      = decompose_character.hangul[syllable_type]
      + C(any)
  end
  local decompose_string = {}
  for _, decomposition_type in ipairs(decomposition_types) do
    decompose_string[decomposition_type]
      = Ct(decompose_character[decomposition_type]^0) * eof
  end
  decompose_string.hangul = {}
  for syllable_type, _ in pairs(hangul) do
    decompose_string.hangul[syllable_type]
      = Ct(decompose_character.hangul[syllable_type]^0) * eof
  end
  local function _decompose(s, parser)
    assert(s ~= nil)
    local result = table.concat(lpeg.match(parser, s), "")
    assert(result ~= nil)
    return result
  end
  return function(s, decomposition_type)
    assert(
      decomposition_type == "canonical"
      or decomposition_type == "compatibility"
    )
    local prev_s
    local next_s = s
    repeat
      prev_s = next_s
      local function decompose(...) next_s = _decompose(next_s, ...) end
      decompose(decompose_string.canonical)
      if decomposition_type == "compatibility" then
        decompose(decompose_string.compatibility)
      end
      decompose(decompose_string.hangul.LVT)
      decompose(decompose_string.hangul.LV)
    until prev_s == next_s
    return util.canonically_order(next_s)
  end
end)()
util.compose = (function()
  local fail, any = P(false), P(1)
  local eof = -any
  local cont = R("\128\191")
  local utf8_character
    = R("\0\127")
    + R("\194\223") * cont
    + R("\224\239") * cont * cont
    + R("\240\244") * cont * cont * cont
  local classify_character = fail
  for n = 1, 4 do
    classify_character
      = classify_character
      + unicode_data.ccc[n]
  end
  classify_character
    = classify_character
    + utf8_character * Cc(0)
  local classify_string = Ct(classify_character^0) * eof
  local compose_characters = fail
  for m = 1, 4 do
    local starter = #unicode_data.composition_mapping.starters[m]
    local both = fail
    for n = 1, 4 do
      both = (
        both
        + #unicode_data.composition_mapping.both[m][n]
        * unicode_data.composition_mapping.both[m][n]
      )
    end
    compose_characters = compose_characters + starter * both
  end
  return function(s)
    local s_len = utf8.len(s)
    if s == false or s_len <= 1 then
      return s
    end
    local classes = lpeg.match(classify_string, s)
    if classes == nil then
      return s
    end
    assert(#classes == s_len)
    local buffer = {}
    for _, code in utf8.codes(s) do
      local char = utf8.char(code)
      table.insert(buffer, char)
    end
    assert(#buffer == s_len)
    local starter = 1
    while starter <= s_len and classes[starter] ~= 0 do
      starter = starter + 1
    end
    local candidate_combining_mark = starter + 1
    while candidate_combining_mark <= s_len do
      local L = buffer[starter]
      local C = buffer[candidate_combining_mark]
      local P = lpeg.match(compose_characters, L .. C)
      if P ~= nil then
        buffer[starter] = P
        buffer[candidate_combining_mark] = ""
      else
        if classes[candidate_combining_mark] == 0 then
          starter = candidate_combining_mark
        end
        candidate_combining_mark = candidate_combining_mark + 1
      end
      assert(starter <= s_len)
    end
    for i = 1, s_len - 1 do
      local last, ch = buffer[i], buffer[i + 1]
      if last ~= "" and ch ~= "" then
        local composite = unicode_data.hangul_compose(last, ch)
        if composite ~= nil then
          buffer[i] = ""
          buffer[i + 1] = composite
        end
      end
    end
    return table.concat(buffer, "")
  end
end)()
function util.normalize(s, form)
  if form == "nfd" then
    return util.decompose(s, "canonical")
  elseif form == "nfkd" then
    return util.decompose(s, "compatibility")
  elseif form == "nfc" then
    return util.compose(util.decompose(s, "canonical"))
  elseif form == "nfkc" then
    return util.compose(util.decompose(s, "compatibility"))
  else
    error(string.format('Unexpected normal form "%s"', form))
  end
end
function util.find_file(filename)
  if resolvers ~= nil then
    return resolvers.findfile(filename)
  else
    return kpse.find_file(filename)
  end
end
function util.find_files(filename)
  if resolvers ~= nil then
    return resolvers.findfiles(filename)
  else
    return {kpse.lookup(filename, {all=true})}
  end
end
local entities = {}

local character_entities = {
  ["Tab"] = 9,
  ["NewLine"] = 10,
  ["excl"] = 33,
  ["QUOT"] = 34,
  ["quot"] = 34,
  ["num"] = 35,
  ["dollar"] = 36,
  ["percnt"] = 37,
  ["AMP"] = 38,
  ["amp"] = 38,
  ["apos"] = 39,
  ["lpar"] = 40,
  ["rpar"] = 41,
  ["ast"] = 42,
  ["midast"] = 42,
  ["plus"] = 43,
  ["comma"] = 44,
  ["period"] = 46,
  ["sol"] = 47,
  ["colon"] = 58,
  ["semi"] = 59,
  ["LT"] = 60,
  ["lt"] = 60,
  ["nvlt"] = {60, 8402},
  ["bne"] = {61, 8421},
  ["equals"] = 61,
  ["GT"] = 62,
  ["gt"] = 62,
  ["nvgt"] = {62, 8402},
  ["quest"] = 63,
  ["commat"] = 64,
  ["lbrack"] = 91,
  ["lsqb"] = 91,
  ["bsol"] = 92,
  ["rbrack"] = 93,
  ["rsqb"] = 93,
  ["Hat"] = 94,
  ["UnderBar"] = 95,
  ["lowbar"] = 95,
  ["DiacriticalGrave"] = 96,
  ["grave"] = 96,
  ["fjlig"] = {102, 106},
  ["lbrace"] = 123,
  ["lcub"] = 123,
  ["VerticalLine"] = 124,
  ["verbar"] = 124,
  ["vert"] = 124,
  ["rbrace"] = 125,
  ["rcub"] = 125,
  ["NonBreakingSpace"] = 160,
  ["nbsp"] = 160,
  ["iexcl"] = 161,
  ["cent"] = 162,
  ["pound"] = 163,
  ["curren"] = 164,
  ["yen"] = 165,
  ["brvbar"] = 166,
  ["sect"] = 167,
  ["Dot"] = 168,
  ["DoubleDot"] = 168,
  ["die"] = 168,
  ["uml"] = 168,
  ["COPY"] = 169,
  ["copy"] = 169,
  ["ordf"] = 170,
  ["laquo"] = 171,
  ["not"] = 172,
  ["shy"] = 173,
  ["REG"] = 174,
  ["circledR"] = 174,
  ["reg"] = 174,
  ["macr"] = 175,
  ["strns"] = 175,
  ["deg"] = 176,
  ["PlusMinus"] = 177,
  ["plusmn"] = 177,
  ["pm"] = 177,
  ["sup2"] = 178,
  ["sup3"] = 179,
  ["DiacriticalAcute"] = 180,
  ["acute"] = 180,
  ["micro"] = 181,
  ["para"] = 182,
  ["CenterDot"] = 183,
  ["centerdot"] = 183,
  ["middot"] = 183,
  ["Cedilla"] = 184,
  ["cedil"] = 184,
  ["sup1"] = 185,
  ["ordm"] = 186,
  ["raquo"] = 187,
  ["frac14"] = 188,
  ["frac12"] = 189,
  ["half"] = 189,
  ["frac34"] = 190,
  ["iquest"] = 191,
  ["Agrave"] = 192,
  ["Aacute"] = 193,
  ["Acirc"] = 194,
  ["Atilde"] = 195,
  ["Auml"] = 196,
  ["Aring"] = 197,
  ["angst"] = 197,
  ["AElig"] = 198,
  ["Ccedil"] = 199,
  ["Egrave"] = 200,
  ["Eacute"] = 201,
  ["Ecirc"] = 202,
  ["Euml"] = 203,
  ["Igrave"] = 204,
  ["Iacute"] = 205,
  ["Icirc"] = 206,
  ["Iuml"] = 207,
  ["ETH"] = 208,
  ["Ntilde"] = 209,
  ["Ograve"] = 210,
  ["Oacute"] = 211,
  ["Ocirc"] = 212,
  ["Otilde"] = 213,
  ["Ouml"] = 214,
  ["times"] = 215,
  ["Oslash"] = 216,
  ["Ugrave"] = 217,
  ["Uacute"] = 218,
  ["Ucirc"] = 219,
  ["Uuml"] = 220,
  ["Yacute"] = 221,
  ["THORN"] = 222,
  ["szlig"] = 223,
  ["agrave"] = 224,
  ["aacute"] = 225,
  ["acirc"] = 226,
  ["atilde"] = 227,
  ["auml"] = 228,
  ["aring"] = 229,
  ["aelig"] = 230,
  ["ccedil"] = 231,
  ["egrave"] = 232,
  ["eacute"] = 233,
  ["ecirc"] = 234,
  ["euml"] = 235,
  ["igrave"] = 236,
  ["iacute"] = 237,
  ["icirc"] = 238,
  ["iuml"] = 239,
  ["eth"] = 240,
  ["ntilde"] = 241,
  ["ograve"] = 242,
  ["oacute"] = 243,
  ["ocirc"] = 244,
  ["otilde"] = 245,
  ["ouml"] = 246,
  ["div"] = 247,
  ["divide"] = 247,
  ["oslash"] = 248,
  ["ugrave"] = 249,
  ["uacute"] = 250,
  ["ucirc"] = 251,
  ["uuml"] = 252,
  ["yacute"] = 253,
  ["thorn"] = 254,
  ["yuml"] = 255,
  ["Amacr"] = 256,
  ["amacr"] = 257,
  ["Abreve"] = 258,
  ["abreve"] = 259,
  ["Aogon"] = 260,
  ["aogon"] = 261,
  ["Cacute"] = 262,
  ["cacute"] = 263,
  ["Ccirc"] = 264,
  ["ccirc"] = 265,
  ["Cdot"] = 266,
  ["cdot"] = 267,
  ["Ccaron"] = 268,
  ["ccaron"] = 269,
  ["Dcaron"] = 270,
  ["dcaron"] = 271,
  ["Dstrok"] = 272,
  ["dstrok"] = 273,
  ["Emacr"] = 274,
  ["emacr"] = 275,
  ["Edot"] = 278,
  ["edot"] = 279,
  ["Eogon"] = 280,
  ["eogon"] = 281,
  ["Ecaron"] = 282,
  ["ecaron"] = 283,
  ["Gcirc"] = 284,
  ["gcirc"] = 285,
  ["Gbreve"] = 286,
  ["gbreve"] = 287,
  ["Gdot"] = 288,
  ["gdot"] = 289,
  ["Gcedil"] = 290,
  ["Hcirc"] = 292,
  ["hcirc"] = 293,
  ["Hstrok"] = 294,
  ["hstrok"] = 295,
  ["Itilde"] = 296,
  ["itilde"] = 297,
  ["Imacr"] = 298,
  ["imacr"] = 299,
  ["Iogon"] = 302,
  ["iogon"] = 303,
  ["Idot"] = 304,
  ["imath"] = 305,
  ["inodot"] = 305,
  ["IJlig"] = 306,
  ["ijlig"] = 307,
  ["Jcirc"] = 308,
  ["jcirc"] = 309,
  ["Kcedil"] = 310,
  ["kcedil"] = 311,
  ["kgreen"] = 312,
  ["Lacute"] = 313,
  ["lacute"] = 314,
  ["Lcedil"] = 315,
  ["lcedil"] = 316,
  ["Lcaron"] = 317,
  ["lcaron"] = 318,
  ["Lmidot"] = 319,
  ["lmidot"] = 320,
  ["Lstrok"] = 321,
  ["lstrok"] = 322,
  ["Nacute"] = 323,
  ["nacute"] = 324,
  ["Ncedil"] = 325,
  ["ncedil"] = 326,
  ["Ncaron"] = 327,
  ["ncaron"] = 328,
  ["napos"] = 329,
  ["ENG"] = 330,
  ["eng"] = 331,
  ["Omacr"] = 332,
  ["omacr"] = 333,
  ["Odblac"] = 336,
  ["odblac"] = 337,
  ["OElig"] = 338,
  ["oelig"] = 339,
  ["Racute"] = 340,
  ["racute"] = 341,
  ["Rcedil"] = 342,
  ["rcedil"] = 343,
  ["Rcaron"] = 344,
  ["rcaron"] = 345,
  ["Sacute"] = 346,
  ["sacute"] = 347,
  ["Scirc"] = 348,
  ["scirc"] = 349,
  ["Scedil"] = 350,
  ["scedil"] = 351,
  ["Scaron"] = 352,
  ["scaron"] = 353,
  ["Tcedil"] = 354,
  ["tcedil"] = 355,
  ["Tcaron"] = 356,
  ["tcaron"] = 357,
  ["Tstrok"] = 358,
  ["tstrok"] = 359,
  ["Utilde"] = 360,
  ["utilde"] = 361,
  ["Umacr"] = 362,
  ["umacr"] = 363,
  ["Ubreve"] = 364,
  ["ubreve"] = 365,
  ["Uring"] = 366,
  ["uring"] = 367,
  ["Udblac"] = 368,
  ["udblac"] = 369,
  ["Uogon"] = 370,
  ["uogon"] = 371,
  ["Wcirc"] = 372,
  ["wcirc"] = 373,
  ["Ycirc"] = 374,
  ["ycirc"] = 375,
  ["Yuml"] = 376,
  ["Zacute"] = 377,
  ["zacute"] = 378,
  ["Zdot"] = 379,
  ["zdot"] = 380,
  ["Zcaron"] = 381,
  ["zcaron"] = 382,
  ["fnof"] = 402,
  ["imped"] = 437,
  ["gacute"] = 501,
  ["jmath"] = 567,
  ["circ"] = 710,
  ["Hacek"] = 711,
  ["caron"] = 711,
  ["Breve"] = 728,
  ["breve"] = 728,
  ["DiacriticalDot"] = 729,
  ["dot"] = 729,
  ["ring"] = 730,
  ["ogon"] = 731,
  ["DiacriticalTilde"] = 732,
  ["tilde"] = 732,
  ["DiacriticalDoubleAcute"] = 733,
  ["dblac"] = 733,
  ["DownBreve"] = 785,
  ["Alpha"] = 913,
  ["Beta"] = 914,
  ["Gamma"] = 915,
  ["Delta"] = 916,
  ["Epsilon"] = 917,
  ["Zeta"] = 918,
  ["Eta"] = 919,
  ["Theta"] = 920,
  ["Iota"] = 921,
  ["Kappa"] = 922,
  ["Lambda"] = 923,
  ["Mu"] = 924,
  ["Nu"] = 925,
  ["Xi"] = 926,
  ["Omicron"] = 927,
  ["Pi"] = 928,
  ["Rho"] = 929,
  ["Sigma"] = 931,
  ["Tau"] = 932,
  ["Upsilon"] = 933,
  ["Phi"] = 934,
  ["Chi"] = 935,
  ["Psi"] = 936,
  ["Omega"] = 937,
  ["ohm"] = 937,
  ["alpha"] = 945,
  ["beta"] = 946,
  ["gamma"] = 947,
  ["delta"] = 948,
  ["epsi"] = 949,
  ["epsilon"] = 949,
  ["zeta"] = 950,
  ["eta"] = 951,
  ["theta"] = 952,
  ["iota"] = 953,
  ["kappa"] = 954,
  ["lambda"] = 955,
  ["mu"] = 956,
  ["nu"] = 957,
  ["xi"] = 958,
  ["omicron"] = 959,
  ["pi"] = 960,
  ["rho"] = 961,
  ["sigmaf"] = 962,
  ["sigmav"] = 962,
  ["varsigma"] = 962,
  ["sigma"] = 963,
  ["tau"] = 964,
  ["upsi"] = 965,
  ["upsilon"] = 965,
  ["phi"] = 966,
  ["chi"] = 967,
  ["psi"] = 968,
  ["omega"] = 969,
  ["thetasym"] = 977,
  ["thetav"] = 977,
  ["vartheta"] = 977,
  ["Upsi"] = 978,
  ["upsih"] = 978,
  ["phiv"] = 981,
  ["straightphi"] = 981,
  ["varphi"] = 981,
  ["piv"] = 982,
  ["varpi"] = 982,
  ["Gammad"] = 988,
  ["digamma"] = 989,
  ["gammad"] = 989,
  ["kappav"] = 1008,
  ["varkappa"] = 1008,
  ["rhov"] = 1009,
  ["varrho"] = 1009,
  ["epsiv"] = 1013,
  ["straightepsilon"] = 1013,
  ["varepsilon"] = 1013,
  ["backepsilon"] = 1014,
  ["bepsi"] = 1014,
  ["IOcy"] = 1025,
  ["DJcy"] = 1026,
  ["GJcy"] = 1027,
  ["Jukcy"] = 1028,
  ["DScy"] = 1029,
  ["Iukcy"] = 1030,
  ["YIcy"] = 1031,
  ["Jsercy"] = 1032,
  ["LJcy"] = 1033,
  ["NJcy"] = 1034,
  ["TSHcy"] = 1035,
  ["KJcy"] = 1036,
  ["Ubrcy"] = 1038,
  ["DZcy"] = 1039,
  ["Acy"] = 1040,
  ["Bcy"] = 1041,
  ["Vcy"] = 1042,
  ["Gcy"] = 1043,
  ["Dcy"] = 1044,
  ["IEcy"] = 1045,
  ["ZHcy"] = 1046,
  ["Zcy"] = 1047,
  ["Icy"] = 1048,
  ["Jcy"] = 1049,
  ["Kcy"] = 1050,
  ["Lcy"] = 1051,
  ["Mcy"] = 1052,
  ["Ncy"] = 1053,
  ["Ocy"] = 1054,
  ["Pcy"] = 1055,
  ["Rcy"] = 1056,
  ["Scy"] = 1057,
  ["Tcy"] = 1058,
  ["Ucy"] = 1059,
  ["Fcy"] = 1060,
  ["KHcy"] = 1061,
  ["TScy"] = 1062,
  ["CHcy"] = 1063,
  ["SHcy"] = 1064,
  ["SHCHcy"] = 1065,
  ["HARDcy"] = 1066,
  ["Ycy"] = 1067,
  ["SOFTcy"] = 1068,
  ["Ecy"] = 1069,
  ["YUcy"] = 1070,
  ["YAcy"] = 1071,
  ["acy"] = 1072,
  ["bcy"] = 1073,
  ["vcy"] = 1074,
  ["gcy"] = 1075,
  ["dcy"] = 1076,
  ["iecy"] = 1077,
  ["zhcy"] = 1078,
  ["zcy"] = 1079,
  ["icy"] = 1080,
  ["jcy"] = 1081,
  ["kcy"] = 1082,
  ["lcy"] = 1083,
  ["mcy"] = 1084,
  ["ncy"] = 1085,
  ["ocy"] = 1086,
  ["pcy"] = 1087,
  ["rcy"] = 1088,
  ["scy"] = 1089,
  ["tcy"] = 1090,
  ["ucy"] = 1091,
  ["fcy"] = 1092,
  ["khcy"] = 1093,
  ["tscy"] = 1094,
  ["chcy"] = 1095,
  ["shcy"] = 1096,
  ["shchcy"] = 1097,
  ["hardcy"] = 1098,
  ["ycy"] = 1099,
  ["softcy"] = 1100,
  ["ecy"] = 1101,
  ["yucy"] = 1102,
  ["yacy"] = 1103,
  ["iocy"] = 1105,
  ["djcy"] = 1106,
  ["gjcy"] = 1107,
  ["jukcy"] = 1108,
  ["dscy"] = 1109,
  ["iukcy"] = 1110,
  ["yicy"] = 1111,
  ["jsercy"] = 1112,
  ["ljcy"] = 1113,
  ["njcy"] = 1114,
  ["tshcy"] = 1115,
  ["kjcy"] = 1116,
  ["ubrcy"] = 1118,
  ["dzcy"] = 1119,
  ["ensp"] = 8194,
  ["emsp"] = 8195,
  ["emsp13"] = 8196,
  ["emsp14"] = 8197,
  ["numsp"] = 8199,
  ["puncsp"] = 8200,
  ["ThinSpace"] = 8201,
  ["thinsp"] = 8201,
  ["VeryThinSpace"] = 8202,
  ["hairsp"] = 8202,
  ["NegativeMediumSpace"] = 8203,
  ["NegativeThickSpace"] = 8203,
  ["NegativeThinSpace"] = 8203,
  ["NegativeVeryThinSpace"] = 8203,
  ["ZeroWidthSpace"] = 8203,
  ["zwnj"] = 8204,
  ["zwj"] = 8205,
  ["lrm"] = 8206,
  ["rlm"] = 8207,
  ["dash"] = 8208,
  ["hyphen"] = 8208,
  ["ndash"] = 8211,
  ["mdash"] = 8212,
  ["horbar"] = 8213,
  ["Verbar"] = 8214,
  ["Vert"] = 8214,
  ["OpenCurlyQuote"] = 8216,
  ["lsquo"] = 8216,
  ["CloseCurlyQuote"] = 8217,
  ["rsquo"] = 8217,
  ["rsquor"] = 8217,
  ["lsquor"] = 8218,
  ["sbquo"] = 8218,
  ["OpenCurlyDoubleQuote"] = 8220,
  ["ldquo"] = 8220,
  ["CloseCurlyDoubleQuote"] = 8221,
  ["rdquo"] = 8221,
  ["rdquor"] = 8221,
  ["bdquo"] = 8222,
  ["ldquor"] = 8222,
  ["dagger"] = 8224,
  ["Dagger"] = 8225,
  ["ddagger"] = 8225,
  ["bull"] = 8226,
  ["bullet"] = 8226,
  ["nldr"] = 8229,
  ["hellip"] = 8230,
  ["mldr"] = 8230,
  ["permil"] = 8240,
  ["pertenk"] = 8241,
  ["prime"] = 8242,
  ["Prime"] = 8243,
  ["tprime"] = 8244,
  ["backprime"] = 8245,
  ["bprime"] = 8245,
  ["lsaquo"] = 8249,
  ["rsaquo"] = 8250,
  ["OverBar"] = 8254,
  ["oline"] = 8254,
  ["caret"] = 8257,
  ["hybull"] = 8259,
  ["frasl"] = 8260,
  ["bsemi"] = 8271,
  ["qprime"] = 8279,
  ["MediumSpace"] = 8287,
  ["ThickSpace"] = {8287, 8202},
  ["NoBreak"] = 8288,
  ["ApplyFunction"] = 8289,
  ["af"] = 8289,
  ["InvisibleTimes"] = 8290,
  ["it"] = 8290,
  ["InvisibleComma"] = 8291,
  ["ic"] = 8291,
  ["euro"] = 8364,
  ["TripleDot"] = 8411,
  ["tdot"] = 8411,
  ["DotDot"] = 8412,
  ["Copf"] = 8450,
  ["complexes"] = 8450,
  ["incare"] = 8453,
  ["gscr"] = 8458,
  ["HilbertSpace"] = 8459,
  ["Hscr"] = 8459,
  ["hamilt"] = 8459,
  ["Hfr"] = 8460,
  ["Poincareplane"] = 8460,
  ["Hopf"] = 8461,
  ["quaternions"] = 8461,
  ["planckh"] = 8462,
  ["hbar"] = 8463,
  ["hslash"] = 8463,
  ["planck"] = 8463,
  ["plankv"] = 8463,
  ["Iscr"] = 8464,
  ["imagline"] = 8464,
  ["Ifr"] = 8465,
  ["Im"] = 8465,
  ["image"] = 8465,
  ["imagpart"] = 8465,
  ["Laplacetrf"] = 8466,
  ["Lscr"] = 8466,
  ["lagran"] = 8466,
  ["ell"] = 8467,
  ["Nopf"] = 8469,
  ["naturals"] = 8469,
  ["numero"] = 8470,
  ["copysr"] = 8471,
  ["weierp"] = 8472,
  ["wp"] = 8472,
  ["Popf"] = 8473,
  ["primes"] = 8473,
  ["Qopf"] = 8474,
  ["rationals"] = 8474,
  ["Rscr"] = 8475,
  ["realine"] = 8475,
  ["Re"] = 8476,
  ["Rfr"] = 8476,
  ["real"] = 8476,
  ["realpart"] = 8476,
  ["Ropf"] = 8477,
  ["reals"] = 8477,
  ["rx"] = 8478,
  ["TRADE"] = 8482,
  ["trade"] = 8482,
  ["Zopf"] = 8484,
  ["integers"] = 8484,
  ["mho"] = 8487,
  ["Zfr"] = 8488,
  ["zeetrf"] = 8488,
  ["iiota"] = 8489,
  ["Bernoullis"] = 8492,
  ["Bscr"] = 8492,
  ["bernou"] = 8492,
  ["Cayleys"] = 8493,
  ["Cfr"] = 8493,
  ["escr"] = 8495,
  ["Escr"] = 8496,
  ["expectation"] = 8496,
  ["Fouriertrf"] = 8497,
  ["Fscr"] = 8497,
  ["Mellintrf"] = 8499,
  ["Mscr"] = 8499,
  ["phmmat"] = 8499,
  ["order"] = 8500,
  ["orderof"] = 8500,
  ["oscr"] = 8500,
  ["alefsym"] = 8501,
  ["aleph"] = 8501,
  ["beth"] = 8502,
  ["gimel"] = 8503,
  ["daleth"] = 8504,
  ["CapitalDifferentialD"] = 8517,
  ["DD"] = 8517,
  ["DifferentialD"] = 8518,
  ["dd"] = 8518,
  ["ExponentialE"] = 8519,
  ["ee"] = 8519,
  ["exponentiale"] = 8519,
  ["ImaginaryI"] = 8520,
  ["ii"] = 8520,
  ["frac13"] = 8531,
  ["frac23"] = 8532,
  ["frac15"] = 8533,
  ["frac25"] = 8534,
  ["frac35"] = 8535,
  ["frac45"] = 8536,
  ["frac16"] = 8537,
  ["frac56"] = 8538,
  ["frac18"] = 8539,
  ["frac38"] = 8540,
  ["frac58"] = 8541,
  ["frac78"] = 8542,
  ["LeftArrow"] = 8592,
  ["ShortLeftArrow"] = 8592,
  ["larr"] = 8592,
  ["leftarrow"] = 8592,
  ["slarr"] = 8592,
  ["ShortUpArrow"] = 8593,
  ["UpArrow"] = 8593,
  ["uarr"] = 8593,
  ["uparrow"] = 8593,
  ["RightArrow"] = 8594,
  ["ShortRightArrow"] = 8594,
  ["rarr"] = 8594,
  ["rightarrow"] = 8594,
  ["srarr"] = 8594,
  ["DownArrow"] = 8595,
  ["ShortDownArrow"] = 8595,
  ["darr"] = 8595,
  ["downarrow"] = 8595,
  ["LeftRightArrow"] = 8596,
  ["harr"] = 8596,
  ["leftrightarrow"] = 8596,
  ["UpDownArrow"] = 8597,
  ["updownarrow"] = 8597,
  ["varr"] = 8597,
  ["UpperLeftArrow"] = 8598,
  ["nwarr"] = 8598,
  ["nwarrow"] = 8598,
  ["UpperRightArrow"] = 8599,
  ["nearr"] = 8599,
  ["nearrow"] = 8599,
  ["LowerRightArrow"] = 8600,
  ["searr"] = 8600,
  ["searrow"] = 8600,
  ["LowerLeftArrow"] = 8601,
  ["swarr"] = 8601,
  ["swarrow"] = 8601,
  ["nlarr"] = 8602,
  ["nleftarrow"] = 8602,
  ["nrarr"] = 8603,
  ["nrightarrow"] = 8603,
  ["nrarrw"] = {8605, 824},
  ["rarrw"] = 8605,
  ["rightsquigarrow"] = 8605,
  ["Larr"] = 8606,
  ["twoheadleftarrow"] = 8606,
  ["Uarr"] = 8607,
  ["Rarr"] = 8608,
  ["twoheadrightarrow"] = 8608,
  ["Darr"] = 8609,
  ["larrtl"] = 8610,
  ["leftarrowtail"] = 8610,
  ["rarrtl"] = 8611,
  ["rightarrowtail"] = 8611,
  ["LeftTeeArrow"] = 8612,
  ["mapstoleft"] = 8612,
  ["UpTeeArrow"] = 8613,
  ["mapstoup"] = 8613,
  ["RightTeeArrow"] = 8614,
  ["map"] = 8614,
  ["mapsto"] = 8614,
  ["DownTeeArrow"] = 8615,
  ["mapstodown"] = 8615,
  ["hookleftarrow"] = 8617,
  ["larrhk"] = 8617,
  ["hookrightarrow"] = 8618,
  ["rarrhk"] = 8618,
  ["larrlp"] = 8619,
  ["looparrowleft"] = 8619,
  ["looparrowright"] = 8620,
  ["rarrlp"] = 8620,
  ["harrw"] = 8621,
  ["leftrightsquigarrow"] = 8621,
  ["nharr"] = 8622,
  ["nleftrightarrow"] = 8622,
  ["Lsh"] = 8624,
  ["lsh"] = 8624,
  ["Rsh"] = 8625,
  ["rsh"] = 8625,
  ["ldsh"] = 8626,
  ["rdsh"] = 8627,
  ["crarr"] = 8629,
  ["cularr"] = 8630,
  ["curvearrowleft"] = 8630,
  ["curarr"] = 8631,
  ["curvearrowright"] = 8631,
  ["circlearrowleft"] = 8634,
  ["olarr"] = 8634,
  ["circlearrowright"] = 8635,
  ["orarr"] = 8635,
  ["LeftVector"] = 8636,
  ["leftharpoonup"] = 8636,
  ["lharu"] = 8636,
  ["DownLeftVector"] = 8637,
  ["leftharpoondown"] = 8637,
  ["lhard"] = 8637,
  ["RightUpVector"] = 8638,
  ["uharr"] = 8638,
  ["upharpoonright"] = 8638,
  ["LeftUpVector"] = 8639,
  ["uharl"] = 8639,
  ["upharpoonleft"] = 8639,
  ["RightVector"] = 8640,
  ["rharu"] = 8640,
  ["rightharpoonup"] = 8640,
  ["DownRightVector"] = 8641,
  ["rhard"] = 8641,
  ["rightharpoondown"] = 8641,
  ["RightDownVector"] = 8642,
  ["dharr"] = 8642,
  ["downharpoonright"] = 8642,
  ["LeftDownVector"] = 8643,
  ["dharl"] = 8643,
  ["downharpoonleft"] = 8643,
  ["RightArrowLeftArrow"] = 8644,
  ["rightleftarrows"] = 8644,
  ["rlarr"] = 8644,
  ["UpArrowDownArrow"] = 8645,
  ["udarr"] = 8645,
  ["LeftArrowRightArrow"] = 8646,
  ["leftrightarrows"] = 8646,
  ["lrarr"] = 8646,
  ["leftleftarrows"] = 8647,
  ["llarr"] = 8647,
  ["upuparrows"] = 8648,
  ["uuarr"] = 8648,
  ["rightrightarrows"] = 8649,
  ["rrarr"] = 8649,
  ["ddarr"] = 8650,
  ["downdownarrows"] = 8650,
  ["ReverseEquilibrium"] = 8651,
  ["leftrightharpoons"] = 8651,
  ["lrhar"] = 8651,
  ["Equilibrium"] = 8652,
  ["rightleftharpoons"] = 8652,
  ["rlhar"] = 8652,
  ["nLeftarrow"] = 8653,
  ["nlArr"] = 8653,
  ["nLeftrightarrow"] = 8654,
  ["nhArr"] = 8654,
  ["nRightarrow"] = 8655,
  ["nrArr"] = 8655,
  ["DoubleLeftArrow"] = 8656,
  ["Leftarrow"] = 8656,
  ["lArr"] = 8656,
  ["DoubleUpArrow"] = 8657,
  ["Uparrow"] = 8657,
  ["uArr"] = 8657,
  ["DoubleRightArrow"] = 8658,
  ["Implies"] = 8658,
  ["Rightarrow"] = 8658,
  ["rArr"] = 8658,
  ["DoubleDownArrow"] = 8659,
  ["Downarrow"] = 8659,
  ["dArr"] = 8659,
  ["DoubleLeftRightArrow"] = 8660,
  ["Leftrightarrow"] = 8660,
  ["hArr"] = 8660,
  ["iff"] = 8660,
  ["DoubleUpDownArrow"] = 8661,
  ["Updownarrow"] = 8661,
  ["vArr"] = 8661,
  ["nwArr"] = 8662,
  ["neArr"] = 8663,
  ["seArr"] = 8664,
  ["swArr"] = 8665,
  ["Lleftarrow"] = 8666,
  ["lAarr"] = 8666,
  ["Rrightarrow"] = 8667,
  ["rAarr"] = 8667,
  ["zigrarr"] = 8669,
  ["LeftArrowBar"] = 8676,
  ["larrb"] = 8676,
  ["RightArrowBar"] = 8677,
  ["rarrb"] = 8677,
  ["DownArrowUpArrow"] = 8693,
  ["duarr"] = 8693,
  ["loarr"] = 8701,
  ["roarr"] = 8702,
  ["hoarr"] = 8703,
  ["ForAll"] = 8704,
  ["forall"] = 8704,
  ["comp"] = 8705,
  ["complement"] = 8705,
  ["PartialD"] = 8706,
  ["npart"] = {8706, 824},
  ["part"] = 8706,
  ["Exists"] = 8707,
  ["exist"] = 8707,
  ["NotExists"] = 8708,
  ["nexist"] = 8708,
  ["nexists"] = 8708,
  ["empty"] = 8709,
  ["emptyset"] = 8709,
  ["emptyv"] = 8709,
  ["varnothing"] = 8709,
  ["Del"] = 8711,
  ["nabla"] = 8711,
  ["Element"] = 8712,
  ["in"] = 8712,
  ["isin"] = 8712,
  ["isinv"] = 8712,
  ["NotElement"] = 8713,
  ["notin"] = 8713,
  ["notinva"] = 8713,
  ["ReverseElement"] = 8715,
  ["SuchThat"] = 8715,
  ["ni"] = 8715,
  ["niv"] = 8715,
  ["NotReverseElement"] = 8716,
  ["notni"] = 8716,
  ["notniva"] = 8716,
  ["Product"] = 8719,
  ["prod"] = 8719,
  ["Coproduct"] = 8720,
  ["coprod"] = 8720,
  ["Sum"] = 8721,
  ["sum"] = 8721,
  ["minus"] = 8722,
  ["MinusPlus"] = 8723,
  ["mnplus"] = 8723,
  ["mp"] = 8723,
  ["dotplus"] = 8724,
  ["plusdo"] = 8724,
  ["Backslash"] = 8726,
  ["setminus"] = 8726,
  ["setmn"] = 8726,
  ["smallsetminus"] = 8726,
  ["ssetmn"] = 8726,
  ["lowast"] = 8727,
  ["SmallCircle"] = 8728,
  ["compfn"] = 8728,
  ["Sqrt"] = 8730,
  ["radic"] = 8730,
  ["Proportional"] = 8733,
  ["prop"] = 8733,
  ["propto"] = 8733,
  ["varpropto"] = 8733,
  ["vprop"] = 8733,
  ["infin"] = 8734,
  ["angrt"] = 8735,
  ["ang"] = 8736,
  ["angle"] = 8736,
  ["nang"] = {8736, 8402},
  ["angmsd"] = 8737,
  ["measuredangle"] = 8737,
  ["angsph"] = 8738,
  ["VerticalBar"] = 8739,
  ["mid"] = 8739,
  ["shortmid"] = 8739,
  ["smid"] = 8739,
  ["NotVerticalBar"] = 8740,
  ["nmid"] = 8740,
  ["nshortmid"] = 8740,
  ["nsmid"] = 8740,
  ["DoubleVerticalBar"] = 8741,
  ["par"] = 8741,
  ["parallel"] = 8741,
  ["shortparallel"] = 8741,
  ["spar"] = 8741,
  ["NotDoubleVerticalBar"] = 8742,
  ["npar"] = 8742,
  ["nparallel"] = 8742,
  ["nshortparallel"] = 8742,
  ["nspar"] = 8742,
  ["and"] = 8743,
  ["wedge"] = 8743,
  ["or"] = 8744,
  ["vee"] = 8744,
  ["cap"] = 8745,
  ["caps"] = {8745, 65024},
  ["cup"] = 8746,
  ["cups"] = {8746, 65024},
  ["Integral"] = 8747,
  ["int"] = 8747,
  ["Int"] = 8748,
  ["iiint"] = 8749,
  ["tint"] = 8749,
  ["ContourIntegral"] = 8750,
  ["conint"] = 8750,
  ["oint"] = 8750,
  ["Conint"] = 8751,
  ["DoubleContourIntegral"] = 8751,
  ["Cconint"] = 8752,
  ["cwint"] = 8753,
  ["ClockwiseContourIntegral"] = 8754,
  ["cwconint"] = 8754,
  ["CounterClockwiseContourIntegral"] = 8755,
  ["awconint"] = 8755,
  ["Therefore"] = 8756,
  ["there4"] = 8756,
  ["therefore"] = 8756,
  ["Because"] = 8757,
  ["becaus"] = 8757,
  ["because"] = 8757,
  ["ratio"] = 8758,
  ["Colon"] = 8759,
  ["Proportion"] = 8759,
  ["dotminus"] = 8760,
  ["minusd"] = 8760,
  ["mDDot"] = 8762,
  ["homtht"] = 8763,
  ["Tilde"] = 8764,
  ["nvsim"] = {8764, 8402},
  ["sim"] = 8764,
  ["thicksim"] = 8764,
  ["thksim"] = 8764,
  ["backsim"] = 8765,
  ["bsim"] = 8765,
  ["race"] = {8765, 817},
  ["ac"] = 8766,
  ["acE"] = {8766, 819},
  ["mstpos"] = 8766,
  ["acd"] = 8767,
  ["VerticalTilde"] = 8768,
  ["wr"] = 8768,
  ["wreath"] = 8768,
  ["NotTilde"] = 8769,
  ["nsim"] = 8769,
  ["EqualTilde"] = 8770,
  ["NotEqualTilde"] = {8770, 824},
  ["eqsim"] = 8770,
  ["esim"] = 8770,
  ["nesim"] = {8770, 824},
  ["TildeEqual"] = 8771,
  ["sime"] = 8771,
  ["simeq"] = 8771,
  ["NotTildeEqual"] = 8772,
  ["nsime"] = 8772,
  ["nsimeq"] = 8772,
  ["TildeFullEqual"] = 8773,
  ["cong"] = 8773,
  ["simne"] = 8774,
  ["NotTildeFullEqual"] = 8775,
  ["ncong"] = 8775,
  ["TildeTilde"] = 8776,
  ["ap"] = 8776,
  ["approx"] = 8776,
  ["asymp"] = 8776,
  ["thickapprox"] = 8776,
  ["thkap"] = 8776,
  ["NotTildeTilde"] = 8777,
  ["nap"] = 8777,
  ["napprox"] = 8777,
  ["ape"] = 8778,
  ["approxeq"] = 8778,
  ["apid"] = 8779,
  ["napid"] = {8779, 824},
  ["backcong"] = 8780,
  ["bcong"] = 8780,
  ["CupCap"] = 8781,
  ["asympeq"] = 8781,
  ["nvap"] = {8781, 8402},
  ["Bumpeq"] = 8782,
  ["HumpDownHump"] = 8782,
  ["NotHumpDownHump"] = {8782, 824},
  ["bump"] = 8782,
  ["nbump"] = {8782, 824},
  ["HumpEqual"] = 8783,
  ["NotHumpEqual"] = {8783, 824},
  ["bumpe"] = 8783,
  ["bumpeq"] = 8783,
  ["nbumpe"] = {8783, 824},
  ["DotEqual"] = 8784,
  ["doteq"] = 8784,
  ["esdot"] = 8784,
  ["nedot"] = {8784, 824},
  ["doteqdot"] = 8785,
  ["eDot"] = 8785,
  ["efDot"] = 8786,
  ["fallingdotseq"] = 8786,
  ["erDot"] = 8787,
  ["risingdotseq"] = 8787,
  ["Assign"] = 8788,
  ["colone"] = 8788,
  ["coloneq"] = 8788,
  ["ecolon"] = 8789,
  ["eqcolon"] = 8789,
  ["ecir"] = 8790,
  ["eqcirc"] = 8790,
  ["circeq"] = 8791,
  ["cire"] = 8791,
  ["wedgeq"] = 8793,
  ["veeeq"] = 8794,
  ["triangleq"] = 8796,
  ["trie"] = 8796,
  ["equest"] = 8799,
  ["questeq"] = 8799,
  ["NotEqual"] = 8800,
  ["ne"] = 8800,
  ["Congruent"] = 8801,
  ["bnequiv"] = {8801, 8421},
  ["equiv"] = 8801,
  ["NotCongruent"] = 8802,
  ["nequiv"] = 8802,
  ["le"] = 8804,
  ["leq"] = 8804,
  ["nvle"] = {8804, 8402},
  ["GreaterEqual"] = 8805,
  ["ge"] = 8805,
  ["geq"] = 8805,
  ["nvge"] = {8805, 8402},
  ["LessFullEqual"] = 8806,
  ["lE"] = 8806,
  ["leqq"] = 8806,
  ["nlE"] = {8806, 824},
  ["nleqq"] = {8806, 824},
  ["GreaterFullEqual"] = 8807,
  ["NotGreaterFullEqual"] = {8807, 824},
  ["gE"] = 8807,
  ["geqq"] = 8807,
  ["ngE"] = {8807, 824},
  ["ngeqq"] = {8807, 824},
  ["lnE"] = 8808,
  ["lneqq"] = 8808,
  ["lvertneqq"] = {8808, 65024},
  ["lvnE"] = {8808, 65024},
  ["gnE"] = 8809,
  ["gneqq"] = 8809,
  ["gvertneqq"] = {8809, 65024},
  ["gvnE"] = {8809, 65024},
  ["Lt"] = 8810,
  ["NestedLessLess"] = 8810,
  ["NotLessLess"] = {8810, 824},
  ["ll"] = 8810,
  ["nLt"] = {8810, 8402},
  ["nLtv"] = {8810, 824},
  ["Gt"] = 8811,
  ["NestedGreaterGreater"] = 8811,
  ["NotGreaterGreater"] = {8811, 824},
  ["gg"] = 8811,
  ["nGt"] = {8811, 8402},
  ["nGtv"] = {8811, 824},
  ["between"] = 8812,
  ["twixt"] = 8812,
  ["NotCupCap"] = 8813,
  ["NotLess"] = 8814,
  ["nless"] = 8814,
  ["nlt"] = 8814,
  ["NotGreater"] = 8815,
  ["ngt"] = 8815,
  ["ngtr"] = 8815,
  ["NotLessEqual"] = 8816,
  ["nle"] = 8816,
  ["nleq"] = 8816,
  ["NotGreaterEqual"] = 8817,
  ["nge"] = 8817,
  ["ngeq"] = 8817,
  ["LessTilde"] = 8818,
  ["lesssim"] = 8818,
  ["lsim"] = 8818,
  ["GreaterTilde"] = 8819,
  ["gsim"] = 8819,
  ["gtrsim"] = 8819,
  ["NotLessTilde"] = 8820,
  ["nlsim"] = 8820,
  ["NotGreaterTilde"] = 8821,
  ["ngsim"] = 8821,
  ["LessGreater"] = 8822,
  ["lessgtr"] = 8822,
  ["lg"] = 8822,
  ["GreaterLess"] = 8823,
  ["gl"] = 8823,
  ["gtrless"] = 8823,
  ["NotLessGreater"] = 8824,
  ["ntlg"] = 8824,
  ["NotGreaterLess"] = 8825,
  ["ntgl"] = 8825,
  ["Precedes"] = 8826,
  ["pr"] = 8826,
  ["prec"] = 8826,
  ["Succeeds"] = 8827,
  ["sc"] = 8827,
  ["succ"] = 8827,
  ["PrecedesSlantEqual"] = 8828,
  ["prcue"] = 8828,
  ["preccurlyeq"] = 8828,
  ["SucceedsSlantEqual"] = 8829,
  ["sccue"] = 8829,
  ["succcurlyeq"] = 8829,
  ["PrecedesTilde"] = 8830,
  ["precsim"] = 8830,
  ["prsim"] = 8830,
  ["NotSucceedsTilde"] = {8831, 824},
  ["SucceedsTilde"] = 8831,
  ["scsim"] = 8831,
  ["succsim"] = 8831,
  ["NotPrecedes"] = 8832,
  ["npr"] = 8832,
  ["nprec"] = 8832,
  ["NotSucceeds"] = 8833,
  ["nsc"] = 8833,
  ["nsucc"] = 8833,
  ["NotSubset"] = {8834, 8402},
  ["nsubset"] = {8834, 8402},
  ["sub"] = 8834,
  ["subset"] = 8834,
  ["vnsub"] = {8834, 8402},
  ["NotSuperset"] = {8835, 8402},
  ["Superset"] = 8835,
  ["nsupset"] = {8835, 8402},
  ["sup"] = 8835,
  ["supset"] = 8835,
  ["vnsup"] = {8835, 8402},
  ["nsub"] = 8836,
  ["nsup"] = 8837,
  ["SubsetEqual"] = 8838,
  ["sube"] = 8838,
  ["subseteq"] = 8838,
  ["SupersetEqual"] = 8839,
  ["supe"] = 8839,
  ["supseteq"] = 8839,
  ["NotSubsetEqual"] = 8840,
  ["nsube"] = 8840,
  ["nsubseteq"] = 8840,
  ["NotSupersetEqual"] = 8841,
  ["nsupe"] = 8841,
  ["nsupseteq"] = 8841,
  ["subne"] = 8842,
  ["subsetneq"] = 8842,
  ["varsubsetneq"] = {8842, 65024},
  ["vsubne"] = {8842, 65024},
  ["supne"] = 8843,
  ["supsetneq"] = 8843,
  ["varsupsetneq"] = {8843, 65024},
  ["vsupne"] = {8843, 65024},
  ["cupdot"] = 8845,
  ["UnionPlus"] = 8846,
  ["uplus"] = 8846,
  ["NotSquareSubset"] = {8847, 824},
  ["SquareSubset"] = 8847,
  ["sqsub"] = 8847,
  ["sqsubset"] = 8847,
  ["NotSquareSuperset"] = {8848, 824},
  ["SquareSuperset"] = 8848,
  ["sqsup"] = 8848,
  ["sqsupset"] = 8848,
  ["SquareSubsetEqual"] = 8849,
  ["sqsube"] = 8849,
  ["sqsubseteq"] = 8849,
  ["SquareSupersetEqual"] = 8850,
  ["sqsupe"] = 8850,
  ["sqsupseteq"] = 8850,
  ["SquareIntersection"] = 8851,
  ["sqcap"] = 8851,
  ["sqcaps"] = {8851, 65024},
  ["SquareUnion"] = 8852,
  ["sqcup"] = 8852,
  ["sqcups"] = {8852, 65024},
  ["CirclePlus"] = 8853,
  ["oplus"] = 8853,
  ["CircleMinus"] = 8854,
  ["ominus"] = 8854,
  ["CircleTimes"] = 8855,
  ["otimes"] = 8855,
  ["osol"] = 8856,
  ["CircleDot"] = 8857,
  ["odot"] = 8857,
  ["circledcirc"] = 8858,
  ["ocir"] = 8858,
  ["circledast"] = 8859,
  ["oast"] = 8859,
  ["circleddash"] = 8861,
  ["odash"] = 8861,
  ["boxplus"] = 8862,
  ["plusb"] = 8862,
  ["boxminus"] = 8863,
  ["minusb"] = 8863,
  ["boxtimes"] = 8864,
  ["timesb"] = 8864,
  ["dotsquare"] = 8865,
  ["sdotb"] = 8865,
  ["RightTee"] = 8866,
  ["vdash"] = 8866,
  ["LeftTee"] = 8867,
  ["dashv"] = 8867,
  ["DownTee"] = 8868,
  ["top"] = 8868,
  ["UpTee"] = 8869,
  ["bot"] = 8869,
  ["bottom"] = 8869,
  ["perp"] = 8869,
  ["models"] = 8871,
  ["DoubleRightTee"] = 8872,
  ["vDash"] = 8872,
  ["Vdash"] = 8873,
  ["Vvdash"] = 8874,
  ["VDash"] = 8875,
  ["nvdash"] = 8876,
  ["nvDash"] = 8877,
  ["nVdash"] = 8878,
  ["nVDash"] = 8879,
  ["prurel"] = 8880,
  ["LeftTriangle"] = 8882,
  ["vartriangleleft"] = 8882,
  ["vltri"] = 8882,
  ["RightTriangle"] = 8883,
  ["vartriangleright"] = 8883,
  ["vrtri"] = 8883,
  ["LeftTriangleEqual"] = 8884,
  ["ltrie"] = 8884,
  ["nvltrie"] = {8884, 8402},
  ["trianglelefteq"] = 8884,
  ["RightTriangleEqual"] = 8885,
  ["nvrtrie"] = {8885, 8402},
  ["rtrie"] = 8885,
  ["trianglerighteq"] = 8885,
  ["origof"] = 8886,
  ["imof"] = 8887,
  ["multimap"] = 8888,
  ["mumap"] = 8888,
  ["hercon"] = 8889,
  ["intcal"] = 8890,
  ["intercal"] = 8890,
  ["veebar"] = 8891,
  ["barvee"] = 8893,
  ["angrtvb"] = 8894,
  ["lrtri"] = 8895,
  ["Wedge"] = 8896,
  ["bigwedge"] = 8896,
  ["xwedge"] = 8896,
  ["Vee"] = 8897,
  ["bigvee"] = 8897,
  ["xvee"] = 8897,
  ["Intersection"] = 8898,
  ["bigcap"] = 8898,
  ["xcap"] = 8898,
  ["Union"] = 8899,
  ["bigcup"] = 8899,
  ["xcup"] = 8899,
  ["Diamond"] = 8900,
  ["diam"] = 8900,
  ["diamond"] = 8900,
  ["sdot"] = 8901,
  ["Star"] = 8902,
  ["sstarf"] = 8902,
  ["divideontimes"] = 8903,
  ["divonx"] = 8903,
  ["bowtie"] = 8904,
  ["ltimes"] = 8905,
  ["rtimes"] = 8906,
  ["leftthreetimes"] = 8907,
  ["lthree"] = 8907,
  ["rightthreetimes"] = 8908,
  ["rthree"] = 8908,
  ["backsimeq"] = 8909,
  ["bsime"] = 8909,
  ["curlyvee"] = 8910,
  ["cuvee"] = 8910,
  ["curlywedge"] = 8911,
  ["cuwed"] = 8911,
  ["Sub"] = 8912,
  ["Subset"] = 8912,
  ["Sup"] = 8913,
  ["Supset"] = 8913,
  ["Cap"] = 8914,
  ["Cup"] = 8915,
  ["fork"] = 8916,
  ["pitchfork"] = 8916,
  ["epar"] = 8917,
  ["lessdot"] = 8918,
  ["ltdot"] = 8918,
  ["gtdot"] = 8919,
  ["gtrdot"] = 8919,
  ["Ll"] = 8920,
  ["nLl"] = {8920, 824},
  ["Gg"] = 8921,
  ["ggg"] = 8921,
  ["nGg"] = {8921, 824},
  ["LessEqualGreater"] = 8922,
  ["leg"] = 8922,
  ["lesg"] = {8922, 65024},
  ["lesseqgtr"] = 8922,
  ["GreaterEqualLess"] = 8923,
  ["gel"] = 8923,
  ["gesl"] = {8923, 65024},
  ["gtreqless"] = 8923,
  ["cuepr"] = 8926,
  ["curlyeqprec"] = 8926,
  ["cuesc"] = 8927,
  ["curlyeqsucc"] = 8927,
  ["NotPrecedesSlantEqual"] = 8928,
  ["nprcue"] = 8928,
  ["NotSucceedsSlantEqual"] = 8929,
  ["nsccue"] = 8929,
  ["NotSquareSubsetEqual"] = 8930,
  ["nsqsube"] = 8930,
  ["NotSquareSupersetEqual"] = 8931,
  ["nsqsupe"] = 8931,
  ["lnsim"] = 8934,
  ["gnsim"] = 8935,
  ["precnsim"] = 8936,
  ["prnsim"] = 8936,
  ["scnsim"] = 8937,
  ["succnsim"] = 8937,
  ["NotLeftTriangle"] = 8938,
  ["nltri"] = 8938,
  ["ntriangleleft"] = 8938,
  ["NotRightTriangle"] = 8939,
  ["nrtri"] = 8939,
  ["ntriangleright"] = 8939,
  ["NotLeftTriangleEqual"] = 8940,
  ["nltrie"] = 8940,
  ["ntrianglelefteq"] = 8940,
  ["NotRightTriangleEqual"] = 8941,
  ["nrtrie"] = 8941,
  ["ntrianglerighteq"] = 8941,
  ["vellip"] = 8942,
  ["ctdot"] = 8943,
  ["utdot"] = 8944,
  ["dtdot"] = 8945,
  ["disin"] = 8946,
  ["isinsv"] = 8947,
  ["isins"] = 8948,
  ["isindot"] = 8949,
  ["notindot"] = {8949, 824},
  ["notinvc"] = 8950,
  ["notinvb"] = 8951,
  ["isinE"] = 8953,
  ["notinE"] = {8953, 824},
  ["nisd"] = 8954,
  ["xnis"] = 8955,
  ["nis"] = 8956,
  ["notnivc"] = 8957,
  ["notnivb"] = 8958,
  ["barwed"] = 8965,
  ["barwedge"] = 8965,
  ["Barwed"] = 8966,
  ["doublebarwedge"] = 8966,
  ["LeftCeiling"] = 8968,
  ["lceil"] = 8968,
  ["RightCeiling"] = 8969,
  ["rceil"] = 8969,
  ["LeftFloor"] = 8970,
  ["lfloor"] = 8970,
  ["RightFloor"] = 8971,
  ["rfloor"] = 8971,
  ["drcrop"] = 8972,
  ["dlcrop"] = 8973,
  ["urcrop"] = 8974,
  ["ulcrop"] = 8975,
  ["bnot"] = 8976,
  ["profline"] = 8978,
  ["profsurf"] = 8979,
  ["telrec"] = 8981,
  ["target"] = 8982,
  ["ulcorn"] = 8988,
  ["ulcorner"] = 8988,
  ["urcorn"] = 8989,
  ["urcorner"] = 8989,
  ["dlcorn"] = 8990,
  ["llcorner"] = 8990,
  ["drcorn"] = 8991,
  ["lrcorner"] = 8991,
  ["frown"] = 8994,
  ["sfrown"] = 8994,
  ["smile"] = 8995,
  ["ssmile"] = 8995,
  ["cylcty"] = 9005,
  ["profalar"] = 9006,
  ["topbot"] = 9014,
  ["ovbar"] = 9021,
  ["solbar"] = 9023,
  ["angzarr"] = 9084,
  ["lmoust"] = 9136,
  ["lmoustache"] = 9136,
  ["rmoust"] = 9137,
  ["rmoustache"] = 9137,
  ["OverBracket"] = 9140,
  ["tbrk"] = 9140,
  ["UnderBracket"] = 9141,
  ["bbrk"] = 9141,
  ["bbrktbrk"] = 9142,
  ["OverParenthesis"] = 9180,
  ["UnderParenthesis"] = 9181,
  ["OverBrace"] = 9182,
  ["UnderBrace"] = 9183,
  ["trpezium"] = 9186,
  ["elinters"] = 9191,
  ["blank"] = 9251,
  ["circledS"] = 9416,
  ["oS"] = 9416,
  ["HorizontalLine"] = 9472,
  ["boxh"] = 9472,
  ["boxv"] = 9474,
  ["boxdr"] = 9484,
  ["boxdl"] = 9488,
  ["boxur"] = 9492,
  ["boxul"] = 9496,
  ["boxvr"] = 9500,
  ["boxvl"] = 9508,
  ["boxhd"] = 9516,
  ["boxhu"] = 9524,
  ["boxvh"] = 9532,
  ["boxH"] = 9552,
  ["boxV"] = 9553,
  ["boxdR"] = 9554,
  ["boxDr"] = 9555,
  ["boxDR"] = 9556,
  ["boxdL"] = 9557,
  ["boxDl"] = 9558,
  ["boxDL"] = 9559,
  ["boxuR"] = 9560,
  ["boxUr"] = 9561,
  ["boxUR"] = 9562,
  ["boxuL"] = 9563,
  ["boxUl"] = 9564,
  ["boxUL"] = 9565,
  ["boxvR"] = 9566,
  ["boxVr"] = 9567,
  ["boxVR"] = 9568,
  ["boxvL"] = 9569,
  ["boxVl"] = 9570,
  ["boxVL"] = 9571,
  ["boxHd"] = 9572,
  ["boxhD"] = 9573,
  ["boxHD"] = 9574,
  ["boxHu"] = 9575,
  ["boxhU"] = 9576,
  ["boxHU"] = 9577,
  ["boxvH"] = 9578,
  ["boxVh"] = 9579,
  ["boxVH"] = 9580,
  ["uhblk"] = 9600,
  ["lhblk"] = 9604,
  ["block"] = 9608,
  ["blk14"] = 9617,
  ["blk12"] = 9618,
  ["blk34"] = 9619,
  ["Square"] = 9633,
  ["squ"] = 9633,
  ["square"] = 9633,
  ["FilledVerySmallSquare"] = 9642,
  ["blacksquare"] = 9642,
  ["squarf"] = 9642,
  ["squf"] = 9642,
  ["EmptyVerySmallSquare"] = 9643,
  ["rect"] = 9645,
  ["marker"] = 9646,
  ["fltns"] = 9649,
  ["bigtriangleup"] = 9651,
  ["xutri"] = 9651,
  ["blacktriangle"] = 9652,
  ["utrif"] = 9652,
  ["triangle"] = 9653,
  ["utri"] = 9653,
  ["blacktriangleright"] = 9656,
  ["rtrif"] = 9656,
  ["rtri"] = 9657,
  ["triangleright"] = 9657,
  ["bigtriangledown"] = 9661,
  ["xdtri"] = 9661,
  ["blacktriangledown"] = 9662,
  ["dtrif"] = 9662,
  ["dtri"] = 9663,
  ["triangledown"] = 9663,
  ["blacktriangleleft"] = 9666,
  ["ltrif"] = 9666,
  ["ltri"] = 9667,
  ["triangleleft"] = 9667,
  ["loz"] = 9674,
  ["lozenge"] = 9674,
  ["cir"] = 9675,
  ["tridot"] = 9708,
  ["bigcirc"] = 9711,
  ["xcirc"] = 9711,
  ["ultri"] = 9720,
  ["urtri"] = 9721,
  ["lltri"] = 9722,
  ["EmptySmallSquare"] = 9723,
  ["FilledSmallSquare"] = 9724,
  ["bigstar"] = 9733,
  ["starf"] = 9733,
  ["star"] = 9734,
  ["phone"] = 9742,
  ["female"] = 9792,
  ["male"] = 9794,
  ["spades"] = 9824,
  ["spadesuit"] = 9824,
  ["clubs"] = 9827,
  ["clubsuit"] = 9827,
  ["hearts"] = 9829,
  ["heartsuit"] = 9829,
  ["diamondsuit"] = 9830,
  ["diams"] = 9830,
  ["sung"] = 9834,
  ["flat"] = 9837,
  ["natur"] = 9838,
  ["natural"] = 9838,
  ["sharp"] = 9839,
  ["check"] = 10003,
  ["checkmark"] = 10003,
  ["cross"] = 10007,
  ["malt"] = 10016,
  ["maltese"] = 10016,
  ["sext"] = 10038,
  ["VerticalSeparator"] = 10072,
  ["lbbrk"] = 10098,
  ["rbbrk"] = 10099,
  ["bsolhsub"] = 10184,
  ["suphsol"] = 10185,
  ["LeftDoubleBracket"] = 10214,
  ["lobrk"] = 10214,
  ["RightDoubleBracket"] = 10215,
  ["robrk"] = 10215,
  ["LeftAngleBracket"] = 10216,
  ["lang"] = 10216,
  ["langle"] = 10216,
  ["RightAngleBracket"] = 10217,
  ["rang"] = 10217,
  ["rangle"] = 10217,
  ["Lang"] = 10218,
  ["Rang"] = 10219,
  ["loang"] = 10220,
  ["roang"] = 10221,
  ["LongLeftArrow"] = 10229,
  ["longleftarrow"] = 10229,
  ["xlarr"] = 10229,
  ["LongRightArrow"] = 10230,
  ["longrightarrow"] = 10230,
  ["xrarr"] = 10230,
  ["LongLeftRightArrow"] = 10231,
  ["longleftrightarrow"] = 10231,
  ["xharr"] = 10231,
  ["DoubleLongLeftArrow"] = 10232,
  ["Longleftarrow"] = 10232,
  ["xlArr"] = 10232,
  ["DoubleLongRightArrow"] = 10233,
  ["Longrightarrow"] = 10233,
  ["xrArr"] = 10233,
  ["DoubleLongLeftRightArrow"] = 10234,
  ["Longleftrightarrow"] = 10234,
  ["xhArr"] = 10234,
  ["longmapsto"] = 10236,
  ["xmap"] = 10236,
  ["dzigrarr"] = 10239,
  ["nvlArr"] = 10498,
  ["nvrArr"] = 10499,
  ["nvHarr"] = 10500,
  ["Map"] = 10501,
  ["lbarr"] = 10508,
  ["bkarow"] = 10509,
  ["rbarr"] = 10509,
  ["lBarr"] = 10510,
  ["dbkarow"] = 10511,
  ["rBarr"] = 10511,
  ["RBarr"] = 10512,
  ["drbkarow"] = 10512,
  ["DDotrahd"] = 10513,
  ["UpArrowBar"] = 10514,
  ["DownArrowBar"] = 10515,
  ["Rarrtl"] = 10518,
  ["latail"] = 10521,
  ["ratail"] = 10522,
  ["lAtail"] = 10523,
  ["rAtail"] = 10524,
  ["larrfs"] = 10525,
  ["rarrfs"] = 10526,
  ["larrbfs"] = 10527,
  ["rarrbfs"] = 10528,
  ["nwarhk"] = 10531,
  ["nearhk"] = 10532,
  ["hksearow"] = 10533,
  ["searhk"] = 10533,
  ["hkswarow"] = 10534,
  ["swarhk"] = 10534,
  ["nwnear"] = 10535,
  ["nesear"] = 10536,
  ["toea"] = 10536,
  ["seswar"] = 10537,
  ["tosa"] = 10537,
  ["swnwar"] = 10538,
  ["nrarrc"] = {10547, 824},
  ["rarrc"] = 10547,
  ["cudarrr"] = 10549,
  ["ldca"] = 10550,
  ["rdca"] = 10551,
  ["cudarrl"] = 10552,
  ["larrpl"] = 10553,
  ["curarrm"] = 10556,
  ["cularrp"] = 10557,
  ["rarrpl"] = 10565,
  ["harrcir"] = 10568,
  ["Uarrocir"] = 10569,
  ["lurdshar"] = 10570,
  ["ldrushar"] = 10571,
  ["LeftRightVector"] = 10574,
  ["RightUpDownVector"] = 10575,
  ["DownLeftRightVector"] = 10576,
  ["LeftUpDownVector"] = 10577,
  ["LeftVectorBar"] = 10578,
  ["RightVectorBar"] = 10579,
  ["RightUpVectorBar"] = 10580,
  ["RightDownVectorBar"] = 10581,
  ["DownLeftVectorBar"] = 10582,
  ["DownRightVectorBar"] = 10583,
  ["LeftUpVectorBar"] = 10584,
  ["LeftDownVectorBar"] = 10585,
  ["LeftTeeVector"] = 10586,
  ["RightTeeVector"] = 10587,
  ["RightUpTeeVector"] = 10588,
  ["RightDownTeeVector"] = 10589,
  ["DownLeftTeeVector"] = 10590,
  ["DownRightTeeVector"] = 10591,
  ["LeftUpTeeVector"] = 10592,
  ["LeftDownTeeVector"] = 10593,
  ["lHar"] = 10594,
  ["uHar"] = 10595,
  ["rHar"] = 10596,
  ["dHar"] = 10597,
  ["luruhar"] = 10598,
  ["ldrdhar"] = 10599,
  ["ruluhar"] = 10600,
  ["rdldhar"] = 10601,
  ["lharul"] = 10602,
  ["llhard"] = 10603,
  ["rharul"] = 10604,
  ["lrhard"] = 10605,
  ["UpEquilibrium"] = 10606,
  ["udhar"] = 10606,
  ["ReverseUpEquilibrium"] = 10607,
  ["duhar"] = 10607,
  ["RoundImplies"] = 10608,
  ["erarr"] = 10609,
  ["simrarr"] = 10610,
  ["larrsim"] = 10611,
  ["rarrsim"] = 10612,
  ["rarrap"] = 10613,
  ["ltlarr"] = 10614,
  ["gtrarr"] = 10616,
  ["subrarr"] = 10617,
  ["suplarr"] = 10619,
  ["lfisht"] = 10620,
  ["rfisht"] = 10621,
  ["ufisht"] = 10622,
  ["dfisht"] = 10623,
  ["lopar"] = 10629,
  ["ropar"] = 10630,
  ["lbrke"] = 10635,
  ["rbrke"] = 10636,
  ["lbrkslu"] = 10637,
  ["rbrksld"] = 10638,
  ["lbrksld"] = 10639,
  ["rbrkslu"] = 10640,
  ["langd"] = 10641,
  ["rangd"] = 10642,
  ["lparlt"] = 10643,
  ["rpargt"] = 10644,
  ["gtlPar"] = 10645,
  ["ltrPar"] = 10646,
  ["vzigzag"] = 10650,
  ["vangrt"] = 10652,
  ["angrtvbd"] = 10653,
  ["ange"] = 10660,
  ["range"] = 10661,
  ["dwangle"] = 10662,
  ["uwangle"] = 10663,
  ["angmsdaa"] = 10664,
  ["angmsdab"] = 10665,
  ["angmsdac"] = 10666,
  ["angmsdad"] = 10667,
  ["angmsdae"] = 10668,
  ["angmsdaf"] = 10669,
  ["angmsdag"] = 10670,
  ["angmsdah"] = 10671,
  ["bemptyv"] = 10672,
  ["demptyv"] = 10673,
  ["cemptyv"] = 10674,
  ["raemptyv"] = 10675,
  ["laemptyv"] = 10676,
  ["ohbar"] = 10677,
  ["omid"] = 10678,
  ["opar"] = 10679,
  ["operp"] = 10681,
  ["olcross"] = 10683,
  ["odsold"] = 10684,
  ["olcir"] = 10686,
  ["ofcir"] = 10687,
  ["olt"] = 10688,
  ["ogt"] = 10689,
  ["cirscir"] = 10690,
  ["cirE"] = 10691,
  ["solb"] = 10692,
  ["bsolb"] = 10693,
  ["boxbox"] = 10697,
  ["trisb"] = 10701,
  ["rtriltri"] = 10702,
  ["LeftTriangleBar"] = 10703,
  ["NotLeftTriangleBar"] = {10703, 824},
  ["NotRightTriangleBar"] = {10704, 824},
  ["RightTriangleBar"] = 10704,
  ["iinfin"] = 10716,
  ["infintie"] = 10717,
  ["nvinfin"] = 10718,
  ["eparsl"] = 10723,
  ["smeparsl"] = 10724,
  ["eqvparsl"] = 10725,
  ["blacklozenge"] = 10731,
  ["lozf"] = 10731,
  ["RuleDelayed"] = 10740,
  ["dsol"] = 10742,
  ["bigodot"] = 10752,
  ["xodot"] = 10752,
  ["bigoplus"] = 10753,
  ["xoplus"] = 10753,
  ["bigotimes"] = 10754,
  ["xotime"] = 10754,
  ["biguplus"] = 10756,
  ["xuplus"] = 10756,
  ["bigsqcup"] = 10758,
  ["xsqcup"] = 10758,
  ["iiiint"] = 10764,
  ["qint"] = 10764,
  ["fpartint"] = 10765,
  ["cirfnint"] = 10768,
  ["awint"] = 10769,
  ["rppolint"] = 10770,
  ["scpolint"] = 10771,
  ["npolint"] = 10772,
  ["pointint"] = 10773,
  ["quatint"] = 10774,
  ["intlarhk"] = 10775,
  ["pluscir"] = 10786,
  ["plusacir"] = 10787,
  ["simplus"] = 10788,
  ["plusdu"] = 10789,
  ["plussim"] = 10790,
  ["plustwo"] = 10791,
  ["mcomma"] = 10793,
  ["minusdu"] = 10794,
  ["loplus"] = 10797,
  ["roplus"] = 10798,
  ["Cross"] = 10799,
  ["timesd"] = 10800,
  ["timesbar"] = 10801,
  ["smashp"] = 10803,
  ["lotimes"] = 10804,
  ["rotimes"] = 10805,
  ["otimesas"] = 10806,
  ["Otimes"] = 10807,
  ["odiv"] = 10808,
  ["triplus"] = 10809,
  ["triminus"] = 10810,
  ["tritime"] = 10811,
  ["intprod"] = 10812,
  ["iprod"] = 10812,
  ["amalg"] = 10815,
  ["capdot"] = 10816,
  ["ncup"] = 10818,
  ["ncap"] = 10819,
  ["capand"] = 10820,
  ["cupor"] = 10821,
  ["cupcap"] = 10822,
  ["capcup"] = 10823,
  ["cupbrcap"] = 10824,
  ["capbrcup"] = 10825,
  ["cupcup"] = 10826,
  ["capcap"] = 10827,
  ["ccups"] = 10828,
  ["ccaps"] = 10829,
  ["ccupssm"] = 10832,
  ["And"] = 10835,
  ["Or"] = 10836,
  ["andand"] = 10837,
  ["oror"] = 10838,
  ["orslope"] = 10839,
  ["andslope"] = 10840,
  ["andv"] = 10842,
  ["orv"] = 10843,
  ["andd"] = 10844,
  ["ord"] = 10845,
  ["wedbar"] = 10847,
  ["sdote"] = 10854,
  ["simdot"] = 10858,
  ["congdot"] = 10861,
  ["ncongdot"] = {10861, 824},
  ["easter"] = 10862,
  ["apacir"] = 10863,
  ["apE"] = 10864,
  ["napE"] = {10864, 824},
  ["eplus"] = 10865,
  ["pluse"] = 10866,
  ["Esim"] = 10867,
  ["Colone"] = 10868,
  ["Equal"] = 10869,
  ["ddotseq"] = 10871,
  ["eDDot"] = 10871,
  ["equivDD"] = 10872,
  ["ltcir"] = 10873,
  ["gtcir"] = 10874,
  ["ltquest"] = 10875,
  ["gtquest"] = 10876,
  ["LessSlantEqual"] = 10877,
  ["NotLessSlantEqual"] = {10877, 824},
  ["leqslant"] = 10877,
  ["les"] = 10877,
  ["nleqslant"] = {10877, 824},
  ["nles"] = {10877, 824},
  ["GreaterSlantEqual"] = 10878,
  ["NotGreaterSlantEqual"] = {10878, 824},
  ["geqslant"] = 10878,
  ["ges"] = 10878,
  ["ngeqslant"] = {10878, 824},
  ["nges"] = {10878, 824},
  ["lesdot"] = 10879,
  ["gesdot"] = 10880,
  ["lesdoto"] = 10881,
  ["gesdoto"] = 10882,
  ["lesdotor"] = 10883,
  ["gesdotol"] = 10884,
  ["lap"] = 10885,
  ["lessapprox"] = 10885,
  ["gap"] = 10886,
  ["gtrapprox"] = 10886,
  ["lne"] = 10887,
  ["lneq"] = 10887,
  ["gne"] = 10888,
  ["gneq"] = 10888,
  ["lnap"] = 10889,
  ["lnapprox"] = 10889,
  ["gnap"] = 10890,
  ["gnapprox"] = 10890,
  ["lEg"] = 10891,
  ["lesseqqgtr"] = 10891,
  ["gEl"] = 10892,
  ["gtreqqless"] = 10892,
  ["lsime"] = 10893,
  ["gsime"] = 10894,
  ["lsimg"] = 10895,
  ["gsiml"] = 10896,
  ["lgE"] = 10897,
  ["glE"] = 10898,
  ["lesges"] = 10899,
  ["gesles"] = 10900,
  ["els"] = 10901,
  ["eqslantless"] = 10901,
  ["egs"] = 10902,
  ["eqslantgtr"] = 10902,
  ["elsdot"] = 10903,
  ["egsdot"] = 10904,
  ["el"] = 10905,
  ["eg"] = 10906,
  ["siml"] = 10909,
  ["simg"] = 10910,
  ["simlE"] = 10911,
  ["simgE"] = 10912,
  ["LessLess"] = 10913,
  ["NotNestedLessLess"] = {10913, 824},
  ["GreaterGreater"] = 10914,
  ["NotNestedGreaterGreater"] = {10914, 824},
  ["glj"] = 10916,
  ["gla"] = 10917,
  ["ltcc"] = 10918,
  ["gtcc"] = 10919,
  ["lescc"] = 10920,
  ["gescc"] = 10921,
  ["smt"] = 10922,
  ["lat"] = 10923,
  ["smte"] = 10924,
  ["smtes"] = {10924, 65024},
  ["late"] = 10925,
  ["lates"] = {10925, 65024},
  ["bumpE"] = 10926,
  ["NotPrecedesEqual"] = {10927, 824},
  ["PrecedesEqual"] = 10927,
  ["npre"] = {10927, 824},
  ["npreceq"] = {10927, 824},
  ["pre"] = 10927,
  ["preceq"] = 10927,
  ["NotSucceedsEqual"] = {10928, 824},
  ["SucceedsEqual"] = 10928,
  ["nsce"] = {10928, 824},
  ["nsucceq"] = {10928, 824},
  ["sce"] = 10928,
  ["succeq"] = 10928,
  ["prE"] = 10931,
  ["scE"] = 10932,
  ["precneqq"] = 10933,
  ["prnE"] = 10933,
  ["scnE"] = 10934,
  ["succneqq"] = 10934,
  ["prap"] = 10935,
  ["precapprox"] = 10935,
  ["scap"] = 10936,
  ["succapprox"] = 10936,
  ["precnapprox"] = 10937,
  ["prnap"] = 10937,
  ["scnap"] = 10938,
  ["succnapprox"] = 10938,
  ["Pr"] = 10939,
  ["Sc"] = 10940,
  ["subdot"] = 10941,
  ["supdot"] = 10942,
  ["subplus"] = 10943,
  ["supplus"] = 10944,
  ["submult"] = 10945,
  ["supmult"] = 10946,
  ["subedot"] = 10947,
  ["supedot"] = 10948,
  ["nsubE"] = {10949, 824},
  ["nsubseteqq"] = {10949, 824},
  ["subE"] = 10949,
  ["subseteqq"] = 10949,
  ["nsupE"] = {10950, 824},
  ["nsupseteqq"] = {10950, 824},
  ["supE"] = 10950,
  ["supseteqq"] = 10950,
  ["subsim"] = 10951,
  ["supsim"] = 10952,
  ["subnE"] = 10955,
  ["subsetneqq"] = 10955,
  ["varsubsetneqq"] = {10955, 65024},
  ["vsubnE"] = {10955, 65024},
  ["supnE"] = 10956,
  ["supsetneqq"] = 10956,
  ["varsupsetneqq"] = {10956, 65024},
  ["vsupnE"] = {10956, 65024},
  ["csub"] = 10959,
  ["csup"] = 10960,
  ["csube"] = 10961,
  ["csupe"] = 10962,
  ["subsup"] = 10963,
  ["supsub"] = 10964,
  ["subsub"] = 10965,
  ["supsup"] = 10966,
  ["suphsub"] = 10967,
  ["supdsub"] = 10968,
  ["forkv"] = 10969,
  ["topfork"] = 10970,
  ["mlcp"] = 10971,
  ["Dashv"] = 10980,
  ["DoubleLeftTee"] = 10980,
  ["Vdashl"] = 10982,
  ["Barv"] = 10983,
  ["vBar"] = 10984,
  ["vBarv"] = 10985,
  ["Vbar"] = 10987,
  ["Not"] = 10988,
  ["bNot"] = 10989,
  ["rnmid"] = 10990,
  ["cirmid"] = 10991,
  ["midcir"] = 10992,
  ["topcir"] = 10993,
  ["nhpar"] = 10994,
  ["parsim"] = 10995,
  ["nparsl"] = {11005, 8421},
  ["parsl"] = 11005,
  ["fflig"] = 64256,
  ["filig"] = 64257,
  ["fllig"] = 64258,
  ["ffilig"] = 64259,
  ["ffllig"] = 64260,
  ["Ascr"] = 119964,
  ["Cscr"] = 119966,
  ["Dscr"] = 119967,
  ["Gscr"] = 119970,
  ["Jscr"] = 119973,
  ["Kscr"] = 119974,
  ["Nscr"] = 119977,
  ["Oscr"] = 119978,
  ["Pscr"] = 119979,
  ["Qscr"] = 119980,
  ["Sscr"] = 119982,
  ["Tscr"] = 119983,
  ["Uscr"] = 119984,
  ["Vscr"] = 119985,
  ["Wscr"] = 119986,
  ["Xscr"] = 119987,
  ["Yscr"] = 119988,
  ["Zscr"] = 119989,
  ["ascr"] = 119990,
  ["bscr"] = 119991,
  ["cscr"] = 119992,
  ["dscr"] = 119993,
  ["fscr"] = 119995,
  ["hscr"] = 119997,
  ["iscr"] = 119998,
  ["jscr"] = 119999,
  ["kscr"] = 120000,
  ["lscr"] = 120001,
  ["mscr"] = 120002,
  ["nscr"] = 120003,
  ["pscr"] = 120005,
  ["qscr"] = 120006,
  ["rscr"] = 120007,
  ["sscr"] = 120008,
  ["tscr"] = 120009,
  ["uscr"] = 120010,
  ["vscr"] = 120011,
  ["wscr"] = 120012,
  ["xscr"] = 120013,
  ["yscr"] = 120014,
  ["zscr"] = 120015,
  ["Afr"] = 120068,
  ["Bfr"] = 120069,
  ["Dfr"] = 120071,
  ["Efr"] = 120072,
  ["Ffr"] = 120073,
  ["Gfr"] = 120074,
  ["Jfr"] = 120077,
  ["Kfr"] = 120078,
  ["Lfr"] = 120079,
  ["Mfr"] = 120080,
  ["Nfr"] = 120081,
  ["Ofr"] = 120082,
  ["Pfr"] = 120083,
  ["Qfr"] = 120084,
  ["Sfr"] = 120086,
  ["Tfr"] = 120087,
  ["Ufr"] = 120088,
  ["Vfr"] = 120089,
  ["Wfr"] = 120090,
  ["Xfr"] = 120091,
  ["Yfr"] = 120092,
  ["afr"] = 120094,
  ["bfr"] = 120095,
  ["cfr"] = 120096,
  ["dfr"] = 120097,
  ["efr"] = 120098,
  ["ffr"] = 120099,
  ["gfr"] = 120100,
  ["hfr"] = 120101,
  ["ifr"] = 120102,
  ["jfr"] = 120103,
  ["kfr"] = 120104,
  ["lfr"] = 120105,
  ["mfr"] = 120106,
  ["nfr"] = 120107,
  ["ofr"] = 120108,
  ["pfr"] = 120109,
  ["qfr"] = 120110,
  ["rfr"] = 120111,
  ["sfr"] = 120112,
  ["tfr"] = 120113,
  ["ufr"] = 120114,
  ["vfr"] = 120115,
  ["wfr"] = 120116,
  ["xfr"] = 120117,
  ["yfr"] = 120118,
  ["zfr"] = 120119,
  ["Aopf"] = 120120,
  ["Bopf"] = 120121,
  ["Dopf"] = 120123,
  ["Eopf"] = 120124,
  ["Fopf"] = 120125,
  ["Gopf"] = 120126,
  ["Iopf"] = 120128,
  ["Jopf"] = 120129,
  ["Kopf"] = 120130,
  ["Lopf"] = 120131,
  ["Mopf"] = 120132,
  ["Oopf"] = 120134,
  ["Sopf"] = 120138,
  ["Topf"] = 120139,
  ["Uopf"] = 120140,
  ["Vopf"] = 120141,
  ["Wopf"] = 120142,
  ["Xopf"] = 120143,
  ["Yopf"] = 120144,
  ["aopf"] = 120146,
  ["bopf"] = 120147,
  ["copf"] = 120148,
  ["dopf"] = 120149,
  ["eopf"] = 120150,
  ["fopf"] = 120151,
  ["gopf"] = 120152,
  ["hopf"] = 120153,
  ["iopf"] = 120154,
  ["jopf"] = 120155,
  ["kopf"] = 120156,
  ["lopf"] = 120157,
  ["mopf"] = 120158,
  ["nopf"] = 120159,
  ["oopf"] = 120160,
  ["popf"] = 120161,
  ["qopf"] = 120162,
  ["ropf"] = 120163,
  ["sopf"] = 120164,
  ["topf"] = 120165,
  ["uopf"] = 120166,
  ["vopf"] = 120167,
  ["wopf"] = 120168,
  ["xopf"] = 120169,
  ["yopf"] = 120170,
  ["zopf"] = 120171,
}
function entities.dec_entity(s)
  local n = tonumber(s)
  if n == nil then
    return "&#" .. s .. ";"  -- fallback for unknown entities
  end
  return utf8.char(n)
end
function entities.hex_entity(s)
  local n = tonumber("0x"..s)
  if n == nil then
    return "&#x" .. s .. ";"  -- fallback for unknown entities
  end
  return utf8.char(n)
end
function entities.hex_entity_with_x_char(x, s)
  local n = tonumber("0x"..s)
  if n == nil then
    return "&#" .. x .. s .. ";"  -- fallback for unknown entities
  end
  return utf8.char(n)
end
function entities.char_entity(s)
  local code_points = character_entities[s]
  if code_points == nil then
    return "&" .. s .. ";"
  end
  if type(code_points) ~= 'table' then
    code_points = {code_points}
  end
  local char_table = {}
    for _, code_point in ipairs(code_points) do
      table.insert(char_table, utf8.char(code_point))
    end
  return table.concat(char_table)
end
M.writer = {}
local parsers
function M.writer.new(options)
  local self = {}
  self.options = options
  self.flatten_inlines = false
  local slice_specifiers = {}
  for specifier in options.slice:gmatch("[^%s]+") do
    table.insert(slice_specifiers, specifier)
  end

  if #slice_specifiers == 2 then
    self.slice_begin, self.slice_end = table.unpack(slice_specifiers)
    local slice_begin_type = self.slice_begin:sub(1, 1)
    if slice_begin_type ~= "^" and slice_begin_type ~= "$" then
      self.slice_begin = "^" .. self.slice_begin
    end
    local slice_end_type = self.slice_end:sub(1, 1)
    if slice_end_type ~= "^" and slice_end_type ~= "$" then
      self.slice_end = "$" .. self.slice_end
    end
  elseif #slice_specifiers == 1 then
    self.slice_begin = "^" .. slice_specifiers[1]
    self.slice_end = "$" .. slice_specifiers[1]
  end

  self.slice_begin_type = self.slice_begin:sub(1, 1)
  self.slice_begin_identifier = self.slice_begin:sub(2) or ""
  self.slice_end_type = self.slice_end:sub(1, 1)
  self.slice_end_identifier = self.slice_end:sub(2) or ""

  if self.slice_begin == "^" and self.slice_end ~= "^" then
    self.is_writing = true
  else
    self.is_writing = false
  end
  self.space = " "
  self.nbsp = "\\markdownRendererNbsp{}"
  function self.plain(s)
    return s
  end
  function self.paragraph(s)
    if not self.is_writing then return "" end
    return s
  end
  self.interblocksep_text = "\\markdownRendererInterblockSeparator\n{}"
  function self.interblocksep()
    if not self.is_writing then return "" end
    return self.interblocksep_text
  end
  self.paragraphsep_text = "\\markdownRendererParagraphSeparator\n{}"
  function self.paragraphsep()
    if not self.is_writing then return "" end
    return self.paragraphsep_text
  end
  self.undosep_text = "\\markdownRendererUndoSeparator\n{}"
  function self.undosep()
    if not self.is_writing then return "" end
    return self.undosep_text
  end
  self.soft_line_break = function()
    if self.flatten_inlines then return "\n" end
    return "\\markdownRendererSoftLineBreak\n{}"
  end
  self.hard_line_break = function()
    if self.flatten_inlines then return "\n" end
    return "\\markdownRendererHardLineBreak\n{}"
  end
  self.ellipsis = "\\markdownRendererEllipsis{}"
  function self.thematic_break()
    if not self.is_writing then return "" end
    return "\\markdownRendererThematicBreak{}"
  end
  self.escaped_uri_chars = {
    ["{"] = "\\markdownRendererLeftBrace{}",
    ["}"] = "\\markdownRendererRightBrace{}",
    ["\\"] = "\\markdownRendererBackslash{}",
    ["\r"] = " ",
    ["\n"] = " ",
  }
  self.escaped_minimal_strings = {
    ["^^"] = "\\markdownRendererCircumflex"
          .. "\\markdownRendererCircumflex ",
    ["☒"] = "\\markdownRendererTickedBox{}",
    ["⌛"] = "\\markdownRendererHalfTickedBox{}",
    ["☐"] = "\\markdownRendererUntickedBox{}",
    [entities.hex_entity('FFFD')]
      = "\\markdownRendererReplacementCharacter{}",
  }
  self.escaped_strings = util.table_copy(self.escaped_minimal_strings)
  self.escaped_strings[entities.hex_entity('00A0')] = self.nbsp
  self.escaped_chars = {
    ["{"] = "\\markdownRendererLeftBrace{}",
    ["}"] = "\\markdownRendererRightBrace{}",
    ["%"] = "\\markdownRendererPercentSign{}",
    ["\\"] = "\\markdownRendererBackslash{}",
    ["#"] = "\\markdownRendererHash{}",
    ["$"] = "\\markdownRendererDollarSign{}",
    ["&"] = "\\markdownRendererAmpersand{}",
    ["_"] = "\\markdownRendererUnderscore{}",
    ["^"] = "\\markdownRendererCircumflex{}",
    ["~"] = "\\markdownRendererTilde{}",
    ["|"] = "\\markdownRendererPipe{}",
    [entities.hex_entity('0000')]
      = "\\markdownRendererReplacementCharacter{}",
  }
  local function create_escaper(char_escapes, string_escapes)
    local escape = util.escaper(char_escapes, string_escapes)
    return function(s)
      if self.flatten_inlines then return s end
      return escape(s)
    end
  end
  local escape_typographic_text = create_escaper(
    self.escaped_chars, self.escaped_strings)
  local escape_programmatic_text = create_escaper(
    self.escaped_uri_chars, self.escaped_minimal_strings)
  local escape_minimal = create_escaper(
    {}, self.escaped_minimal_strings)
  self.escape = escape_typographic_text
  self.math = escape_minimal
  if options.hybrid then
    self.identifier = escape_minimal
    self.string = escape_minimal
    self.uri = escape_minimal
    self.infostring = escape_minimal
  else
    self.identifier = escape_programmatic_text
    self.string = escape_typographic_text
    self.uri = escape_programmatic_text
    self.infostring = escape_programmatic_text
  end
  function self.warning(t, m)
    return {"\\markdownRendererWarning{", self.escape(t), "}{",
            escape_minimal(t), "}{", self.escape(m or ""), "}{",
            escape_minimal(m or ""), "}"}
  end
  function self.error(t, m)
    return {"\\markdownRendererError{", self.escape(t), "}{",
            escape_minimal(t), "}{", self.escape(m or ""), "}{",
            escape_minimal(m or ""), "}"}
  end
  function self.code(s, attributes)
    if self.flatten_inlines then return s end
    local buf = {}
    if attributes ~= nil then
      table.insert(buf,
                   "\\markdownRendererCodeSpanAttributeContextBegin\n")
      table.insert(buf, self.attributes(attributes))
    end
    table.insert(buf,
                 {"\\markdownRendererCodeSpan{", self.escape(s), "}"})
    if attributes ~= nil then
      table.insert(buf,
                   "\\markdownRendererCodeSpanAttributeContextEnd{}")
    end
    return buf
  end
  function self.link(lab, src, tit, attributes)
    if self.flatten_inlines then return lab end
    local buf = {}
    if attributes ~= nil then
      table.insert(buf,
                   "\\markdownRendererLinkAttributeContextBegin\n")
      table.insert(buf, self.attributes(attributes))
    end
    table.insert(buf, {"\\markdownRendererLink{",lab,"}",
                       "{",self.escape(src),"}",
                       "{",self.uri(src),"}",
                       "{",self.string(tit or ""),"}"})
    if attributes ~= nil then
      table.insert(buf,
                   "\\markdownRendererLinkAttributeContextEnd{}")
    end
    return buf
  end
  function self.image(lab, src, tit, attributes)
    if self.flatten_inlines then return lab end
    local buf = {}
    if attributes ~= nil then
      table.insert(buf,
                   "\\markdownRendererImageAttributeContextBegin\n")
      table.insert(buf, self.attributes(attributes))
    end
    table.insert(buf, {"\\markdownRendererImage{",lab,"}",
                       "{",self.string(src),"}",
                       "{",self.uri(src),"}",
                       "{",tit,"}"})
    if attributes ~= nil then
      table.insert(buf,
                   "\\markdownRendererImageAttributeContextEnd{}")
    end
    return buf
  end
  function self.bulletlist(items,tight)
    if not self.is_writing then return "" end
    local buffer = {}
    for _,item in ipairs(items) do
      if item ~= "" then
        buffer[#buffer + 1] = self.bulletitem(item)
      end
    end
    local contents = util.intersperse(buffer,"\n")
    if tight and options.tightLists then
      return {"\\markdownRendererUlBeginTight\n",contents,
        "\n\\markdownRendererUlEndTight "}
    else
      return {"\\markdownRendererUlBegin\n",contents,
        "\n\\markdownRendererUlEnd "}
    end
  end
  function self.bulletitem(s)
    return {"\\markdownRendererUlItem ",s,
            "\\markdownRendererUlItemEnd "}
  end
  function self.orderedlist(items,tight,startnum)
    if not self.is_writing then return "" end
    local buffer = {}
    local num = startnum
    for _,item in ipairs(items) do
      if item ~= "" then
        buffer[#buffer + 1] = self.ordereditem(item,num)
      end
      if num ~= nil and item ~= "" then
        num = num + 1
      end
    end
    local contents = util.intersperse(buffer,"\n")
    if tight and options.tightLists then
      return {"\\markdownRendererOlBeginTight\n",contents,
              "\n\\markdownRendererOlEndTight "}
    else
      return {"\\markdownRendererOlBegin\n",contents,
              "\n\\markdownRendererOlEnd "}
    end
  end
  function self.ordereditem(s,num)
    if num ~= nil then
      return {"\\markdownRendererOlItemWithNumber{",num,"}",s,
              "\\markdownRendererOlItemEnd "}
    else
      return {"\\markdownRendererOlItem ",s,
              "\\markdownRendererOlItemEnd "}
    end
  end
  function self.inline_html_comment(contents)
    if self.flatten_inlines then return contents end
    return {"\\markdownRendererInlineHtmlComment{",contents,"}"}
  end
  function self.inline_html_tag(contents)
    if self.flatten_inlines then return contents end
    return {"\\markdownRendererInlineHtmlTag{",
            self.string(contents),"}"}
  end
  function self.block_html_element(s)
    if not self.is_writing then return "" end
    local name = util.cache(options.cacheDir, s, nil, nil, ".verbatim")
    return {"\\markdownRendererInputBlockHtmlElement{",name,"}"}
  end
  function self.block_html_cdata_element(s)
    if not self.is_writing then return "" end
    local name = util.cache(options.cacheDir, s, nil, nil, ".verbatim")
    return {"\\markdownRendererInputBlockHtmlCdataElement{",name,"}"}
  end
  function self.block_html_comment(contents)
    if self.flatten_inlines then return contents end
    return {"\\markdownRendererBlockHtmlComment{",contents,"}"}
  end
  function self.block_html_processing_instruction(s)
    if not self.is_writing then return "" end
    local name = util.cache(options.cacheDir, s, nil, nil, ".verbatim")
    return {
      "\\markdownRendererInputBlockHtmlProcessingInstruction{",name,"}"}
  end
  function self.block_html_declaration(s)
    if not self.is_writing then return "" end
    local name = util.cache(options.cacheDir, s, nil, nil, ".verbatim")
    return {
      "\\markdownRendererInputBlockHtmlDeclaration{",name,"}"}
  end
  function self.block_html_cdata_section(s)
    if not self.is_writing then return "" end
    local name = util.cache(options.cacheDir, s, nil, nil, ".verbatim")
    return {"\\markdownRendererInputBlockHtmlCdataSection{",name,"}"}
  end
  function self.block_html_pcdata_element(s)
    if not self.is_writing then return "" end
    local name = util.cache(options.cacheDir, s, nil, nil, ".verbatim")
    return {"\\markdownRendererInputBlockHtmlPcdataElement{",name,"}"}
  end
  function self.block_html_standalone_tag(contents)
    if self.flatten_inlines then return contents end
    return {"\\markdownRendererBlockHtmlStandaloneTag{",
            self.string(contents),"}"}
  end
  function self.inline_html_processing_instruction(contents)
    if self.flatten_inlines then return contents end
    return {"\\markdownRendererInlineHtmlProcessingInstruction{",
            self.string(contents),"}"}
  end
  function self.inline_html_declaration(contents)
    if self.flatten_inlines then return contents end
    return {"\\markdownRendererInlineHtmlDeclaration{",
            self.string(contents),"}"}
  end
  function self.inline_html_cdata_section(contents)
    if self.flatten_inlines then return contents end
    return {"\\markdownRendererInlineHtmlCdataSection{",
            self.string(contents),"}"}
  end
  function self.inline_html_open_tag(contents)
    if self.flatten_inlines then return contents end
    return {"\\markdownRendererInlineHtmlOpenTag{",
            self.string(contents),"}"}
  end
  function self.inline_html_close_tag(contents)
    if self.flatten_inlines then return contents end
    return {"\\markdownRendererInlineHtmlCloseTag{",
            self.string(contents),"}"}
  end
  function self.inline_html_empty_tag(contents)
    if self.flatten_inlines then return contents end
    return {"\\markdownRendererInlineHtmlEmptyTag{",
            self.string(contents),"}"}
  end
  function self.emphasis(s)
    if self.flatten_inlines then return s end
    return {"\\markdownRendererEmphasis{",s,"}"}
  end
  function self.strong(s)
    if self.flatten_inlines then return s end
    return {"\\markdownRendererStrongEmphasis{",s,"}"}
  end
  function self.tickbox(f)
    if f == 1.0 then
      return "☒ "
    elseif f == 0.0 then
      return "☐ "
    else
      return "⌛ "
    end
  end
  function self.blockquote(s)
    if not self.is_writing then return "" end
    return {"\\markdownRendererBlockQuoteBegin\n",s,
      "\\markdownRendererBlockQuoteEnd "}
  end
  function self.verbatim(s)
    if not self.is_writing then return "" end
    s = s:gsub("\n$", "")
    local name = util.cache_verbatim(options.cacheDir, s)
    return {"\\markdownRendererInputVerbatim{",name,"}"}
  end
  function self.document(d)
    local buf = {"\\markdownRendererDocumentBegin\n"}

    -- warn against the `hybrid` option
    if options.hybrid then
      local text = "The `hybrid` option has been soft-deprecated."
      local more = "Consider using one of the following better options "
                .. "for mixing TeX and markdown: `contentBlocks`, "
                .. "`rawAttribute`, `texComments`, `texMathDollars`, "
                .. "`texMathSingleBackslash`, and "
                .. "`texMathDoubleBackslash`. "
                .. "For more information, see the user manual at "
                .. "<https://witiko.github.io/markdown/>."
      table.insert(buf, self.warning(text, more))
    end

    -- insert the text of the document
    table.insert(buf, d)

    -- pop all attributes
    table.insert(buf, self.pop_attributes())

    table.insert(buf, "\\markdownRendererDocumentEnd")

    return buf
  end
  local seen_identifiers = {}
  local key_value_regex = "([^= ]+)%s*=%s*(.*)"
  local function normalize_attributes(attributes, auto_identifiers)
    -- normalize attributes
    local normalized_attributes = {}
    local has_explicit_identifiers = false
    local key, value
    for _, attribute in ipairs(attributes or {}) do
      if attribute:sub(1, 1) == "#" then
        table.insert(normalized_attributes, attribute)
        has_explicit_identifiers = true
        seen_identifiers[attribute:sub(2)] = true
      elseif attribute:sub(1, 1) == "." then
        table.insert(normalized_attributes, attribute)
      else
        key, value = attribute:match(key_value_regex)
        if key:lower() == "id" then
          table.insert(normalized_attributes, "#" .. value)
        elseif key:lower() == "class" then
          local classes = {}
          for class in value:gmatch("%S+") do
            table.insert(classes, class)
          end
          table.sort(classes)
          for _, class in ipairs(classes) do
            table.insert(normalized_attributes, "." .. class)
          end
        else
          table.insert(normalized_attributes, attribute)
        end
      end
    end

    -- if no explicit identifiers exist, add auto identifiers
    if not has_explicit_identifiers and auto_identifiers ~= nil then
      local seen_auto_identifiers = {}
      for _, auto_identifier in ipairs(auto_identifiers) do
        if seen_auto_identifiers[auto_identifier] == nil then
          seen_auto_identifiers[auto_identifier] = true
          if seen_identifiers[auto_identifier] == nil then
            seen_identifiers[auto_identifier] = true
            table.insert(normalized_attributes,
                         "#" .. auto_identifier)
          else
            local auto_identifier_number = 1
            while true do
              local numbered_auto_identifier = auto_identifier .. "-"
                                             .. auto_identifier_number
              if seen_identifiers[numbered_auto_identifier] == nil then
                seen_identifiers[numbered_auto_identifier] = true
                table.insert(normalized_attributes,
                             "#" .. numbered_auto_identifier)
                break
              end
              auto_identifier_number = auto_identifier_number + 1
            end
          end
        end
      end
    end

    -- sort and deduplicate normalized attributes
    table.sort(normalized_attributes)
    local seen_normalized_attributes = {}
    local deduplicated_normalized_attributes = {}
    for _, attribute in ipairs(normalized_attributes) do
      if seen_normalized_attributes[attribute] == nil then
        seen_normalized_attributes[attribute] = true
        table.insert(deduplicated_normalized_attributes, attribute)
      end
    end

    return deduplicated_normalized_attributes
  end

  function self.attributes(attributes, should_normalize_attributes)
    local normalized_attributes
    if should_normalize_attributes == false then
      normalized_attributes = attributes
    else
      normalized_attributes = normalize_attributes(attributes)
    end

    local buf = {}
    local key, value
    for _, attribute in ipairs(normalized_attributes) do
      if attribute:sub(1, 1) == "#" then
        table.insert(buf, {"\\markdownRendererAttributeIdentifier{",
                           attribute:sub(2), "}"})
      elseif attribute:sub(1, 1) == "." then
        table.insert(buf, {"\\markdownRendererAttributeClassName{",
                           attribute:sub(2), "}"})
      else
        key, value = attribute:match(key_value_regex)
        table.insert(buf, {"\\markdownRendererAttributeKeyValue{",
                           key, "}{", value, "}"})
      end
    end

    return buf
  end
  self.active_attributes = {}
  self.attribute_type_levels = {}
  setmetatable(self.attribute_type_levels,
               { __index = function() return 0 end })
  local function apply_attributes()
    local buf = {}
    for i = 1, #self.active_attributes do
      local start_output = self.active_attributes[i][3]
      if start_output ~= nil then
        table.insert(buf, start_output)
      end
    end
    return buf
  end

  local function tear_down_attributes()
    local buf = {}
    for i = #self.active_attributes, 1, -1 do
      local end_output = self.active_attributes[i][4]
      if end_output ~= nil then
        table.insert(buf, end_output)
      end
    end
    return buf
  end
  function self.push_attributes(attribute_type, attributes,
                                start_output, end_output)
    local attribute_type_level
      = self.attribute_type_levels[attribute_type]
    self.attribute_type_levels[attribute_type]
      = attribute_type_level + 1

    -- index attributes in a hash table for easy lookup
    attributes = attributes or {}
    for i = 1, #attributes do
      attributes[attributes[i]] = true
    end

    local buf = {}
    -- handle slicing
    if attributes["#" .. self.slice_end_identifier] ~= nil and
       self.slice_end_type == "^" then
      if self.is_writing then
        table.insert(buf, self.undosep())
        table.insert(buf, tear_down_attributes())
      end
      self.is_writing = false
    end
    if attributes["#" .. self.slice_begin_identifier] ~= nil and
       self.slice_begin_type == "^" then
      table.insert(buf, apply_attributes())
      self.is_writing = true
    end
    if self.is_writing and start_output ~= nil then
      table.insert(buf, start_output)
    end
    table.insert(self.active_attributes,
                 {attribute_type, attributes,
                  start_output, end_output})
    return buf
  end

  function self.pop_attributes(attribute_type)
    local buf = {}
    -- pop attributes until we find attributes of correct type
    -- or until no attributes remain
    local current_attribute_type = false
    while current_attribute_type ~= attribute_type and
          #self.active_attributes > 0 do
      local attributes, _, end_output
      current_attribute_type, attributes, _, end_output = table.unpack(
        self.active_attributes[#self.active_attributes])
      local attribute_type_level
        = self.attribute_type_levels[current_attribute_type]
      self.attribute_type_levels[current_attribute_type]
        = attribute_type_level - 1
      if self.is_writing and end_output ~= nil then
        table.insert(buf, end_output)
      end
      table.remove(self.active_attributes, #self.active_attributes)
      -- handle slicing
      if attributes["#" .. self.slice_end_identifier] ~= nil
         and self.slice_end_type == "$" then
        if self.is_writing then
          table.insert(buf, self.undosep())
          table.insert(buf, tear_down_attributes())
        end
        self.is_writing = false
      end
      if attributes["#" .. self.slice_begin_identifier] ~= nil and
         self.slice_begin_type == "$" then
        self.is_writing = true
        table.insert(buf, apply_attributes())
      end
    end
    return buf
  end
  local function create_auto_identifier(s)
    local buffer = {}
    local prev_space = false
    local letter_found = false
    local normalized_s = s
    if not options.unicodeNormalization
       or options.unicodeNormalizationForm ~= "nfc" then
      normalized_s = util.normalize(normalized_s, "nfc")
    end

    for _, code in utf8.codes(normalized_s) do
      local char = utf8.char(code)

      -- Remove everything up to the first letter.
      if not letter_found then
        local is_letter = lpeg.match(
          parsers.unicode.alpha,
          char
        )
        if is_letter then
          letter_found = true
        else
          goto continue
        end
      end

      -- Remove all non-alphanumeric characters, except underscores,
      -- hyphens, and periods.
      if not lpeg.match(
        ( parsers.underscore
        + parsers.dash
        + parsers.period
        + parsers.unicode.word
        + #parsers.unicode.whitespace ),
        char
      ) then
        goto continue
      end

      -- Replace all spaces and newlines with hyphens.
      if lpeg.match(
        ( parsers.newline
        + #parsers.unicode.whitespace ),
        char
      ) then
        char = "-"
        if prev_space then
          goto continue
        else
          prev_space = true
        end
      else
        -- Case-fold all alphabetic characters.
        local form = nil
        if options.unicodeNormalization then
          form = options.unicodeNormalizationForm
        end
        char = util.casefold(char, form)
        prev_space = false
      end

      table.insert(buffer, char)

      ::continue::
    end

    if prev_space then
      table.remove(buffer)
    end

    local identifier = #buffer == 0 and "section"
                    or table.concat(buffer, "")
    return identifier
  end
  local function create_gfm_auto_identifier(s)
    local buffer = {}
    local prev_space = false
    local letter_found = false
    local normalized_s = s
    if not options.unicodeNormalization
       or options.unicodeNormalizationForm ~= "nfc" then
      normalized_s = util.normalize(normalized_s, "nfc")
    end

    for _, code in utf8.codes(normalized_s) do
      local char = utf8.char(code)

      -- Remove everything up to the first non-space.
      if not letter_found then
        local is_letter = not lpeg.match(
          #parsers.unicode.whitespace,
          char
        )
        if is_letter then
          letter_found = true
        else
          goto continue
        end
      end

      -- Remove all non-alphanumeric characters, except underscores
      -- and hyphens.
      if not lpeg.match(
        ( parsers.underscore
        + parsers.dash
        + parsers.unicode.word
        + #parsers.unicode.whitespace ),
        char
      ) then
        prev_space = false
        goto continue
      end

      -- Replace all spaces and newlines with hyphens.
      if lpeg.match(
        ( parsers.newline
        + #parsers.unicode.whitespace ),
        char
      ) then
        char = "-"
        if prev_space then
          goto continue
        else
          prev_space = true
        end
      else
        -- Case-fold all alphabetic characters.
        local form = nil
        if options.unicodeNormalization then
          form = options.unicodeNormalizationForm
        end
        char = util.casefold(char, form)
        prev_space = false
      end

      table.insert(buffer, char)

      ::continue::
    end

    if prev_space then
      table.remove(buffer)
    end

    local identifier = #buffer == 0 and "section"
                    or table.concat(buffer, "")
    return identifier
  end
  self.secbegin_text = "\\markdownRendererSectionBegin\n"
  self.secend_text = "\n\\markdownRendererSectionEnd "
  function self.heading(s, level, attributes)
    local buf = {}
    local flat_text, inlines = table.unpack(s)

    -- push empty attributes for implied sections
    while self.attribute_type_levels["heading"] < level - 1 do
      table.insert(buf,
                   self.push_attributes("heading",
                                        nil,
                                        self.secbegin_text,
                                        self.secend_text))
    end

    -- pop attributes for sections that have ended
    while self.attribute_type_levels["heading"] >= level do
      table.insert(buf, self.pop_attributes("heading"))
    end

    -- construct attributes for the new section
    local auto_identifiers = {}
    if self.options.autoIdentifiers then
      table.insert(auto_identifiers, create_auto_identifier(flat_text))
    end
    if self.options.gfmAutoIdentifiers then
      table.insert(auto_identifiers,
                   create_gfm_auto_identifier(flat_text))
    end
    local normalized_attributes = normalize_attributes(attributes,
                                                       auto_identifiers)

    -- push attributes for the new section
    local start_output = {}
    local end_output = {}
    table.insert(start_output, self.secbegin_text)
    table.insert(end_output, self.secend_text)

    table.insert(buf, self.push_attributes("heading",
                                           normalized_attributes,
                                           start_output,
                                           end_output))
    assert(self.attribute_type_levels["heading"] == level)

    -- render the heading and its attributes
    if self.is_writing and #normalized_attributes > 0 then
      table.insert(buf,
                   "\\markdownRendererHeaderAttributeContextBegin\n")
      table.insert(buf, self.attributes(normalized_attributes, false))
    end

    local cmd
    level = level + options.shiftHeadings
    if level <= 1 then
      cmd = "\\markdownRendererHeadingOne"
    elseif level == 2 then
      cmd = "\\markdownRendererHeadingTwo"
    elseif level == 3 then
      cmd = "\\markdownRendererHeadingThree"
    elseif level == 4 then
      cmd = "\\markdownRendererHeadingFour"
    elseif level == 5 then
      cmd = "\\markdownRendererHeadingFive"
    elseif level >= 6 then
      cmd = "\\markdownRendererHeadingSix"
    else
      cmd = ""
    end
    if self.is_writing then
      table.insert(buf, {cmd, "{", inlines, "}"})
    end

    if self.is_writing and #normalized_attributes > 0 then
      table.insert(buf, "\\markdownRendererHeaderAttributeContextEnd{}")
    end

    return buf
  end
  function self.get_state()
    return {
      is_writing=self.is_writing,
      flatten_inlines=self.flatten_inlines,
      active_attributes={table.unpack(self.active_attributes)},
    }
  end
  function self.set_state(s)
    local previous_state = self.get_state()
    for key, value in pairs(s) do
      self[key] = value
    end
    return previous_state
  end
  function self.defer_call(f)
    local previous_state = self.get_state()
    return function(...)
      local state = self.set_state(previous_state)
      local return_value = f(...)
      self.set_state(state)
      return return_value
    end
  end

  return self
end
parsers                        = {}
parsers.percent                = P("%")
parsers.at                     = P("@")
parsers.comma                  = P(",")
parsers.asterisk               = P("*")
parsers.dash                   = P("-")
parsers.plus                   = P("+")
parsers.underscore             = P("_")
parsers.period                 = P(".")
parsers.hash                   = P("#")
parsers.dollar                 = P("$")
parsers.ampersand              = P("&")
parsers.backtick               = P("`")
parsers.less                   = P("<")
parsers.more                   = P(">")
parsers.space                  = P(" ")
parsers.squote                 = P("'")
parsers.dquote                 = P('"')
parsers.lparent                = P("(")
parsers.rparent                = P(")")
parsers.lbracket               = P("[")
parsers.rbracket               = P("]")
parsers.lbrace                 = P("{")
parsers.rbrace                 = P("}")
parsers.circumflex             = P("^")
parsers.slash                  = P("/")
parsers.equal                  = P("=")
parsers.colon                  = P(":")
parsers.semicolon              = P(";")
parsers.exclamation            = P("!")
parsers.pipe                   = P("|")
parsers.tilde                  = P("~")
parsers.backslash              = P("\\")
parsers.tab                    = P("\t")
parsers.newline                = P("\n")

parsers.digit                  = R("09")
parsers.hexdigit               = R("09","af","AF")
parsers.letter                 = R("AZ","az")
parsers.alphanumeric           = R("AZ","az","09")
parsers.keyword                = parsers.letter
                               * (parsers.alphanumeric + parsers.dash)^0

parsers.doubleasterisks        = P("**")
parsers.doubleunderscores      = P("__")
parsers.doubletildes           = P("~~")
parsers.fourspaces             = P("    ")

parsers.any                    = P(1)
parsers.eof                    = P(-1)
parsers.succeed                = P(true)
parsers.fail                   = P(false)

parsers.internal_punctuation   = S(":;,.?")
parsers.ascii_punctuation      = S("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~")

parsers.escapable              = parsers.ascii_punctuation
parsers.anyescaped             = parsers.backslash / ""
                               * parsers.escapable
                               + parsers.any

parsers.spacechar              = S("\t ")
parsers.spacing                = S(" \n\r\t")
parsers.nonspacechar           = parsers.any - parsers.spacing
parsers.optionalspace          = parsers.spacechar^0

parsers.normalchar             = parsers.any - (V("SpecialChar")
                                                + parsers.spacing)
parsers.nonindentspace         = parsers.space^-3 * - parsers.spacechar
parsers.indent                 = parsers.space^-3 * parsers.tab
                               + parsers.fourspaces / ""
parsers.linechar               = P(1 - parsers.newline)

parsers.blankline              = parsers.optionalspace
                               * parsers.newline / "\n"
parsers.blanklines             = parsers.blankline^0
parsers.skipblanklines         = ( parsers.optionalspace
                                 * parsers.newline)^0
parsers.indentedline           = parsers.indent    /""
                               * C( parsers.linechar^1
                                  * parsers.newline^-1)
parsers.optionallyindentedline = parsers.indent^-1 /""
                               * C( parsers.linechar^1
                                  * parsers.newline^-1)
parsers.sp                     = parsers.spacing^0
parsers.spnl                   = parsers.optionalspace
                               * ( parsers.newline
                                 * parsers.optionalspace)^-1
parsers.line                   = parsers.linechar^0 * parsers.newline
parsers.nonemptyline           = parsers.line - parsers.blankline

parsers.unicode = {}
parsers.unicode.preceding_punctuation = parsers.fail
parsers.unicode.punctuation = parsers.fail
parsers.unicode.alpha = parsers.fail
parsers.unicode.numeric = parsers.fail
parsers.unicode.word = parsers.fail
parsers.unicode.preceding_whitespace = parsers.fail
parsers.unicode.whitespace = parsers.fail
for n = 1, 4 do
  local punctuation_of_length_n
    = unicode_data.categories.P[n]
    + unicode_data.categories.S[n]
   parsers.unicode.preceding_punctuation
    = parsers.unicode.preceding_punctuation
    + B(punctuation_of_length_n)
   parsers.unicode.punctuation
    = parsers.unicode.punctuation
    + punctuation_of_length_n
  local alpha_of_length_n = unicode_data.categories.L[n]
  parsers.unicode.alpha
    = parsers.unicode.alpha
    + alpha_of_length_n
  local numeric_of_length_n = unicode_data.categories.N[n]
  parsers.unicode.numeric
    = parsers.unicode.numeric
    + numeric_of_length_n
  local word_of_length_n
    = alpha_of_length_n
    + numeric_of_length_n
    + unicode_data.categories.Pc[n]
  parsers.unicode.word
    = parsers.unicode.word
    + word_of_length_n
  local whitespace_of_length_n = unicode_data.categories.Z[n]
  if n == 1 then
    whitespace_of_length_n
      = whitespace_of_length_n
      + R("\t\r")
  end
  parsers.unicode.preceding_whitespace
    = parsers.unicode.preceding_whitespace
    + B(whitespace_of_length_n)
  parsers.unicode.whitespace
    = parsers.unicode.whitespace
    + whitespace_of_length_n
end

parsers.leader      = parsers.space^-3

local function has_trail(indent_table)
  return indent_table ~= nil and
    indent_table.trail ~= nil and
    next(indent_table.trail) ~= nil
end

local function has_indents(indent_table)
  return indent_table ~= nil and
    indent_table.indents ~= nil and
    next(indent_table.indents) ~= nil
end

local function add_trail(indent_table, trail_info)
  indent_table.trail = trail_info
  return indent_table
end

local function remove_trail(indent_table)
  indent_table.trail = nil
  return indent_table
end

local function update_indent_table(indent_table, new_indent, add)
  indent_table = remove_trail(indent_table)

  if not has_indents(indent_table) then
    indent_table.indents = {}
  end

  if add then
    indent_table.indents[#indent_table.indents + 1] = new_indent
  else
    if indent_table.indents[#indent_table.indents].name
       == new_indent.name then
      indent_table.indents[#indent_table.indents] = nil
    end
  end

  return indent_table
end

local function remove_indent(name)
  local remove_indent_level =
    function(s, i, indent_table) -- luacheck: ignore s i
      indent_table = update_indent_table(indent_table, {name=name},
                                         false)
      return true, indent_table
    end

  return Cg(Cmt(Cb("indent_info"), remove_indent_level), "indent_info")
end

local function process_starter_spacing(indent, spacing,
                                       minimum, left_strip_length)
  left_strip_length = left_strip_length or 0

  local count = 0
  local tab_value = 4 - (indent) % 4

  local code_started, minimum_found = false, false
  local code_start, minimum_remainder = "", ""

  local left_total_stripped = 0
  local full_remainder = ""

  if spacing ~= nil then
    for i = 1, #spacing do
      local character = spacing:sub(i, i)

      if character == "\t" then
        count = count + tab_value
        tab_value = 4
      elseif character == " " then
        count = count + 1
        tab_value = 4 - (1 - tab_value) % 4
      end

      if (left_strip_length ~= 0) then
        local possible_to_strip = math.min(count, left_strip_length)
        count = count - possible_to_strip
        left_strip_length = left_strip_length - possible_to_strip
        left_total_stripped = left_total_stripped + possible_to_strip
      else
        full_remainder =  full_remainder .. character
      end

      if (minimum_found) then
        minimum_remainder = minimum_remainder .. character
      elseif (count >= minimum) then
        minimum_found = true
        minimum_remainder = minimum_remainder
                         .. string.rep(" ", count - minimum)
      end

      if (code_started) then
        code_start = code_start .. character
      elseif (count >= minimum + 4) then
        code_started = true
        code_start = code_start
                  .. string.rep(" ", count - (minimum + 4))
      end
    end
  end

  local remainder
  if (code_started) then
    remainder = code_start
  else
    remainder = string.rep(" ", count - minimum)
  end

  local is_minimum = count >= minimum
  return {
    is_code = code_started,
    remainder = remainder,
    left_total_stripped = left_total_stripped,
    is_minimum = is_minimum,
    minimum_remainder = minimum_remainder,
    total_length = count,
    full_remainder = full_remainder
  }
end

local function count_indent_tab_level(indent_table)
  local count = 0
  if not has_indents(indent_table) then
    return count
  end

  for i=1, #indent_table.indents do
    count = count + indent_table.indents[i].length
  end
  return count
end

local function total_delimiter_length(delimiter)
  local count = 0
  if type(delimiter) == "string" then return #delimiter end
  for _, value in pairs(delimiter) do
    count = count + total_delimiter_length(value)
  end
  return count
end

local function process_starter_indent(_, _, indent_table, starter,
                                      is_blank, indent_type, breakable)
  local last_trail = starter[1]
  local delimiter = starter[2]
  local raw_new_trail = starter[3]

  if indent_type == "bq" and not breakable then
    indent_table.ignore_blockquote_blank = true
  end

  if has_trail(indent_table) then
    local trail = indent_table.trail
    if trail.is_code then
      return false
    end
    last_trail = trail.remainder
  else
    local sp = process_starter_spacing(0, last_trail, 0, 0)

    if sp.is_code then
      return false
    end
    last_trail = sp.remainder
  end

  local preceding_indentation = count_indent_tab_level(indent_table) % 4
  local last_trail_length = #last_trail
  local delimiter_length = total_delimiter_length(delimiter)

  local total_indent_level = preceding_indentation + last_trail_length
                           + delimiter_length

  local sp = {}
  if not is_blank then
    sp = process_starter_spacing(total_indent_level, raw_new_trail,
                                 0, 1)
  end

  local del_trail_length = sp.left_total_stripped
  if is_blank then
    del_trail_length = 1
  elseif not sp.is_code then
    del_trail_length = del_trail_length + #sp.remainder
  end

  local indent_length = last_trail_length + delimiter_length
                      + del_trail_length
  local new_indent_info = {name=indent_type, length=indent_length}

  indent_table = update_indent_table(indent_table, new_indent_info,
                                     true)
  indent_table = add_trail(indent_table,
                           {is_code=sp.is_code,
                            remainder=sp.remainder,
                            total_length=sp.total_length,
                            full_remainder=sp.full_remainder})

  return true, indent_table
end

local function decode_pattern(name)
  local delimeter = parsers.succeed
  if name == "bq" then
    delimeter = parsers.more
  end

  return C(parsers.optionalspace) * C(delimeter)
       * C(parsers.optionalspace) * Cp()
end

local function left_blank_starter(indent_table)
  local blank_starter_index

  if not has_indents(indent_table) then
    return
  end

  for i = #indent_table.indents,1,-1 do
    local value = indent_table.indents[i]
    if value.name == "li" then
      blank_starter_index = i
    else
      break
    end
  end

  return blank_starter_index
end

local function traverse_indent(s, i, indent_table, is_optional,
                               is_blank, current_line_indents)
  local new_index = i

  local preceding_indentation = 0
  local current_trail = {}

  local blank_starter = left_blank_starter(indent_table)

  if current_line_indents == nil then
    current_line_indents = {}
  end

  for index = 1,#indent_table.indents do
    local value = indent_table.indents[index]
    local pattern = decode_pattern(value.name)

    -- match decoded pattern
    local new_indent_info = lpeg.match(Ct(pattern), s, new_index)
    if new_indent_info == nil then
      local blankline_end = lpeg.match(
        Ct(parsers.blankline * Cg(Cp(), "pos")), s, new_index)
      if is_optional or not indent_table.ignore_blockquote_blank
         or not blankline_end then
        return is_optional, new_index, current_trail,
               current_line_indents
      end

      return traverse_indent(s, tonumber(blankline_end.pos),
                             indent_table, is_optional, is_blank,
                             current_line_indents)
    end

    local raw_last_trail = new_indent_info[1]
    local delimiter = new_indent_info[2]
    local raw_new_trail = new_indent_info[3]
    local next_index = new_indent_info[4]

    local space_only = delimiter == ""

    -- check previous trail
    if not space_only and next(current_trail) == nil then
      local sp = process_starter_spacing(0, raw_last_trail, 0, 0)
      current_trail = {is_code=sp.is_code, remainder=sp.remainder,
                       total_length=sp.total_length,
                       full_remainder=sp.full_remainder}
    end

    if next(current_trail) ~= nil then
      if not space_only and current_trail.is_code then
        return is_optional, new_index, current_trail,
               current_line_indents
      end
      if current_trail.internal_remainder ~= nil then
        raw_last_trail = current_trail.internal_remainder
      end
    end

    local raw_last_trail_length = 0
    local delimiter_length = 0

    if not space_only then
      delimiter_length = #delimiter
      raw_last_trail_length = #raw_last_trail
    end

    local total_indent_level = preceding_indentation
                             + raw_last_trail_length + delimiter_length

    local spacing_to_process
    local minimum = 0
    local left_strip_length = 0

    if not space_only then
      spacing_to_process = raw_new_trail
      left_strip_length = 1
    else
      spacing_to_process = raw_last_trail
      minimum = value.length
    end

    local sp = process_starter_spacing(total_indent_level,
                                       spacing_to_process, minimum,
                                       left_strip_length)

    if space_only and not sp.is_minimum then
      return is_optional or (is_blank and blank_starter <= index),
             new_index, current_trail, current_line_indents
    end

    local indent_length = raw_last_trail_length + delimiter_length
                        + sp.left_total_stripped

    -- update info for the next pattern
    if not space_only then
      preceding_indentation = preceding_indentation + indent_length
    else
      preceding_indentation = preceding_indentation + value.length
    end

    current_trail = {is_code=sp.is_code, remainder=sp.remainder,
                     internal_remainder=sp.minimum_remainder,
                     total_length=sp.total_length,
                     full_remainder=sp.full_remainder}

    current_line_indents[#current_line_indents + 1] = new_indent_info
    new_index = next_index
  end

  return true, new_index, current_trail, current_line_indents
end

local function check_trail(expect_code, is_code)
  return (expect_code and is_code) or (not expect_code and not is_code)
end

local check_trail_joined =
  function(s, i, indent_table, -- luacheck: ignore s i
           spacing, expect_code, omit_remainder)
    local is_code
    local remainder

    if has_trail(indent_table) then
      local trail = indent_table.trail
      is_code = trail.is_code
      if is_code then
        remainder = trail.remainder
      else
        remainder = trail.full_remainder
      end
    else
      local sp = process_starter_spacing(0, spacing, 0, 0)
      is_code = sp.is_code
      if is_code then
        remainder = sp.remainder
      else
        remainder = sp.full_remainder
      end
    end

    local result = check_trail(expect_code, is_code)
    if omit_remainder then
      return result
    end
    return result, remainder
  end

local check_trail_length =
  function(s, i, indent_table, -- luacheck: ignore s i
           spacing, min, max)
    local trail

    if has_trail(indent_table) then
      trail = indent_table.trail
    else
      trail = process_starter_spacing(0, spacing, 0, 0)
    end

    local total_length = trail.total_length
    if total_length == nil then
      return false
    end

    return min <= total_length and total_length <= max
  end

local function check_continuation_indentation(s, i, indent_table,
                                              is_optional, is_blank)
  if not has_indents(indent_table) then
    return true
  end

  local passes, new_index, current_trail, current_line_indents =
    traverse_indent(s, i, indent_table, is_optional, is_blank)

  if passes then
    indent_table.current_line_indents = current_line_indents
    indent_table = add_trail(indent_table, current_trail)
    return new_index, indent_table
  end
  return false
end

local function get_last_indent_name(indent_table)
  if has_indents(indent_table) then
    return indent_table.indents[#indent_table.indents].name
  end
end

local function remove_remainder_if_blank(indent_table, remainder)
  if get_last_indent_name(indent_table) == "li" then
    return ""
  end
  return remainder
end

local check_trail_type =
  function(s, i, -- luacheck: ignore s i
           trail, spacing, trail_type)
    if trail == nil then
      trail = process_starter_spacing(0, spacing, 0, 0)
    end

    if trail_type == "non-code" then
      return check_trail(false, trail.is_code)
    end
    if trail_type == "code" then
      return check_trail(true, trail.is_code)
    end
    if trail_type == "full-code" then
      if (trail.is_code) then
        return i, trail.remainder
      end
      return i, ""
    end
    if trail_type == "full-any" then
      return i, trail.internal_remainder
    end
  end

local trail_freezing =
  function(s, i, -- luacheck: ignore s i
           indent_table, is_freezing)
    if is_freezing then
      if indent_table.is_trail_frozen then
        indent_table.trail = indent_table.frozen_trail
      else
        indent_table.frozen_trail = indent_table.trail
        indent_table.is_trail_frozen = true
      end
    else
      indent_table.frozen_trail = nil
      indent_table.is_trail_frozen = false
    end
    return true, indent_table
  end

local check_continuation_indentation_and_trail =
  function (s, i, indent_table, is_optional, is_blank, trail_type,
            reset_rem, omit_remainder)
    if not has_indents(indent_table) then
      local spacing, new_index = lpeg.match( C(parsers.spacechar^0)
                                           * Cp(), s, i)
      local result, remainder = check_trail_type(s, i,
        indent_table.trail, spacing, trail_type)
      if remainder == nil then
        if result then
          return new_index
        end
        return false
      end
      if result then
        return new_index, remainder
      end
      return false
    end

    local passes, new_index, current_trail = traverse_indent(s, i,
      indent_table, is_optional, is_blank)

    if passes then
      local spacing
      if current_trail == nil then
        local newer_spacing, newer_index = lpeg.match(
          C(parsers.spacechar^0) * Cp(), s, i)
        current_trail = process_starter_spacing(0, newer_spacing, 0, 0)
        new_index = newer_index
        spacing = newer_spacing
      else
        spacing = current_trail.remainder
      end
      local result, remainder = check_trail_type(s, new_index,
        current_trail, spacing, trail_type)
      if remainder == nil or omit_remainder then
        if result then
          return new_index
        end
        return false
      end

      if is_blank and reset_rem then
        remainder = remove_remainder_if_blank(indent_table, remainder)
      end
      if result then
        return new_index, remainder
      end
      return false
    end
    return false
  end

parsers.check_trail = Cmt( Cb("indent_info") * C(parsers.spacechar^0)
                         * Cc(false), check_trail_joined)

parsers.check_trail_no_rem = Cmt( Cb("indent_info")
                                * C(parsers.spacechar^0) * Cc(false)
                                * Cc(true), check_trail_joined)

parsers.check_code_trail  = Cmt( Cb("indent_info")
                               * C(parsers.spacechar^0)
                               * Cc(true), check_trail_joined)

parsers.check_trail_length_range  = function(min, max)
  return Cmt( Cb("indent_info") * C(parsers.spacechar^0) * Cc(min)
            * Cc(max), check_trail_length)
end

parsers.check_trail_length = function(n)
  return parsers.check_trail_length_range(n, n)
end

parsers.freeze_trail = Cg( Cmt(Cb("indent_info")
                         * Cc(true), trail_freezing), "indent_info")

parsers.unfreeze_trail = Cg(Cmt(Cb("indent_info") * Cc(false),
                            trail_freezing), "indent_info")

parsers.check_minimal_indent = Cmt(Cb("indent_info") * Cc(false),
                                   check_continuation_indentation)

parsers.check_optional_indent = Cmt(Cb("indent_info") * Cc(true),
                                    check_continuation_indentation)

parsers.check_minimal_blank_indent
  = Cmt( Cb("indent_info") * Cc(false)
       * Cc(true)
       , check_continuation_indentation)


parsers.check_minimal_indent_and_trail =
  Cmt( Cb("indent_info")
     * Cc(false) * Cc(false) * Cc("non-code") * Cc(true)
     , check_continuation_indentation_and_trail)

parsers.check_minimal_indent_and_code_trail =
  Cmt( Cb("indent_info")
     * Cc(false) * Cc(false) * Cc("code") * Cc(false)
     , check_continuation_indentation_and_trail)

parsers.check_minimal_blank_indent_and_full_code_trail =
  Cmt( Cb("indent_info")
     * Cc(false) * Cc(true) * Cc("full-code") * Cc(true)
     , check_continuation_indentation_and_trail)

parsers.check_minimal_indent_and_any_trail =
  Cmt( Cb("indent_info")
     * Cc(false) * Cc(false) * Cc("full-any") * Cc(true) * Cc(false)
     , check_continuation_indentation_and_trail)

parsers.check_minimal_blank_indent_and_any_trail =
  Cmt( Cb("indent_info")
     * Cc(false) * Cc(true) * Cc("full-any") * Cc(true) * Cc(false)
     , check_continuation_indentation_and_trail)

parsers.check_minimal_blank_indent_and_any_trail_no_rem =
  Cmt( Cb("indent_info")
     * Cc(false) * Cc(true) * Cc("full-any") * Cc(true) * Cc(true)
     , check_continuation_indentation_and_trail)

parsers.check_optional_indent_and_any_trail =
  Cmt( Cb("indent_info")
     * Cc(true) * Cc(false) * Cc("full-any") * Cc(true) * Cc(false)
     , check_continuation_indentation_and_trail)

parsers.check_optional_blank_indent_and_any_trail =
  Cmt( Cb("indent_info")
     * Cc(true) * Cc(true) * Cc("full-any") * Cc(true) * Cc(false)
     , check_continuation_indentation_and_trail)


parsers.spnlc_noexc = parsers.optionalspace
                    * ( parsers.newline
                      * parsers.check_minimal_indent_and_any_trail)^-1

parsers.spnlc = parsers.optionalspace
              * (V("EndlineNoSub"))^-1

parsers.spnlc_sep  = parsers.optionalspace * V("EndlineNoSub")
                   + parsers.spacechar^1

parsers.only_blank = parsers.spacechar^0
                   * (parsers.newline + parsers.eof)

parsers.commented_line_letter  = parsers.linechar
                               + parsers.newline
                               - parsers.backslash
                               - parsers.percent
parsers.commented_line = Cg(Cc(""), "backslashes")
                       * Cg(Cc(true), "pure_comment")
                       * ((#(parsers.commented_line_letter
                            - parsers.newline)
                          * Cb("backslashes")
                          * Cs(parsers.commented_line_letter
                            - parsers.newline)^1  -- initial
                          * Cg(Cc(""), "backslashes")
                          * Cg(Cc(false), "pure_comment"))
                         + #( parsers.backslash
                            * (parsers.backslash + parsers.newline))
                         * Cg((parsers.backslash  -- even backslash
                              * ( parsers.backslash
                                + #parsers.newline))^1, "backslashes")
                         * Cg(Cc(false), "pure_comment")
                         + (parsers.backslash
                           * (#parsers.percent
                             * Cb("backslashes")
                             / function(backslashes)
                               return string.rep("\\", #backslashes / 2)
                             end
                             * C(parsers.percent)
                             + #parsers.commented_line_letter
                             * Cb("backslashes")
                             * Cc("\\")
                             * C(parsers.commented_line_letter))
                           * Cg(Cc(""), "backslashes")
                           * Cg(Cc(false), "pure_comment")))^0
                       * (#parsers.percent
                         * Cb("backslashes")
                         / function(backslashes)
                           return string.rep("\\", #backslashes / 2)
                         end
                         * ((Cb("pure_comment")
                            * parsers.percent  -- comment
                            * parsers.line
                            * #parsers.blankline) -- blank line
                           / function(is_pure)
                             return is_pure and "" or "\n"
                           end
                           + parsers.percent  -- comment
                           * parsers.line
                           * parsers.optionalspace)  -- leading spaces
                         + #(parsers.newline)
                         * Cb("backslashes")
                         * C(parsers.newline))

parsers.chunk = parsers.line * (parsers.optionallyindentedline
                                       - parsers.blankline)^0

parsers.attribute_key_char = parsers.unicode.alpha
                           + parsers.unicode.numeric
                           + S("-_:.")
parsers.attribute_raw_char = parsers.unicode.alpha
                           + parsers.unicode.numeric
                           + S("-_")
parsers.attribute_key = (parsers.attribute_key_char
                        - parsers.dash - parsers.digit)
                      * parsers.attribute_key_char^0
parsers.attribute_value = ( (parsers.dquote / "")
                          * (parsers.anyescaped - parsers.dquote)^0
                          * (parsers.dquote / ""))
                        + ( (parsers.squote / "")
                          * (parsers.anyescaped - parsers.squote)^0
                          * (parsers.squote / ""))
                        + ( parsers.anyescaped
                          - parsers.dquote
                          - parsers.rbrace
                          - parsers.space)^0
parsers.attribute_identifier = parsers.attribute_key_char^1
parsers.attribute_classname = parsers.unicode.alpha
                            * parsers.attribute_key_char^0
parsers.attribute_raw = parsers.attribute_raw_char^1

parsers.attribute = (parsers.dash * Cc(".unnumbered"))
                  + C( parsers.hash
                     * parsers.attribute_identifier)
                  + C( parsers.period
                     * parsers.attribute_classname)
                  + Cs( parsers.attribute_key
                      * parsers.optionalspace
                      * parsers.equal
                      * parsers.optionalspace
                      * parsers.attribute_value)
parsers.attributes = parsers.lbrace
                   * parsers.optionalspace
                   * parsers.attribute
                   * (parsers.spacechar^1
                     * parsers.attribute)^0
                   * parsers.optionalspace
                   * parsers.rbrace

parsers.raw_attribute = parsers.lbrace
                      * parsers.optionalspace
                      * parsers.equal
                      * C(parsers.attribute_raw)
                      * parsers.optionalspace
                      * parsers.rbrace

-- block followed by 0 or more optionally
-- indented blocks with first line indented.
parsers.indented_blocks = function(bl)
  return Cs( bl
         * ( parsers.blankline^1
           * parsers.indent
           * -parsers.blankline
           * bl)^0
         * (parsers.blankline^1 + parsers.eof) )
end
local function repeat_between(pattern, min, max)
  return -pattern^(max + 1) * pattern^min
end

parsers.hexentity = parsers.ampersand * parsers.hash * C(S("Xx"))
                  * C(repeat_between(parsers.hexdigit, 1, 6))
                  * parsers.semicolon
parsers.decentity = parsers.ampersand * parsers.hash
                  * C(repeat_between(parsers.digit, 1, 7))
                  * parsers.semicolon
parsers.tagentity = parsers.ampersand * C(parsers.alphanumeric^1)
                  * parsers.semicolon

parsers.html_entities
  = parsers.hexentity / entities.hex_entity_with_x_char
  + parsers.decentity / entities.dec_entity
  + parsers.tagentity / entities.char_entity
parsers.html_space_entity_char
  = Cmt(parsers.html_entities, function(_, i, entity)
     return entity == " " and i or nil
    end)
parsers.bullet = function(bullet_char, interrupting)
  local allowed_end
  if interrupting then
    allowed_end = C(parsers.spacechar^1) * #parsers.linechar
  else
    allowed_end = C(parsers.spacechar^1)
                + #(parsers.newline + parsers.eof)
  end
  return parsers.check_trail
        * Ct(C(bullet_char) * Cc(""))
        * allowed_end
end

local function tickbox(interior)
  return parsers.optionalspace * parsers.lbracket
       * interior * parsers.rbracket * parsers.spacechar^1
end

parsers.ticked_box = tickbox(S("xX")) * Cc(1.0)
parsers.halfticked_box = tickbox(S("./")) * Cc(0.5)
parsers.unticked_box = tickbox(parsers.spacechar^1) * Cc(0.0)

parsers.openticks   = Cg(parsers.backtick^1, "ticks")

local function captures_equal_length(_,i,a,b)
  return #a == #b and i
end

parsers.closeticks  = Cmt(C(parsers.backtick^1)
                          * Cb("ticks"), captures_equal_length)

parsers.intickschar = (parsers.any - S("\n\r`"))
                    + V("NoSoftLineBreakEndline")
                    + (parsers.backtick^1 - parsers.closeticks)

local function process_inticks(s)
  s = s:gsub("\n", " ")
  s = s:gsub("^ (.*) $", "%1")
  return s
end

parsers.inticks = parsers.openticks
                * C(parsers.space^0)
                * parsers.closeticks
                + parsers.openticks
                * Cs(Cs(parsers.intickschar^0) / process_inticks)
                * parsers.closeticks

-- case-insensitive match (we assume s is lowercase)
-- must be single byte encoding
parsers.keyword_exact = function(s)
  local parser = P(0)
  for i=1,#s do
    local c = s:sub(i,i)
    local m = c .. upper(c)
    parser = parser * S(m)
  end
  return parser
end

parsers.special_block_keyword =
    parsers.keyword_exact("pre") +
    parsers.keyword_exact("script") +
    parsers.keyword_exact("style") +
    parsers.keyword_exact("textarea")

parsers.block_keyword =
    parsers.keyword_exact("address") +
    parsers.keyword_exact("article") +
    parsers.keyword_exact("aside") +
    parsers.keyword_exact("base") +
    parsers.keyword_exact("basefont") +
    parsers.keyword_exact("blockquote") +
    parsers.keyword_exact("body") +
    parsers.keyword_exact("caption") +
    parsers.keyword_exact("center") +
    parsers.keyword_exact("col") +
    parsers.keyword_exact("colgroup") +
    parsers.keyword_exact("dd") +
    parsers.keyword_exact("details") +
    parsers.keyword_exact("dialog") +
    parsers.keyword_exact("dir") +
    parsers.keyword_exact("div") +
    parsers.keyword_exact("dl") +
    parsers.keyword_exact("dt") +
    parsers.keyword_exact("fieldset") +
    parsers.keyword_exact("figcaption") +
    parsers.keyword_exact("figure") +
    parsers.keyword_exact("footer") +
    parsers.keyword_exact("form") +
    parsers.keyword_exact("frame") +
    parsers.keyword_exact("frameset") +
    parsers.keyword_exact("h1") +
    parsers.keyword_exact("h2") +
    parsers.keyword_exact("h3") +
    parsers.keyword_exact("h4") +
    parsers.keyword_exact("h5") +
    parsers.keyword_exact("h6") +
    parsers.keyword_exact("head") +
    parsers.keyword_exact("header") +
    parsers.keyword_exact("hr") +
    parsers.keyword_exact("html") +
    parsers.keyword_exact("iframe") +
    parsers.keyword_exact("legend") +
    parsers.keyword_exact("li") +
    parsers.keyword_exact("link") +
    parsers.keyword_exact("main") +
    parsers.keyword_exact("menu") +
    parsers.keyword_exact("menuitem") +
    parsers.keyword_exact("nav") +
    parsers.keyword_exact("noframes") +
    parsers.keyword_exact("ol") +
    parsers.keyword_exact("optgroup") +
    parsers.keyword_exact("option") +
    parsers.keyword_exact("p") +
    parsers.keyword_exact("param") +
    parsers.keyword_exact("section") +
    parsers.keyword_exact("source") +
    parsers.keyword_exact("summary") +
    parsers.keyword_exact("table") +
    parsers.keyword_exact("tbody") +
    parsers.keyword_exact("td") +
    parsers.keyword_exact("tfoot") +
    parsers.keyword_exact("th") +
    parsers.keyword_exact("thead") +
    parsers.keyword_exact("title") +
    parsers.keyword_exact("tr") +
    parsers.keyword_exact("track") +
    parsers.keyword_exact("ul")

-- end conditions
parsers.html_blankline_end_condition
  = parsers.linechar^0
  * ( parsers.newline
    * (parsers.check_minimal_blank_indent_and_any_trail
      * #parsers.blankline
      + parsers.check_minimal_indent_and_any_trail)
    * parsers.linechar^1)^0
  * (parsers.newline^-1 / "")

local function remove_trailing_blank_lines(s)
  return s:gsub("[\n\r]+%s*$", "")
end

parsers.html_until_end = function(end_marker)
  return (
    Cs(C( parsers.newline
        * (parsers.check_minimal_blank_indent_and_any_trail
          * #parsers.blankline
          + parsers.check_minimal_indent_and_any_trail)
      + parsers.linechar - end_marker)^0)
    * (C(parsers.linechar^0 * parsers.newline^-1)
      / remove_trailing_blank_lines)
  )
end

-- attributes
parsers.html_attribute_spacing  = parsers.optionalspace
                                * V("NoSoftLineBreakEndline")
                                * parsers.optionalspace
                                + parsers.spacechar^1

parsers.html_attribute_name = ( parsers.letter
                              + parsers.colon
                              + parsers.underscore)
                            * ( parsers.alphanumeric
                              + parsers.colon
                              + parsers.underscore
                            + parsers.period
                            + parsers.dash)^0

parsers.html_attribute_value  = parsers.squote
                              * (parsers.linechar - parsers.squote)^0
                              * parsers.squote
                              + parsers.dquote
                              * (parsers.linechar - parsers.dquote)^0
                              * parsers.dquote
                              + ( parsers.any
                                - parsers.spacechar
                                - parsers.newline
                                - parsers.dquote
                                - parsers.squote
                                - parsers.backtick
                                - parsers.equal
                                - parsers.less
                                - parsers.more)^1

parsers.html_inline_attribute_value = parsers.squote
                                    * (V("NoSoftLineBreakEndline")
                                      + parsers.any
                                      - parsers.blankline^2
                                      - parsers.squote)^0
                                    * parsers.squote
                                    + parsers.dquote
                                    * (V("NoSoftLineBreakEndline")
                                      + parsers.any
                                      - parsers.blankline^2
                                      - parsers.dquote)^0
                                    * parsers.dquote
                                    + (parsers.any
                                      - parsers.spacechar
                                      - parsers.newline
                                      - parsers.dquote
                                      - parsers.squote
                                      - parsers.backtick
                                      - parsers.equal
                                      - parsers.less
                                      - parsers.more)^1

parsers.html_attribute_value_specification
  = parsers.optionalspace
  * parsers.equal
  * parsers.optionalspace
  * parsers.html_attribute_value

parsers.html_spnl = parsers.optionalspace
                  * (V("NoSoftLineBreakEndline")
                  * parsers.optionalspace)^-1

parsers.html_inline_attribute_value_specification
  = parsers.html_spnl
  * parsers.equal
  * parsers.html_spnl
  * parsers.html_inline_attribute_value

parsers.html_attribute
  = parsers.html_attribute_spacing
  * parsers.html_attribute_name
  * parsers.html_inline_attribute_value_specification^-1

parsers.html_non_newline_attribute
  = parsers.spacechar^1
  * parsers.html_attribute_name
  * parsers.html_attribute_value_specification^-1

parsers.nested_breaking_blank = parsers.newline
                              * parsers.check_minimal_blank_indent
                              * parsers.blankline

parsers.html_comment_start = P("<!--")
                           * parsers.optionalspace

parsers.html_comment_end = parsers.optionalspace
                         * P("-->")

parsers.html_comment
  = parsers.html_comment_start
  * parsers.html_until_end(parsers.html_comment_end)

parsers.html_inline_comment = (parsers.html_comment_start / "")
                            * -P(">") * -P("->")
                            * Cs(( parsers.any
                                 - parsers.nested_breaking_blank
                                 - parsers.html_comment_end)^0)
                            * (parsers.html_comment_end / "")

parsers.html_cdatasection_start = P("<![CDATA[")

parsers.html_cdatasection_end = P("]]>")

parsers.html_cdatasection
  = Cs( parsers.html_cdatasection_start
      * parsers.html_until_end(parsers.html_cdatasection_end))
  / remove_trailing_blank_lines

parsers.html_inline_cdatasection
  = parsers.html_cdatasection_start
  * Cs(V("NoSoftLineBreakEndline") + parsers.any
      - parsers.nested_breaking_blank - parsers.html_cdatasection_end)^0
  * parsers.html_cdatasection_end

parsers.html_declaration_start = P("<!") * parsers.letter

parsers.html_declaration_end = P(">")

parsers.html_declaration
  = Cs( parsers.html_declaration_start
      * parsers.html_until_end(parsers.html_declaration_end))
  / remove_trailing_blank_lines

parsers.html_inline_declaration
  = parsers.html_declaration_start
  * Cs(V("NoSoftLineBreakEndline") + parsers.any
      - parsers.nested_breaking_blank - parsers.html_declaration_end)^0
  * parsers.html_declaration_end

parsers.html_instruction_start = P("<?")

parsers.html_instruction_end = P("?>")

parsers.html_instruction
  = Cs( parsers.html_instruction_start
      * parsers.html_until_end(parsers.html_instruction_end))
  / remove_trailing_blank_lines

parsers.html_inline_instruction = parsers.html_instruction_start
                                * Cs( V("NoSoftLineBreakEndline")
                                    + parsers.any
                                    - parsers.nested_breaking_blank
                                    - parsers.html_instruction_end)^0
                                * parsers.html_instruction_end

parsers.html_blankline  = parsers.newline
                        * parsers.optionalspace
                        * parsers.newline

parsers.html_tag_start = parsers.less

parsers.html_tag_closing_start  = parsers.less
                                * parsers.slash

parsers.html_tag_end  = parsers.html_spnl
                      * parsers.more

parsers.html_empty_tag_end  = parsers.html_spnl
                            * parsers.slash
                            * parsers.more

-- opening tags
parsers.html_any_open_inline_tag  = parsers.html_tag_start
                                  * parsers.keyword
                                  * parsers.html_attribute^0
                                  * parsers.html_tag_end

parsers.html_any_open_tag = parsers.html_tag_start
                          * parsers.keyword
                          * parsers.html_non_newline_attribute^0
                          * parsers.html_tag_end

parsers.html_open_tag = parsers.html_tag_start
                      * parsers.block_keyword
                      * parsers.html_attribute^0
                      * parsers.html_tag_end

parsers.html_open_special_tag = parsers.html_tag_start
                              * parsers.special_block_keyword
                              * parsers.html_attribute^0
                              * parsers.html_tag_end

-- incomplete tags
parsers.incomplete_tag_following  = parsers.spacechar
                                  + parsers.more
                                  + parsers.slash * parsers.more
                                  + #(parsers.newline + parsers.eof)

parsers.incomplete_special_tag_following = parsers.spacechar
                                         + parsers.more
                                         + #( parsers.newline
                                            + parsers.eof)

parsers.html_incomplete_open_tag  = parsers.html_tag_start
                                  * parsers.block_keyword
                                  * parsers.incomplete_tag_following

parsers.html_incomplete_open_special_tag
  = parsers.html_tag_start
  * parsers.special_block_keyword
  * parsers.incomplete_special_tag_following

parsers.html_incomplete_close_tag = parsers.html_tag_closing_start
                                  * parsers.block_keyword
                                  * parsers.incomplete_tag_following

parsers.html_incomplete_close_special_tag
  = parsers.html_tag_closing_start
  * parsers.special_block_keyword
  * parsers.incomplete_tag_following

-- closing tags
parsers.html_close_tag  = parsers.html_tag_closing_start
                        * parsers.block_keyword
                        * parsers.html_tag_end

parsers.html_any_close_tag  = parsers.html_tag_closing_start
                            * parsers.keyword
                            * parsers.html_tag_end

parsers.html_close_special_tag = parsers.html_tag_closing_start
                               * parsers.special_block_keyword
                               * parsers.html_tag_end

-- empty tags
parsers.html_any_empty_inline_tag = parsers.html_tag_start
                                  * parsers.keyword
                                  * parsers.html_attribute^0
                                  * parsers.html_empty_tag_end

parsers.html_any_empty_tag  = parsers.html_tag_start
                            * parsers.keyword
                            * parsers.html_non_newline_attribute^0
                            * parsers.optionalspace
                            * parsers.slash
                            * parsers.more

parsers.html_empty_tag  = parsers.html_tag_start
                        * parsers.block_keyword
                        * parsers.html_attribute^0
                        * parsers.html_empty_tag_end

parsers.html_empty_special_tag  = parsers.html_tag_start
                                * parsers.special_block_keyword
                                * parsers.html_attribute^0
                                * parsers.html_empty_tag_end

parsers.html_incomplete_blocks
  = parsers.html_incomplete_open_tag
  + parsers.html_incomplete_open_special_tag
  + parsers.html_incomplete_close_tag

-- parse special html blocks
parsers.html_blankline_ending_special_block_opening
  = ( parsers.html_close_special_tag
    + parsers.html_empty_special_tag)
  * #( parsers.optionalspace
     * (parsers.newline + parsers.eof))

parsers.html_blankline_ending_special_block
  = parsers.html_blankline_ending_special_block_opening
  * parsers.html_blankline_end_condition

parsers.html_special_block_opening
  = parsers.html_incomplete_open_special_tag
  - parsers.html_empty_special_tag

parsers.html_closing_special_block
  = Cs( parsers.html_special_block_opening
      * parsers.html_until_end(parsers.html_close_special_tag))
  / remove_trailing_blank_lines

parsers.html_special_block
  = parsers.html_blankline_ending_special_block
  + parsers.html_closing_special_block

-- parse html blocks
parsers.html_block_opening  = parsers.html_incomplete_open_tag
                            + parsers.html_incomplete_close_tag

parsers.html_block  = parsers.html_block_opening
                    * parsers.html_blankline_end_condition

-- parse any html blocks
parsers.html_any_block_opening
  = ( parsers.html_any_open_tag
    + parsers.html_any_close_tag
    + parsers.html_any_empty_tag)
  * #(parsers.optionalspace * (parsers.newline + parsers.eof))

parsers.html_any_block  = parsers.html_any_block_opening
                        * parsers.html_blankline_end_condition

parsers.html_inline_comment_full  = parsers.html_comment_start
                                  * -P(">") * -P("->")
                                  * Cs(( parsers.any - P("--")
                                       - parsers.nested_breaking_blank
                                       - parsers.html_comment_end)^0)
                                  * parsers.html_comment_end

parsers.html_inline_tags  = parsers.html_inline_comment_full
                          + parsers.html_any_empty_inline_tag
                          + parsers.html_inline_instruction
                          + parsers.html_inline_cdatasection
                          + parsers.html_inline_declaration
                          + parsers.html_any_open_inline_tag
                          + parsers.html_any_close_tag

parsers.urlchar = parsers.anyescaped
                - parsers.newline
                - parsers.more

parsers.auto_link_scheme_part = parsers.alphanumeric
                              + parsers.plus
                              + parsers.period
                              + parsers.dash

parsers.auto_link_scheme  = parsers.letter
                          * parsers.auto_link_scheme_part
                          * parsers.auto_link_scheme_part^-30

parsers.absolute_uri  = parsers.auto_link_scheme * parsers.colon
                      * ( parsers.any - parsers.spacing
                        - parsers.less - parsers.more)^0

parsers.printable_characters = S(".!#$%&'*+/=?^_`{|}~-")

parsers.email_address_local_part_char = parsers.alphanumeric
                                      + parsers.printable_characters

parsers.email_address_local_part
  = parsers.email_address_local_part_char^1

parsers.email_address_dns_label = parsers.alphanumeric
                                * ( parsers.alphanumeric
                                  + parsers.dash)^-62
                                * B(parsers.alphanumeric)

parsers.email_address_domain  = parsers.email_address_dns_label
                              * ( parsers.period
                                * parsers.email_address_dns_label)^0

parsers.email_address = parsers.email_address_local_part
                      * parsers.at
                      * parsers.email_address_domain

parsers.auto_link_url = parsers.less
                      * C(parsers.absolute_uri)
                      * parsers.more

parsers.auto_link_email = parsers.less
                        * C(parsers.email_address)
                        * parsers.more

parsers.auto_link_relative_reference = parsers.less
                                    * C(parsers.urlchar^1)
                                    * parsers.more

parsers.autolink  = parsers.auto_link_url
                  + parsers.auto_link_email

-- content in balanced brackets, parentheses, or quotes:
parsers.bracketed   = P{ parsers.lbracket
                       * (( parsers.backslash / "" * parsers.rbracket
                          + parsers.any - (parsers.lbracket
                                          + parsers.rbracket
                                          + parsers.blankline^2)
                          ) + V(1))^0
                       * parsers.rbracket }

parsers.inparens    = P{ parsers.lparent
                       * ((parsers.anyescaped - (parsers.lparent
                                                + parsers.rparent
                                                + parsers.blankline^2)
                          ) + V(1))^0
                       * parsers.rparent }

parsers.squoted     = P{ parsers.squote * parsers.alphanumeric
                       * ((parsers.anyescaped - (parsers.squote
                                                + parsers.blankline^2)
                          ) + V(1))^0
                       * parsers.squote }

parsers.dquoted     = P{ parsers.dquote * parsers.alphanumeric
                       * ((parsers.anyescaped - (parsers.dquote
                                                + parsers.blankline^2)
                          ) + V(1))^0
                       * parsers.dquote }

parsers.link_text  = parsers.lbracket
                    * Cs((parsers.alphanumeric^1
                        + parsers.bracketed
                        + parsers.inticks
                        + parsers.autolink
                        + V("InlineHtml")
                        + ( parsers.backslash * parsers.backslash)
                        + ( parsers.backslash
                          * ( parsers.lbracket
                            + parsers.rbracket)
                          + V("Space")
                          + V("NoSoftLineBreakEndline")
                          + (parsers.any
                            - ( parsers.newline
                              + parsers.lbracket
                              + parsers.rbracket
                              + parsers.blankline^2))))^0)
                    * parsers.rbracket

parsers.link_label_body = -#(parsers.sp * parsers.rbracket)
                        * #( ( parsers.any
                             - parsers.rbracket)^-999
                           * parsers.rbracket)
                        * Cs((parsers.alphanumeric^1
                            + parsers.inticks
                            + parsers.autolink
                            + V("InlineHtml")
                            + ( parsers.backslash * parsers.backslash)
                            + ( parsers.backslash
                              * ( parsers.lbracket
                                + parsers.rbracket)
                              + V("Space")
                              + V("NoSoftLineBreakEndline")
                              + (parsers.any
                                - ( parsers.newline
                                  + parsers.lbracket
                                  + parsers.rbracket
                                  + parsers.blankline^2))))^1)

parsers.link_label  = parsers.lbracket
                    * parsers.link_label_body
                    * parsers.rbracket

parsers.inparens_url  = P{ parsers.lparent
                         * ((parsers.anyescaped - (parsers.lparent
                                                  + parsers.rparent
                                                  + parsers.spacing)
                            ) + V(1))^0
                         * parsers.rparent }

-- url for markdown links, allowing nested brackets:
parsers.url         = parsers.less * Cs((parsers.anyescaped
                                        - parsers.newline
                                        - parsers.less
                                        - parsers.more)^0)
                                   * parsers.more
                    + -parsers.less
                    * Cs((parsers.inparens_url + (parsers.anyescaped
                                                 - parsers.spacing
                                                 - parsers.lparent
                                                 - parsers.rparent))^1)

-- quoted text:
parsers.title_s     = parsers.squote
                    * Cs((parsers.html_entities
                         + V("Space")
                         + V("NoSoftLineBreakEndline")
                         + ( parsers.anyescaped
                           - parsers.newline
                           - parsers.squote
                           - parsers.blankline^2))^0)
                    * parsers.squote

parsers.title_d     = parsers.dquote
                    * Cs((parsers.html_entities
                         + V("Space")
                         + V("NoSoftLineBreakEndline")
                         + ( parsers.anyescaped
                           - parsers.newline
                           - parsers.dquote
                           - parsers.blankline^2))^0)
                    * parsers.dquote

parsers.title_p     = parsers.lparent
                    * Cs((parsers.html_entities
                         + V("Space")
                         + V("NoSoftLineBreakEndline")
                         + ( parsers.anyescaped
                           - parsers.newline
                           - parsers.lparent
                           - parsers.rparent
                           - parsers.blankline^2))^0)
                    * parsers.rparent

parsers.title
  = parsers.title_d + parsers.title_s + parsers.title_p

parsers.optionaltitle
  = parsers.spnlc * parsers.title * parsers.spacechar^0 + Cc("")

-- parse a reference definition:  [foo]: /bar "title"
parsers.define_reference_parser = (parsers.check_trail / "")
                                * parsers.link_label * parsers.colon
                                * parsers.spnlc * parsers.url
                                * ( parsers.spnlc_sep * parsers.title
                                  * parsers.only_blank
                                  + Cc("") * parsers.only_blank)
parsers.Inline         = V("Inline")

-- parse many p between starter and ender
parsers.between = function(p, starter, ender)
  local ender2 = B(parsers.nonspacechar) * ender
  return ( starter
         * #parsers.nonspacechar
         * Ct(p * (p - ender2)^0)
         * ender2)
end

parsers.lineof = function(c)
    return ( parsers.check_trail_no_rem
           * (P(c) * parsers.optionalspace)^3
           * (parsers.newline + parsers.eof))
end

parsers.thematic_break_lines = parsers.lineof(parsers.asterisk)
                             + parsers.lineof(parsers.dash)
                             + parsers.lineof(parsers.underscore)
-- parse Atx heading start and return level
parsers.heading_start = #parsers.hash * C(parsers.hash^-6)
                      * -parsers.hash / length

-- parse setext header ending and return level
parsers.heading_level
  = parsers.nonindentspace * parsers.equal^1
  * parsers.optionalspace * #parsers.newline * Cc(1)
  + parsers.nonindentspace * parsers.dash^1
  * parsers.optionalspace * #parsers.newline * Cc(2)

local function strip_atx_end(s)
  return s:gsub("%s+#*%s*\n$","")
end

parsers.atx_heading = parsers.check_trail_no_rem
                    * Cg(parsers.heading_start, "level")
                    * (C( parsers.optionalspace
                        * parsers.hash^0
                        * parsers.optionalspace
                        * parsers.newline)
                      + parsers.spacechar^1
                      * C(parsers.line))
M.reader = {}
function M.reader.new(writer, options)
  local self = {}
  self.writer = writer
  self.options = options
  self.parsers = {}
  (function(parsers)
    setmetatable(self.parsers, {
      __index = function (_, key)
        return parsers[key]
      end
    })
  end)(parsers)
  local parsers = self.parsers
  function self.normalize_tag(tag)
    tag = util.rope_to_string(tag)
    tag = tag:gsub("[ \n\r\t]+", " ")
    tag = tag:gsub("^ ", ""):gsub(" $", "")
    local form = nil
    if options.unicodeNormalization then
      form = options.unicodeNormalizationForm
    end
    tag = util.casefold(tag, form)
    return tag
  end
  local function iterlines(s, f)
    local rope = lpeg.match(Ct((parsers.line / f)^1), s)
    return util.rope_to_string(rope)
  end
  if options.preserveTabs then
    self.expandtabs = function(s) return s end
  else
    self.expandtabs = function(s)
                        if s:find("\t") then
                          return iterlines(s, util.expand_tabs_in_line)
                        else
                          return s
                        end
                      end
  end
  self.parser_functions = {}
  self.create_parser = function(name, grammar, toplevel)
    self.parser_functions[name] = function(str)
      if toplevel and options.stripIndent then
          local min_prefix_length, min_prefix = nil, ''
          str = iterlines(str, function(line)
              if lpeg.match(parsers.nonemptyline, line) == nil then
                  return line
              end
              line = util.expand_tabs_in_line(line)
              local prefix = lpeg.match(C(parsers.optionalspace), line)
              local prefix_length = #prefix
              local is_shorter = min_prefix_length == nil
              if not is_shorter then
                is_shorter = prefix_length < min_prefix_length
              end
              if is_shorter then
                min_prefix_length, min_prefix = prefix_length, prefix
              end
              return line
          end)
          str = str:gsub('^' .. min_prefix, '')
      end
      if toplevel and (options.texComments or options.hybrid) then
        str = lpeg.match(Ct(parsers.commented_line^1), str)
        str = util.rope_to_string(str)
      end
      local res = lpeg.match(grammar(), str)
      if res == nil then
        return writer.error(
          format("Parser `%s` failed to process the input text.", name),
          format("Here are the first 20 characters of the remaining "
              .. "unprocessed text: `%s`.", str:sub(1,20))
        )
      else
        return res
      end
    end
  end

  self.create_parser("parse_blocks",
                     function()
                       return parsers.blocks
                     end, true)

  self.create_parser("parse_blocks_nested",
                     function()
                       return parsers.blocks_nested
                     end, false)

  self.create_parser("parse_inlines",
                     function()
                       return parsers.inlines
                     end, false)

  self.create_parser("parse_inlines_no_inline_note",
                     function()
                       return parsers.inlines_no_inline_note
                     end, false)

  self.create_parser("parse_inlines_no_html",
                     function()
                       return parsers.inlines_no_html
                     end, false)

  self.create_parser("parse_inlines_nbsp",
                     function()
                       return parsers.inlines_nbsp
                     end, false)

  self.create_parser("parse_inlines_no_link_or_emphasis",
                    function()
                      return parsers.inlines_no_link_or_emphasis
                    end, false)

  self.create_parser("parse_inlines_identity",
                    function()
                      return parsers.inlines_identity
                    end, false)

  self.create_parser("parse_inlines_string",
                    function()
                      return parsers.inlines_string
                    end, false)

  self.create_parser("parse_inlines_math",
                    function()
                      return parsers.inlines_math
                    end, false)
  parsers.minimally_indented_blankline
    = parsers.check_minimal_indent * (parsers.blankline / "")

  parsers.minimally_indented_block
    = parsers.check_minimal_indent * V("Block")

  parsers.minimally_indented_block_or_paragraph
    = parsers.check_minimal_indent * V("BlockOrParagraph")

  parsers.minimally_indented_paragraph
    = parsers.check_minimal_indent * V("Paragraph")

  parsers.minimally_indented_plain
    = parsers.check_minimal_indent * V("Plain")

  parsers.minimally_indented_par_or_plain
    = parsers.minimally_indented_paragraph
    + parsers.minimally_indented_plain

  parsers.minimally_indented_par_or_plain_no_blank
    = parsers.minimally_indented_par_or_plain
    - parsers.minimally_indented_blankline

  parsers.minimally_indented_ref
    = parsers.check_minimal_indent * V("Reference")

  parsers.minimally_indented_blank
    = parsers.check_minimal_indent * V("Blank")

  parsers.conditionally_indented_blankline
    = parsers.check_minimal_blank_indent * (parsers.blankline / "")

  parsers.minimally_indented_ref_or_block
    = parsers.minimally_indented_ref
    + parsers.minimally_indented_block
    - parsers.minimally_indented_blankline

  parsers.minimally_indented_ref_or_block_or_par
    = parsers.minimally_indented_ref
    + parsers.minimally_indented_block_or_paragraph
    - parsers.minimally_indented_blankline


  function parsers.separator_loop(separated_block, paragraph,
                                  block_separator, paragraph_separator)
    return  separated_block
          + block_separator
            * paragraph
            * separated_block
          + paragraph_separator
          * paragraph
  end

  function parsers.create_loop_body_pair(separated_block, paragraph,
                                         block_separator,
                                         paragraph_separator)
    return {
      block = parsers.separator_loop(separated_block, paragraph,
                                     block_separator, block_separator),
      par = parsers.separator_loop(separated_block, paragraph,
                                   block_separator, paragraph_separator)
    }
  end

  parsers.block_sep_group = function(blank)
    return  blank^0 * parsers.eof
          + ( blank^2 / writer.paragraphsep
            + blank^0 / writer.interblocksep
            )
  end

  parsers.par_sep_group = function(blank)
    return  blank^0 * parsers.eof
          + blank^0 / writer.paragraphsep
  end

  parsers.sep_group_no_output = function(blank)
    return  blank^0 * parsers.eof
          + blank^0
  end

  parsers.content_blank = parsers.minimally_indented_blankline

  parsers.ref_or_block_separated
    = parsers.sep_group_no_output(parsers.content_blank)
    * ( parsers.minimally_indented_ref
      - parsers.content_blank)
    + parsers.block_sep_group(parsers.content_blank)
    * ( parsers.minimally_indented_block
      - parsers.content_blank)

  parsers.loop_body_pair  =
    parsers.create_loop_body_pair(
      parsers.ref_or_block_separated,
      parsers.minimally_indented_par_or_plain_no_blank,
      parsers.block_sep_group(parsers.content_blank),
      parsers.par_sep_group(parsers.content_blank))

  parsers.content_loop  = ( V("Block")
                          * parsers.loop_body_pair.block^0
                          + (V("Paragraph") + V("Plain"))
                          * parsers.ref_or_block_separated
                          * parsers.loop_body_pair.block^0
                          + (V("Paragraph") + V("Plain"))
                          * parsers.loop_body_pair.par^0)
                        * parsers.content_blank^0

  parsers.indented_content = function()
    return  Ct( (V("Reference") + (parsers.blankline / ""))
              * parsers.content_blank^0
              * parsers.check_minimal_indent
              * parsers.content_loop
              + (V("Reference") + (parsers.blankline / ""))
              * parsers.content_blank^0
              + parsers.content_loop)
  end

  parsers.add_indent = function(pattern, name, breakable)
    return  Cg(Cmt( Cb("indent_info")
                  * Ct(pattern)
                  * ( #parsers.linechar  -- check if starter is blank
                    * Cc(false) + Cc(true))
                  * Cc(name)
                  * Cc(breakable),
              process_starter_indent), "indent_info")
  end

  if options.hashEnumerators then
    parsers.dig = parsers.digit + parsers.hash
  else
    parsers.dig = parsers.digit
  end

  parsers.enumerator = function(delimiter_type, interrupting)
    local delimiter_range
    local allowed_end
    if interrupting then
      delimiter_range = P("1")
      allowed_end = C(parsers.spacechar^1) * #parsers.linechar
    else
      delimiter_range = parsers.dig * parsers.dig^-8
      allowed_end = C(parsers.spacechar^1)
                  + #(parsers.newline + parsers.eof)
    end

    return parsers.check_trail
             * Ct(C(delimiter_range) * C(delimiter_type))
             * allowed_end
  end

  parsers.starter = parsers.bullet(parsers.dash)
                  + parsers.bullet(parsers.asterisk)
                  + parsers.bullet(parsers.plus)
                  + parsers.enumerator(parsers.period)
                  + parsers.enumerator(parsers.rparent)

  parsers.blockquote_start
    = parsers.check_trail
    * C(parsers.more)
    * C(parsers.spacechar^0)

  parsers.blockquote_body
    = parsers.add_indent(parsers.blockquote_start, "bq", true)
    * parsers.indented_content()
    * remove_indent("bq")

  if not options.breakableBlockquotes then
    parsers.blockquote_body
      = parsers.add_indent(parsers.blockquote_start, "bq", false)
      * parsers.indented_content()
      * remove_indent("bq")
  end
  local function parse_content_part(content_part)
    local rope = util.rope_to_string(content_part)
    local parsed
      = self.parser_functions.parse_inlines_no_link_or_emphasis(rope)
    parsed.indent_info = nil
    return parsed
  end

  local collect_emphasis_content =
    function(t, opening_index, closing_index)
      local content = {}

      local content_part = {}
      for i = opening_index, closing_index do
        local value = t[i]

        if value.rendered ~= nil then
          content[#content + 1] = parse_content_part(content_part)
          content_part = {}
          content[#content + 1] = value.rendered
          value.rendered = nil
        else
          if value.warning ~= nil then
            if next(content_part) ~= nil then
              content[#content + 1] = parse_content_part(content_part)
            end
            content_part = {}

            content[#content + 1] = value.warning
            value.warning = nil
          end
          if value.type == "delimiter"
              and value.element == "emphasis" then
            if value.is_active then
              content_part[#content_part + 1]
                = string.rep(value.character, value.current_count)
            end
          else
            content_part[#content_part + 1] = value.content
          end
          value.content = ''
          value.is_active = false
        end
      end

      if next(content_part) ~= nil then
        content[#content + 1] = parse_content_part(content_part)
      end

      return content
    end

  local function fill_emph(t, opening_index, closing_index)
    local content
      = collect_emphasis_content(t, opening_index + 1,
                                 closing_index - 1)
    t[opening_index + 1].is_active = true
    t[opening_index + 1].rendered = writer.emphasis(content)
  end

  local function fill_strong(t, opening_index, closing_index)
    local content
      = collect_emphasis_content(t, opening_index + 1,
                                 closing_index - 1)
    t[opening_index + 1].is_active = true
    t[opening_index + 1].rendered = writer.strong(content)
  end

  local function breaks_three_rule(opening_delimiter, closing_delimiter)
    return ( opening_delimiter.is_closing
          or closing_delimiter.is_opening)
       and (( opening_delimiter.original_count
            + closing_delimiter.original_count) % 3 == 0)
       and ( opening_delimiter.original_count % 3 ~= 0
          or closing_delimiter.original_count % 3 ~= 0)
  end

  local find_emphasis_opener = function(t, bottom_index, latest_index,
                                        character, closing_delimiter)
    for i = latest_index, bottom_index, -1 do
      local value = t[i]
      if value.is_active and
         value.is_opening and
         value.type == "delimiter" and
         value.element == "emphasis" and
         (value.character == character) and
         (value.current_count > 0) then
        if not breaks_three_rule(value, closing_delimiter) then
          return i
        end
      end
    end
  end

  local function process_emphasis(t, opening_index, closing_index)
    for i = opening_index, closing_index do
      local value = t[i]
      if value.type == "delimiter" and value.element == "emphasis" then
          local delimiter_length = string.len(value.content)
          value.character = string.sub(value.content, 1, 1)
          value.current_count = delimiter_length
          value.original_count = delimiter_length
      end
    end

    local openers_bottom = {
      ['*'] = {
        [true] = {opening_index, opening_index, opening_index},
        [false] = {opening_index, opening_index, opening_index}
      },
      ['_'] = {
        [true] = {opening_index, opening_index, opening_index},
        [false] = {opening_index, opening_index, opening_index}
      }
    }

    local current_position = opening_index
    local max_position = closing_index

    while current_position <= max_position do
      local value = t[current_position]

      if value.type ~= "delimiter" or
        value.element ~= "emphasis" or
        not value.is_active or
        not value.is_closing or
        (value.current_count <= 0) then
        current_position = current_position + 1
        goto continue
      end

      local character = value.character
      local is_opening = value.is_opening
      local closing_length_modulo_three = value.original_count % 3

      local current_openers_bottom
        = openers_bottom[character][is_opening]
                        [closing_length_modulo_three + 1]

      local opener_position
        = find_emphasis_opener(t, current_openers_bottom,
                               current_position - 1, character, value)

      if (opener_position == nil) then
        openers_bottom[character][is_opening]
                      [closing_length_modulo_three + 1]
          = current_position
        current_position = current_position + 1
        goto continue
      end

      local opening_delimiter = t[opener_position]

      local current_opening_count = opening_delimiter.current_count
      local current_closing_count = t[current_position].current_count

      if (current_opening_count >= 2)
        and (current_closing_count >= 2) then
        opening_delimiter.current_count = current_opening_count - 2
        t[current_position].current_count = current_closing_count - 2
        fill_strong(t, opener_position, current_position)
      else
        opening_delimiter.current_count = current_opening_count - 1
        t[current_position].current_count = current_closing_count - 1
        fill_emph(t, opener_position, current_position)
      end

      ::continue::
    end
  end

  parsers.delimiter_run = function(character)
    return  (B(parsers.backslash * character) + -B(character))
          * character^1
          * -#character
  end

  parsers.left_flanking_delimiter_run = function(character)
    return  (B( parsers.any)
              * ( parsers.unicode.preceding_punctuation
                + parsers.unicode.preceding_whitespace)
             + -B(parsers.any))
            * parsers.delimiter_run(character)
            * #parsers.unicode.punctuation
            + parsers.delimiter_run(character)
            * -#( #parsers.unicode.punctuation
                + #parsers.unicode.whitespace
                + parsers.eof)
  end

  parsers.right_flanking_delimiter_run = function(character)
    return  parsers.unicode.preceding_punctuation
          * parsers.delimiter_run(character)
          * ( #parsers.unicode.punctuation
            + #parsers.unicode.whitespace
            + parsers.eof)
          + (B(parsers.any)
            * -( parsers.unicode.preceding_punctuation
               + parsers.unicode.preceding_whitespace))
          * parsers.delimiter_run(character)
  end

  if options.underscores then
    parsers.emph_start
      = parsers.left_flanking_delimiter_run(parsers.asterisk)
      + ( -#parsers.right_flanking_delimiter_run(parsers.underscore)
        + ( parsers.unicode.preceding_punctuation
          * #parsers.right_flanking_delimiter_run(parsers.underscore)))
      * parsers.left_flanking_delimiter_run(parsers.underscore)

    parsers.emph_end
      = parsers.right_flanking_delimiter_run(parsers.asterisk)
      + ( -#parsers.left_flanking_delimiter_run(parsers.underscore)
        + #( parsers.left_flanking_delimiter_run(parsers.underscore)
           * #parsers.unicode.punctuation))
      * parsers.right_flanking_delimiter_run(parsers.underscore)
  else
    parsers.emph_start
      = parsers.left_flanking_delimiter_run(parsers.asterisk)

    parsers.emph_end
      = parsers.right_flanking_delimiter_run(parsers.asterisk)
  end

  parsers.emph_capturing_open_and_close
    = #parsers.emph_start * #parsers.emph_end
    * Ct( Cg(Cc("delimiter"), "type")
        * Cg(Cc("emphasis"), "element")
        * Cg(C(parsers.emph_start), "content")
        * Cg(Cc(true), "is_opening")
        * Cg(Cc(true), "is_closing"))

  parsers.emph_capturing_open = Ct( Cg(Cc("delimiter"), "type")
                                  * Cg(Cc("emphasis"), "element")
                                  * Cg(C(parsers.emph_start), "content")
                                  * Cg(Cc(true), "is_opening")
                                  * Cg(Cc(false), "is_closing"))

  parsers.emph_capturing_close = Ct( Cg(Cc("delimiter"), "type")
                                   * Cg(Cc("emphasis"), "element")
                                   * Cg(C(parsers.emph_end), "content")
                                   * Cg(Cc(false), "is_opening")
                                   * Cg(Cc(true), "is_closing"))

  parsers.emph_open_or_close  = parsers.emph_capturing_open_and_close
                              + parsers.emph_capturing_open
                              + parsers.emph_capturing_close

  parsers.emph_open = parsers.emph_capturing_open_and_close
                    + parsers.emph_capturing_open

  parsers.emph_close  = parsers.emph_capturing_open_and_close
                      + parsers.emph_capturing_close

  -- List of references defined in the document
  local references

  -- List of note references defined in the document
  parsers.rawnotes = {}

  function self.register_link(_, tag, url, title,
                              attributes)
    local normalized_tag = self.normalize_tag(tag)
    if references[normalized_tag] == nil then
      references[normalized_tag] = {
        url = url,
        title = title,
        attributes = attributes
      }
      return ""
    else
      local text
        = string.format('Multiply defined link reference "%s"', tag)
      local more = string.format("Look for the text `[%s]: ...`.", tag)
      return writer.warning(text, more)
    end
  end

  function self.lookup_reference(tag)
    return references[self.normalize_tag(tag)]
  end

  function self.lookup_note_reference(tag)
    return parsers.rawnotes[self.normalize_tag(tag)]
  end

  parsers.title_s_direct_ref  = parsers.squote
                              * Cs((parsers.html_entities
                                  + ( parsers.anyescaped
                                    - parsers.squote
                                    - parsers.blankline^2))^0)
                              * parsers.squote

  parsers.title_d_direct_ref  = parsers.dquote
                              * Cs((parsers.html_entities
                                  + ( parsers.anyescaped
                                    - parsers.dquote
                                    - parsers.blankline^2))^0)
                              * parsers.dquote

  parsers.title_p_direct_ref  = parsers.lparent
                              * Cs((parsers.html_entities
                                  + ( parsers.anyescaped
                                    - parsers.lparent
                                    - parsers.rparent
                                    - parsers.blankline^2))^0)
                              * parsers.rparent

  parsers.title_direct_ref  = parsers.title_s_direct_ref
                            + parsers.title_d_direct_ref
                            + parsers.title_p_direct_ref

  parsers.inline_direct_ref_inside  = parsers.lparent * parsers.spnl
                                    * Cg(parsers.url + Cc(""), "url")
                                    * parsers.spnl
                                    * Cg( parsers.title_direct_ref
                                        + Cc(""), "title")
                                    * parsers.spnl * parsers.rparent

  parsers.inline_direct_ref = parsers.lparent * parsers.spnlc
                            * Cg(parsers.url + Cc(""), "url")
                            * parsers.spnlc
                            * Cg(parsers.title + Cc(""), "title")
                            * parsers.spnlc * parsers.rparent

  parsers.empty_link  = parsers.lbracket
                      * parsers.rbracket

  parsers.inline_link = parsers.link_text
                      * parsers.inline_direct_ref

  parsers.full_link = parsers.link_text
                    * parsers.link_label

  parsers.shortcut_link = parsers.link_label
                        * -(parsers.empty_link + parsers.link_label)

  parsers.collapsed_link  = parsers.link_label
                          * parsers.empty_link

  parsers.image_opening = #(parsers.exclamation * parsers.inline_link)
                        * Cg(Cc("inline"), "link_type")
                        + #(parsers.exclamation * parsers.full_link)
                        * Cg(Cc("full"), "link_type")
                        + #( parsers.exclamation
                           * parsers.collapsed_link)
                        * Cg(Cc("collapsed"), "link_type")
                        + #(parsers.exclamation * parsers.shortcut_link)
                        * Cg(Cc("shortcut"), "link_type")
                        + #(parsers.exclamation * parsers.empty_link)
                        * Cg(Cc("empty"), "link_type")

  parsers.link_opening  = #parsers.inline_link
                        * Cg(Cc("inline"), "link_type")
                        + #parsers.full_link
                        * Cg(Cc("full"), "link_type")
                        + #parsers.collapsed_link
                        * Cg(Cc("collapsed"), "link_type")
                        + #parsers.shortcut_link
                        * Cg(Cc("shortcut"), "link_type")
                        + #parsers.empty_link
                        * Cg(Cc("empty_link"), "link_type")
                        + #parsers.link_text
                        * Cg(Cc("link_text"), "link_type")

  parsers.note_opening  = #(parsers.circumflex * parsers.link_text)
                        * Cg(Cc("note_inline"), "link_type")

  parsers.raw_note_opening  = #( parsers.lbracket
                               * parsers.circumflex
                               * parsers.link_label_body
                               * parsers.rbracket)
                            * Cg(Cc("raw_note"), "link_type")

  local inline_note_element = Cg(Cc("note"), "element")
                            * parsers.note_opening
                            * Cg( parsers.circumflex
                                * parsers.lbracket, "content")

  local image_element = Cg(Cc("image"), "element")
                      * parsers.image_opening
                      * Cg( parsers.exclamation
                          * parsers.lbracket, "content")

  local note_element  = Cg(Cc("note"), "element")
                      * parsers.raw_note_opening
                      * Cg( parsers.lbracket
                          * parsers.circumflex, "content")

  local link_element  = Cg(Cc("link"), "element")
                      * parsers.link_opening
                      * Cg(parsers.lbracket, "content")

  local opening_elements = parsers.fail

  if options.inlineNotes then
    opening_elements = opening_elements + inline_note_element
  end

  opening_elements = opening_elements + image_element

  if options.notes then
    opening_elements = opening_elements + note_element
  end

  opening_elements = opening_elements + link_element

  parsers.link_image_opening  = Ct( Cg(Cc("delimiter"), "type")
                                  * Cg(Cc(true), "is_opening")
                                  * Cg(Cc(false), "is_closing")
                                  * opening_elements)

  parsers.link_image_closing  = Ct( Cg(Cc("delimiter"), "type")
                                  * Cg(Cc("link"), "element")
                                  * Cg(Cc(false), "is_opening")
                                  * Cg(Cc(true), "is_closing")
                                  * ( Cg(Cc(true), "is_direct")
                                    * Cg( parsers.rbracket
                                        * #parsers.inline_direct_ref,
                                         "content")
                                    + Cg(Cc(false), "is_direct")
                                    * Cg(parsers.rbracket, "content")))

  parsers.link_image_open_or_close  = parsers.link_image_opening
                                    + parsers.link_image_closing

  if options.html then
    parsers.link_emph_precedence  = parsers.inticks
                                  + parsers.autolink
                                  + parsers.html_inline_tags
  else
    parsers.link_emph_precedence  = parsers.inticks
                                  + parsers.autolink
  end

  parsers.link_and_emph_endline = parsers.newline
                                * ((parsers.check_minimal_indent
                                  * -V("EndlineExceptions")
                                  + parsers.check_optional_indent
                                  * -V("EndlineExceptions")
                                  * -V("ListStarter")) / "")
                                * parsers.spacechar^0 / "\n"

  parsers.link_and_emph_content
    = Ct( Cg(Cc("content"), "type")
        * Cg(Cs(( parsers.link_emph_precedence
                + parsers.backslash * parsers.linechar
                + parsers.link_and_emph_endline
                + (parsers.linechar
                  - parsers.blankline^2
                  - parsers.link_image_open_or_close
                  - parsers.emph_open_or_close))^0), "content"))

  parsers.link_and_emph_table
    = (parsers.link_image_opening + parsers.emph_open)
    * parsers.link_and_emph_content
    * ((parsers.link_image_open_or_close + parsers.emph_open_or_close)
      * parsers.link_and_emph_content)^1

  local function collect_link_content(t, opening_index, closing_index)
    local content = {}
    for i = opening_index, closing_index do
      content[#content + 1] = t[i].content
    end
    return util.rope_to_string(content)
  end

  local function find_link_opener(t, bottom_index, latest_index)
    for i = latest_index, bottom_index, -1 do
      local value = t[i]
      if value.type == "delimiter" and
         value.is_opening and
         ( value.element == "link"
        or value.element == "image"
        or value.element == "note")
         and not value.removed then
        if value.is_active then
          return i
        end
        value.removed = true
        return nil
      end
    end
  end

  local function find_next_link_closing_index(t, latest_index)
    for i = latest_index, #t do
      local value = t[i]
      if value.is_closing and
         value.element == "link" and
         not value.removed then
        return i
      end
    end
  end

  local function disable_previous_link_openers(t, opening_index)
    if t[opening_index].element == "image" then
      return
    end

    for i = opening_index, 1, -1 do
      local value = t[i]
      if value.is_active and
         value.type == "delimiter" and
         value.is_opening and
         value.element == "link" then
        value.is_active = false
      end
    end
  end

  local function disable_range(t, opening_index, closing_index)
    for i = opening_index, closing_index do
      local value = t[i]
      if value.is_active then
        value.is_active = false
        if value.type == "delimiter" then
          value.removed = true
        end
      end
    end
  end

  local delete_parsed_content_in_range =
    function(t, opening_index, closing_index)
      for i = opening_index, closing_index do
        t[i].rendered = nil
      end
    end

  local function empty_content_in_range(t, opening_index, closing_index)
    for i = opening_index, closing_index do
      t[i].content = ''
    end
  end

  local function join_attributes(reference_attributes, own_attributes)
    local merged_attributes = {}
    for _, attribute in ipairs(reference_attributes or {}) do
      table.insert(merged_attributes, attribute)
    end
    for _, attribute in ipairs(own_attributes or {}) do
      table.insert(merged_attributes, attribute)
    end
    if next(merged_attributes) == nil then
      merged_attributes = nil
    end
    return merged_attributes
  end

  local render_link_or_image =
    function(t, opening_index, closing_index, content_end_index,
             reference)
      process_emphasis(t, opening_index, content_end_index)
      local mapped = collect_emphasis_content(t, opening_index + 1,
                                              content_end_index - 1)

      local rendered = {}
      if (t[opening_index].element == "link") then
        rendered = writer.link(mapped, reference.url,
                               reference.title, reference.attributes)
      end

      if (t[opening_index].element == "image") then
        rendered = writer.image(mapped, reference.url,
          self.parser_functions.parse_inlines_string(reference.title),
          reference.attributes)
      end

      if (t[opening_index].element == "note") then
        if (t[opening_index].link_type == "note_inline") then
          rendered = writer.note(mapped)
        end
        if (t[opening_index].link_type == "raw_note") then
          rendered = writer.note(reference)
        end
      end

      t[opening_index].rendered = rendered
      delete_parsed_content_in_range(t, opening_index + 1,
                                     closing_index)
      empty_content_in_range(t, opening_index, closing_index)
      disable_previous_link_openers(t, opening_index)
      disable_range(t, opening_index, closing_index)
    end

  local resolve_inline_following_content =
    function(t, closing_index, match_reference, match_link_attributes)
      local content = ""
      for i = closing_index + 1, #t do
        content = content .. t[i].content
      end

      local matching_content = parsers.succeed

      if match_reference then
        matching_content = matching_content
                         * parsers.inline_direct_ref_inside
      end

      if match_link_attributes then
        matching_content = matching_content
                         * Cg(Ct(parsers.attributes^-1), "attributes")
      end

      local matched = lpeg.match(Ct( matching_content
                                   * Cg(Cp(), "end_position")), content)

      local matched_count = matched.end_position - 1
      for i = closing_index + 1, #t do
        local value = t[i]

        local chars_left = matched_count
        matched_count = matched_count - #value.content

        if matched_count <= 0 then
          value.content = value.content:sub(chars_left + 1)
          break
        end

        value.content = ''
        value.is_active = false
      end

      local attributes = matched.attributes
      if attributes == nil or next(attributes) == nil then
        attributes = nil
      end

      return {
        url = matched.url or "",
        title = matched.title or "",
        attributes = attributes
      }
    end

  local function resolve_inline_link(t, opening_index, closing_index)
    local inline_content
      = resolve_inline_following_content(t, closing_index, true,
                                         t.match_link_attributes)
    render_link_or_image(t, opening_index, closing_index,
                         closing_index, inline_content)
  end

  local resolve_note_inline_link =
    function(t, opening_index, closing_index)
      local inline_content
        = resolve_inline_following_content(t, closing_index,
                                           false, false)
      render_link_or_image(t, opening_index, closing_index,
                           closing_index, inline_content)
    end

  local function resolve_shortcut_link(t, opening_index, closing_index)
    local content
      = collect_link_content(t, opening_index + 1, closing_index - 1)
    local r = self.lookup_reference(content)

    if r then
      local inline_content
        = resolve_inline_following_content(t, closing_index, false,
                                           t.match_link_attributes)
      r.attributes
        = join_attributes(r.attributes, inline_content.attributes)
      render_link_or_image(t, opening_index, closing_index,
                           closing_index, r)
    end
  end

  local function resolve_raw_note_link(t, opening_index, closing_index)
    local content
      = collect_link_content(t, opening_index + 1, closing_index - 1)
    local r = self.lookup_note_reference(content)

    if r then
      local parsed_ref = self.parser_functions.parse_blocks_nested(r)
      render_link_or_image(t, opening_index, closing_index,
                           closing_index, parsed_ref)
    end
  end

  local function resolve_full_link(t, opening_index, closing_index)
    local next_link_closing_index
      = find_next_link_closing_index(t, closing_index + 4)
    local next_link_content
      = collect_link_content(t, closing_index + 3,
                             next_link_closing_index - 1)
    local r = self.lookup_reference(next_link_content)

    if r then
      local inline_content
        = resolve_inline_following_content(t, next_link_closing_index,
                                           false,
                                           t.match_link_attributes)
      r.attributes
        = join_attributes(r.attributes, inline_content.attributes)
      render_link_or_image(t, opening_index, next_link_closing_index,
                           closing_index, r)
    else
      local text = string.format('Undefined link reference "%s"',
                                 next_link_content)
      local more = string.format("Look for the text `[...][%s]`.",
                                 next_link_content)
      t[opening_index].warning = writer.warning(text, more)
    end
  end

  local function resolve_collapsed_link(t, opening_index, closing_index)
    local next_link_closing_index
      = find_next_link_closing_index(t, closing_index + 4)
    local content
      = collect_link_content(t, opening_index + 1, closing_index - 1)
    local r = self.lookup_reference(content)

    if r then
      local inline_content
        = resolve_inline_following_content(t, closing_index, false,
                                           t.match_link_attributes)
      r.attributes
        = join_attributes(r.attributes, inline_content.attributes)
      render_link_or_image(t, opening_index, next_link_closing_index,
                           closing_index, r)
    else
      local text = string.format('Undefined link reference "%s"',
                                 content)
      local more = string.format("Look for the text `[%s][]`.",
                                 content)
      t[opening_index].warning = writer.warning(text, more)
    end
  end

  local function process_links_and_emphasis(t)
    for _,value in ipairs(t) do
      value.is_active = true
    end

    for i,value in ipairs(t) do
      if not value.is_closing
          or value.type ~= "delimiter"
          or not ( value.element == "link"
                or value.element == "image"
                or value.element == "note")
          or value.removed then
        goto continue
      end

      local opener_position = find_link_opener(t, 1, i - 1)
      if (opener_position == nil) then
        goto continue
      end

      local opening_delimiter = t[opener_position]
      opening_delimiter.removed = true

      local link_type = opening_delimiter.link_type

      if (link_type == "inline") then
        resolve_inline_link(t, opener_position, i)
      end
      if (link_type == "shortcut") then
        resolve_shortcut_link(t, opener_position, i)
      end
      if (link_type == "full") then
        resolve_full_link(t, opener_position, i)
      end
      if (link_type == "collapsed") then
        resolve_collapsed_link(t, opener_position, i)
      end
      if (link_type == "note_inline") then
        resolve_note_inline_link(t, opener_position, i)
      end
      if (link_type == "raw_note") then
        resolve_raw_note_link(t, opener_position, i)
      end

      ::continue::
    end

    t[#t].content = t[#t].content:gsub("%s*$","")

    process_emphasis(t, 1, #t)
    local final_result = collect_emphasis_content(t, 1, #t)
    return final_result
  end

  function self.defer_link_and_emphasis_processing(delimiter_table)
    return writer.defer_call(function()
      return process_links_and_emphasis(delimiter_table)
    end)
  end

  parsers.Str      = ( parsers.normalchar
                     * (parsers.normalchar + parsers.at)^0)
                   / writer.string

  parsers.Symbol   = (parsers.backtick^1 + V("SpecialChar"))
                   / writer.string

  parsers.Ellipsis = P("...") / writer.ellipsis

  parsers.Smart    = parsers.Ellipsis

  parsers.Code     = parsers.inticks / writer.code

  if options.blankBeforeBlockquote then
    parsers.bqstart = parsers.fail
  else
    parsers.bqstart = parsers.blockquote_start
  end

  if options.blankBeforeHeading then
    parsers.headerstart = parsers.fail
  else
    parsers.headerstart = parsers.atx_heading
  end

  if options.blankBeforeList then
    parsers.interrupting_bullets = parsers.fail
    parsers.interrupting_enumerators = parsers.fail
  else
    parsers.interrupting_bullets
      = parsers.bullet(parsers.dash, true)
      + parsers.bullet(parsers.asterisk, true)
      + parsers.bullet(parsers.plus, true)

    parsers.interrupting_enumerators
      = parsers.enumerator(parsers.period, true)
      + parsers.enumerator(parsers.rparent, true)
  end

  if options.html then
    parsers.html_interrupting
      = parsers.check_trail
      * ( parsers.html_incomplete_open_tag
        + parsers.html_incomplete_close_tag
        + parsers.html_incomplete_open_special_tag
        + parsers.html_comment_start
        + parsers.html_cdatasection_start
        + parsers.html_declaration_start
        + parsers.html_instruction_start
        - parsers.html_close_special_tag
        - parsers.html_empty_special_tag)
  else
    parsers.html_interrupting = parsers.fail
  end

  if options.blankBeforeHtmlBlock then
    parsers.html_interrupting = parsers.fail
  end

  parsers.ListStarter = parsers.starter

  parsers.EndlineExceptions
                     = parsers.blankline -- paragraph break
                     + parsers.eof       -- end of document
                     + parsers.bqstart
                     + parsers.thematic_break_lines
                     + parsers.interrupting_bullets
                     + parsers.interrupting_enumerators
                     + parsers.headerstart
                     + parsers.html_interrupting

  parsers.NoSoftLineBreakEndlineExceptions = parsers.EndlineExceptions

  parsers.endline = parsers.newline
                  * (parsers.check_minimal_indent
                    * -V("EndlineExceptions")
                    + parsers.check_optional_indent
                    * -V("EndlineExceptions")
                    * -V("ListStarter")) / function(_) return end
                  * parsers.spacechar^0

  parsers.Endline = parsers.endline
                  / writer.soft_line_break

  parsers.EndlineNoSub = parsers.endline

  parsers.NoSoftLineBreakEndline
                        = parsers.newline
                        * (parsers.check_minimal_indent
                          * -V("NoSoftLineBreakEndlineExceptions")
                          + parsers.check_optional_indent
                          * -V("NoSoftLineBreakEndlineExceptions")
                          * -V("ListStarter"))
                        * parsers.spacechar^0
                        / writer.space

  parsers.EndlineBreak = parsers.backslash * parsers.endline
                                           / writer.hard_line_break

  parsers.OptionalIndent
                     = parsers.spacechar^1 / writer.space

  parsers.Space      = parsers.spacechar^2 * parsers.endline
                                           / writer.hard_line_break
                     + parsers.spacechar^1
                     * parsers.endline^-1
                     * parsers.eof / self.expandtabs
                     + parsers.spacechar^1 * parsers.endline
                                           / writer.soft_line_break
                     + parsers.spacechar^1
                     * -parsers.newline / self.expandtabs
                     + parsers.spacechar^1
                     + ( parsers.spacechar
                       + parsers.html_space_entity_char)^1
                     * parsers.endline / writer.soft_line_break

  parsers.NonbreakingEndline
                    = parsers.endline
                    / writer.nbsp

  parsers.NonbreakingSpace
                  = parsers.spacechar^2 * parsers.endline
                                        / writer.nbsp
                  + parsers.spacechar^1
                  * parsers.endline^-1 * parsers.eof / ""
                  + parsers.spacechar^1 * parsers.endline
                                        * parsers.optionalspace
                                        / writer.nbsp
                  + parsers.spacechar^1 * parsers.optionalspace
                                        / writer.nbsp

function self.auto_link_url(url, attributes)
  return writer.link(writer.escape(url),
                     url, nil, attributes)
end
function self.auto_link_email(email, attributes)
  return writer.link(writer.escape(email),
                     "mailto:"..email,
                     nil, attributes)
end

  parsers.AutoLinkUrl = parsers.auto_link_url
                      / self.auto_link_url

  parsers.AutoLinkEmail
                      = parsers.auto_link_email
                      / self.auto_link_email

  parsers.AutoLinkRelativeReference
                      = parsers.auto_link_relative_reference
                      / self.auto_link_url

  parsers.LinkAndEmph = Ct(parsers.link_and_emph_table)
                      / self.defer_link_and_emphasis_processing

  parsers.EscapedChar = parsers.backslash
                      * C(parsers.escapable) / writer.string

  if options.htmlOutput == "commonmark" then
    parsers.InlineHtml
      = Cs(parsers.html_inline_comment)
      / self.parser_functions.parse_inlines_no_html
      / writer.inline_html_comment
      + Cs(parsers.html_any_empty_inline_tag)
      / writer.inline_html_empty_tag
      + Cs(parsers.html_inline_instruction)
      / writer.inline_html_processing_instruction
      + Cs(parsers.html_inline_cdatasection)
      / writer.inline_html_cdata_section
      + Cs(parsers.html_inline_declaration)
      / writer.inline_html_declaration
      + Cs(parsers.html_any_open_inline_tag)
      / writer.inline_html_open_tag
      + Cs(parsers.html_any_close_tag)
      / writer.inline_html_close_tag
  else
    parsers.InlineHtml = Cs(parsers.html_inline_comment)
                       / self.parser_functions.parse_inlines_no_html
                       / writer.inline_html_comment
                       + Cs( parsers.html_any_empty_inline_tag
                           + parsers.html_inline_instruction
                           + parsers.html_inline_cdatasection
                           + parsers.html_inline_declaration
                           + parsers.html_any_open_inline_tag
                           + parsers.html_any_close_tag)
                       / writer.inline_html_tag
  end

  parsers.HtmlEntity = parsers.html_entities / writer.string
  if options.htmlOutput == "commonmark" then
    parsers.DisplayHtml
      = parsers.check_trail
      * ( parsers.html_comment
        / self.parser_functions.parse_blocks_nested
        / writer.block_html_comment)
      + Cs(parsers.check_trail * parsers.html_special_block)
      / writer.block_html_cdata_element
      + Cs(parsers.check_trail * parsers.html_block)
      / writer.block_html_pcdata_element
      + Cs(parsers.check_trail * parsers.html_any_block)
      / writer.block_html_standalone_tag
      + Cs(parsers.check_trail * parsers.html_instruction)
      / writer.block_html_processing_instruction
      + Cs(parsers.check_trail * parsers.html_cdatasection)
      / writer.block_html_cdata_section
      + Cs(parsers.check_trail * parsers.html_declaration)
      / writer.block_html_declaration
  else
    parsers.DisplayHtml = Cs( parsers.check_trail
                            * ( parsers.html_comment
                              + parsers.html_special_block
                              + parsers.html_block
                              + parsers.html_any_block
                              + parsers.html_instruction
                              + parsers.html_cdatasection
                              + parsers.html_declaration))
                        / writer.block_html_element
  end

  parsers.indented_non_blank_line = parsers.indentedline
                                  - parsers.blankline

  parsers.Verbatim
    = Cs( parsers.check_code_trail
        * (parsers.line - parsers.blankline)
        * (( parsers.check_minimal_blank_indent_and_full_code_trail
           * parsers.blankline)^0
          * ( (parsers.check_minimal_indent / "")
            * parsers.check_code_trail
            * (parsers.line - parsers.blankline))^1)^0)
    / self.expandtabs / writer.verbatim

  parsers.Blockquote   = parsers.blockquote_body
                       / writer.blockquote

  parsers.ThematicBreak = parsers.thematic_break_lines
                        / writer.thematic_break

  parsers.Reference    = parsers.define_reference_parser
                       / self.register_link

  parsers.Paragraph   = parsers.freeze_trail
                      * (Ct((parsers.Inline)^1)
                      * (parsers.newline + parsers.eof)
                      * parsers.unfreeze_trail
                      / writer.paragraph)

  parsers.Plain        = parsers.nonindentspace * Ct(parsers.Inline^1)
                       / writer.plain

  if options.taskLists then
    parsers.tickbox = ( parsers.ticked_box
                      + parsers.halfticked_box
                      + parsers.unticked_box
                      ) / writer.tickbox
  else
     parsers.tickbox = parsers.fail
  end

  parsers.list_blank = parsers.conditionally_indented_blankline

  parsers.ref_or_block_list_separated
    = parsers.sep_group_no_output(parsers.list_blank)
    * parsers.minimally_indented_ref
    + parsers.block_sep_group(parsers.list_blank)
    * parsers.minimally_indented_block

  parsers.ref_or_block_non_separated
    = parsers.minimally_indented_ref
    + (parsers.succeed / writer.interblocksep)
    * parsers.minimally_indented_block
    - parsers.minimally_indented_blankline

  parsers.tight_list_loop_body_pair =
    parsers.create_loop_body_pair(
      parsers.ref_or_block_non_separated,
      parsers.minimally_indented_par_or_plain_no_blank,
      (parsers.succeed / writer.interblocksep),
      (parsers.succeed / writer.paragraphsep))

  parsers.loose_list_loop_body_pair =
    parsers.create_loop_body_pair(
      parsers.ref_or_block_list_separated,
      parsers.minimally_indented_par_or_plain,
      parsers.block_sep_group(parsers.list_blank),
      parsers.par_sep_group(parsers.list_blank))

  parsers.tight_list_content_loop
    = V("Block")
    * parsers.tight_list_loop_body_pair.block^0
    + (V("Paragraph") + V("Plain"))
    * parsers.ref_or_block_non_separated
    * parsers.tight_list_loop_body_pair.block^0
    +  (V("Paragraph") + V("Plain"))
    * parsers.tight_list_loop_body_pair.par^0

  parsers.loose_list_content_loop
    = V("Block")
    * parsers.loose_list_loop_body_pair.block^0
    + (V("Paragraph") + V("Plain"))
    * parsers.ref_or_block_list_separated
    * parsers.loose_list_loop_body_pair.block^0
    + (V("Paragraph") + V("Plain"))
    * parsers.loose_list_loop_body_pair.par^0

  parsers.list_item_tightness_condition
    = -#( parsers.list_blank^0
        * parsers.minimally_indented_ref_or_block_or_par)
    * remove_indent("li")
    + remove_indent("li")
    * parsers.fail

  parsers.indented_content_tight
    = Ct( (parsers.blankline / "")
        * #parsers.list_blank
        * remove_indent("li")
        + ( (V("Reference") + (parsers.blankline / ""))
          * parsers.check_minimal_indent
          * parsers.tight_list_content_loop
          + (V("Reference") + (parsers.blankline / ""))
          + (parsers.tickbox^-1 / writer.escape)
          * parsers.tight_list_content_loop
          )
        * parsers.list_item_tightness_condition)

  parsers.indented_content_loose
    = Ct( (parsers.blankline / "")
        * #parsers.list_blank
        + ( (V("Reference") + (parsers.blankline / ""))
          * parsers.check_minimal_indent
          * parsers.loose_list_content_loop
          + (V("Reference") + (parsers.blankline / ""))
          + (parsers.tickbox^-1 / writer.escape)
          * parsers.loose_list_content_loop))

  parsers.TightListItem = function(starter)
    return  -parsers.ThematicBreak
            * parsers.add_indent(starter, "li")
            * parsers.indented_content_tight
  end

  parsers.LooseListItem = function(starter)
    return  -parsers.ThematicBreak
            * parsers.add_indent(starter, "li")
            * parsers.indented_content_loose
            * remove_indent("li")
  end

  parsers.BulletListOfType = function(bullet_type)
    local bullet = parsers.bullet(bullet_type)
    return  ( Ct( parsers.TightListItem(bullet)
                * ( (parsers.check_minimal_indent / "")
                  * parsers.TightListItem(bullet)
                  )^0
              )
              * Cc(true)
              * -#( (parsers.list_blank^0 / "")
                  * parsers.check_minimal_indent
                  * (bullet - parsers.ThematicBreak)
              )
              + Ct( parsers.LooseListItem(bullet)
                  * ( (parsers.list_blank^0 / "")
                    * (parsers.check_minimal_indent / "")
                    * parsers.LooseListItem(bullet)
                    )^0
              )
              * Cc(false)
            ) / writer.bulletlist
  end

  parsers.BulletList = parsers.BulletListOfType(parsers.dash)
                     + parsers.BulletListOfType(parsers.asterisk)
                     + parsers.BulletListOfType(parsers.plus)

  local function ordered_list(items,tight,starter)
    local startnum = starter[2][1]
    if options.startNumber then
      startnum = tonumber(startnum) or 1  -- fallback for '#'
      if startnum ~= nil then
        startnum = math.floor(startnum)
      end
    else
      startnum = nil
    end
    return writer.orderedlist(items,tight,startnum)
  end

  parsers.OrderedListOfType = function(delimiter_type)
    local enumerator = parsers.enumerator(delimiter_type)
    return  Cg(enumerator, "listtype")
          * (Ct( parsers.TightListItem(Cb("listtype"))
               * ( (parsers.check_minimal_indent / "")
                 * parsers.TightListItem(enumerator))^0)
          * Cc(true)
          * -#((parsers.list_blank^0 / "")
              * parsers.check_minimal_indent * enumerator)
          + Ct( parsers.LooseListItem(Cb("listtype"))
              * ((parsers.list_blank^0 / "")
                * (parsers.check_minimal_indent / "")
                * parsers.LooseListItem(enumerator))^0)
          * Cc(false)
          ) * Ct(Cb("listtype")) / ordered_list
  end

  parsers.OrderedList = parsers.OrderedListOfType(parsers.period)
                      + parsers.OrderedListOfType(parsers.rparent)
  parsers.Blank        = parsers.blankline / ""
                       + V("Reference")
  function parsers.parse_heading_text(s)
    local inlines = self.parser_functions.parse_inlines(s)
    local flatten_inlines = self.writer.flatten_inlines
    self.writer.flatten_inlines = true
    local flat_text = self.parser_functions.parse_inlines(s)
    flat_text = util.rope_to_string(flat_text)
    self.writer.flatten_inlines = flatten_inlines
    return {flat_text, inlines}
  end

  -- parse atx header
  parsers.AtxHeading = parsers.check_trail_no_rem
                     * Cg(parsers.heading_start, "level")
                     * ((C( parsers.optionalspace
                          * parsers.hash^0
                          * parsers.optionalspace
                          * parsers.newline)
                        + parsers.spacechar^1
                        * C(parsers.line))
                       / strip_atx_end
                       / parsers.parse_heading_text)
                     * Cb("level")
                     / writer.heading

  parsers.heading_line  = parsers.linechar^1
                        - parsers.thematic_break_lines

  parsers.heading_text = parsers.heading_line
                       * ( (V("Endline") / "\n")
                         * ( parsers.heading_line
                           - parsers.heading_level))^0
                       * parsers.newline^-1

  parsers.SetextHeading = parsers.freeze_trail
                        * parsers.check_trail_no_rem
                        * #( parsers.heading_text
                           * parsers.check_minimal_indent
                           * parsers.check_trail
                           * parsers.heading_level)
                        * Cs(parsers.heading_text)
                        / parsers.parse_heading_text
                        * parsers.check_minimal_indent_and_trail
                        * parsers.heading_level
                        * parsers.newline
                        * parsers.unfreeze_trail
                        / writer.heading

  parsers.Heading = parsers.AtxHeading + parsers.SetextHeading
  function self.finalize_grammar(extensions)
    local walkable_syntax = (function(global_walkable_syntax)
      local local_walkable_syntax = {}
      for lhs, rule in pairs(global_walkable_syntax) do
        local_walkable_syntax[lhs] = util.table_copy(rule)
      end
      return local_walkable_syntax
    end)(walkable_syntax)
    local current_extension_name = nil
    self.insert_pattern = function(selector, pattern, pattern_name)
      assert(pattern_name == nil or type(pattern_name) == "string")
      local _, _, lhs, pos, rhs
        = selector:find("^(%a+)%s+([%a%s]+%a+)%s+(%a+)$")
      assert(lhs ~= nil,
        [[Expected selector in form ]]
        .. [["LHS (before|after|instead of) RHS", not "]]
        .. selector .. [["]])
      assert(walkable_syntax[lhs] ~= nil,
        [[Rule ]] .. lhs
        .. [[ -> ... does not exist in markdown grammar]])
      assert(pos == "before" or pos == "after" or pos == "instead of",
        [[Expected positional specifier "before", "after", ]]
        .. [[or "instead of", not "]]
        .. pos .. [["]])
      local rule = walkable_syntax[lhs]
      local index = nil
      for current_index, current_rhs in ipairs(rule) do
        if type(current_rhs) == "string" and current_rhs == rhs then
          index = current_index
          if pos == "after" then
            index = index + 1
          end
          break
        end
      end
      assert(index ~= nil,
        [[Rule ]] .. lhs .. [[ -> ]] .. rhs
          .. [[ does not exist in markdown grammar]])
      local accountable_pattern
      if current_extension_name then
        accountable_pattern
          = {pattern, current_extension_name, pattern_name}
      else
        assert(type(pattern) == "string",
          [[reader->insert_pattern() was called outside ]]
          .. [[an extension with ]]
          .. [[a PEG pattern instead of a rule name]])
        accountable_pattern = pattern
      end
      if pos == "instead of" then
        rule[index] = accountable_pattern
      else
        table.insert(rule, index, accountable_pattern)
      end
      -- TODO: Remove all occurrences of `pattern` after `index`
      --       to improve speed?
    end
    if options.htmlOverLinks then
      self.insert_pattern("Inline before AutoLinkUrl", "InlineHtml")
    end
    local syntax =
      { "Blocks",

        Blocks = V("InitializeState")
               * V("ExpectedJekyllData")
               * V("Blank")^0
               * ( V("Block")
                 * ( V("Blank")^0 * parsers.eof
                   + ( V("Blank")^2 / writer.paragraphsep
                     + V("Blank")^0 / writer.interblocksep
                     )
                   )
                 + ( V("Paragraph") + V("Plain") )
                 * ( V("Blank")^0 * parsers.eof
                   + ( V("Blank")^2 / writer.paragraphsep
                     + V("Blank")^0 / writer.interblocksep
                     )
                   )
                 * V("Block")
                 * ( V("Blank")^0 * parsers.eof
                   + ( V("Blank")^2 / writer.paragraphsep
                     + V("Blank")^0 / writer.interblocksep
                     )
                   )
                 + ( V("Paragraph") + V("Plain") )
                 * ( V("Blank")^0 * parsers.eof
                   + V("Blank")^0 / writer.paragraphsep
                   )
                 )^0,

        ExpectedJekyllData = parsers.succeed,

        Blank              = parsers.Blank,
        Reference          = parsers.Reference,

        Blockquote         = parsers.Blockquote,
        Verbatim           = parsers.Verbatim,
        ThematicBreak      = parsers.ThematicBreak,
        BulletList         = parsers.BulletList,
        OrderedList        = parsers.OrderedList,
        DisplayHtml        = parsers.DisplayHtml,
        Heading            = parsers.Heading,
        Paragraph          = parsers.Paragraph,
        Plain              = parsers.Plain,

        ListStarter        = parsers.ListStarter,
        EndlineExceptions  = parsers.EndlineExceptions,
        NoSoftLineBreakEndlineExceptions
                           = parsers.NoSoftLineBreakEndlineExceptions,

        Str                = parsers.Str,
        Space              = parsers.Space,
        OptionalIndent     = parsers.OptionalIndent,
        Endline            = parsers.Endline,
        EndlineNoSub       = parsers.EndlineNoSub,
        NoSoftLineBreakEndline
                           = parsers.NoSoftLineBreakEndline,
        EndlineBreak       = parsers.EndlineBreak,
        LinkAndEmph        = parsers.LinkAndEmph,
        Code               = parsers.Code,
        AutoLinkUrl        = parsers.AutoLinkUrl,
        AutoLinkEmail      = parsers.AutoLinkEmail,
        AutoLinkRelativeReference
                           = parsers.AutoLinkRelativeReference,
        InlineHtml         = parsers.InlineHtml,
        HtmlEntity         = parsers.HtmlEntity,
        EscapedChar        = parsers.EscapedChar,
        Smart              = parsers.Smart,
        Symbol             = parsers.Symbol,
        SpecialChar        = parsers.fail,
        InitializeState    = parsers.succeed,
      }
    self.update_rule = function(rule_name, get_pattern)
      assert(current_extension_name ~= nil)
      assert(syntax[rule_name] ~= nil,
        [[Rule ]] .. rule_name
        .. [[ -> ... does not exist in markdown grammar]])
      local previous_pattern
      local extension_name
      if walkable_syntax[rule_name] then
        local previous_accountable_pattern
          = walkable_syntax[rule_name][1]
        previous_pattern = previous_accountable_pattern[1]
        extension_name
          = previous_accountable_pattern[2]
          .. ", " .. current_extension_name
      else
        previous_pattern = nil
        extension_name = current_extension_name
      end
      local pattern
      if type(get_pattern) == "function" then
        pattern = get_pattern(previous_pattern)
      else
        assert(previous_pattern == nil,
               [[Rule ]] .. rule_name ..
               [[ has already been updated by ]] .. extension_name)
        pattern = get_pattern
      end
      local accountable_pattern = { pattern, extension_name, rule_name }
      walkable_syntax[rule_name] = { accountable_pattern }
    end
    local special_characters = {}
    self.add_special_character = function(c)
      table.insert(special_characters, c)
      syntax.SpecialChar = S(table.concat(special_characters, ""))
    end

    self.add_special_character("*")
    self.add_special_character("[")
    self.add_special_character("]")
    self.add_special_character("<")
    self.add_special_character("!")
    self.add_special_character("\\")
    self.initialize_named_group = function(name, value)
      local pattern = Ct("")
      if value ~= nil then
        pattern = pattern / value
      end
      syntax.InitializeState = syntax.InitializeState
                             * Cg(pattern, name)
    end
    self.initialize_named_group("indent_info")
    for _, extension in ipairs(extensions) do
      current_extension_name = extension.name
      extension.extend_writer(writer)
      extension.extend_reader(self)
    end
    current_extension_name = nil
    if options.debugExtensions then
      local sorted_lhs = {}
      for lhs, _ in pairs(walkable_syntax) do
        table.insert(sorted_lhs, lhs)
      end
      table.sort(sorted_lhs)

      local output_lines = {"{"}
      for lhs_index, lhs in ipairs(sorted_lhs) do
        local encoded_lhs = util.encode_json_string(lhs)
        table.insert(output_lines, [[    ]] ..encoded_lhs .. [[: []])
        local rule = walkable_syntax[lhs]
        for rhs_index, rhs in ipairs(rule) do
          local human_readable_rhs
          if type(rhs) == "string" then
            human_readable_rhs = rhs
          else
            local pattern_name
            if rhs[3] then
              pattern_name = rhs[3]
            else
              pattern_name = "Anonymous Pattern"
            end
            local extension_name = rhs[2]
            human_readable_rhs = pattern_name .. [[ (]]
                               .. extension_name .. [[)]]
          end
          local encoded_rhs
            = util.encode_json_string(human_readable_rhs)
          local output_line = [[        ]] .. encoded_rhs
          if rhs_index < #rule then
            output_line = output_line .. ","
          end
          table.insert(output_lines, output_line)
        end
        local output_line = "    ]"
        if lhs_index < #sorted_lhs then
          output_line = output_line .. ","
        end
        table.insert(output_lines, output_line)
      end
      table.insert(output_lines, "}")

      local output = table.concat(output_lines, "\n")
      local output_filename = options.debugExtensionsFileName
      local output_file = assert(io.open(output_filename, "w"),
        [[Could not open file "]] .. output_filename
        .. [[" for writing]])
      assert(output_file:write(output))
      assert(output_file:close())
    end
    for lhs, rule in pairs(walkable_syntax) do
      syntax[lhs] = parsers.fail
      for _, rhs in ipairs(rule) do
        local pattern
        if type(rhs) == "string" then
          pattern = V(rhs)
        else
          pattern = rhs[1]
          if type(pattern) == "string" then
            pattern = V(pattern)
          end
        end
        syntax[lhs] = syntax[lhs] + pattern
      end
    end
    if options.underscores then
      self.add_special_character("_")
    end

    if not options.codeSpans then
      syntax.Code = parsers.fail
    else
      self.add_special_character("`")
    end

    if not options.html then
      syntax.DisplayHtml = parsers.fail
      syntax.InlineHtml = parsers.fail
      syntax.HtmlEntity  = parsers.fail
    else
      self.add_special_character("&")
    end

    if options.preserveTabs then
      options.stripIndent = false
    end

    if not options.smartEllipses then
      syntax.Smart = parsers.fail
    else
      self.add_special_character(".")
    end

    if not options.relativeReferences then
      syntax.AutoLinkRelativeReference = parsers.fail
    end

    if options.contentLevel == "inline" then
      syntax[1] = "Inlines"
      syntax.Inlines = V("InitializeState")
                      * parsers.Inline^0
                      * ( parsers.spacing^0
                        * parsers.eof / "")
      syntax.Space = parsers.Space + parsers.blankline / writer.space
    end

    local blocks_nested_t = util.table_copy(syntax)
    blocks_nested_t.ExpectedJekyllData = parsers.succeed
    parsers.blocks_nested = Ct(blocks_nested_t)

    parsers.blocks = Ct(syntax)

    local inlines_t = util.table_copy(syntax)
    inlines_t[1] = "Inlines"
    inlines_t.Inlines = V("InitializeState")
                      * parsers.Inline^0
                      * ( parsers.spacing^0
                        * parsers.eof / "")
    parsers.inlines = Ct(inlines_t)

    local inlines_no_inline_note_t = util.table_copy(inlines_t)
    inlines_no_inline_note_t.InlineNote = parsers.fail
    parsers.inlines_no_inline_note = Ct(inlines_no_inline_note_t)

    local inlines_no_html_t = util.table_copy(inlines_t)
    inlines_no_html_t.DisplayHtml = parsers.fail
    inlines_no_html_t.InlineHtml = parsers.fail
    inlines_no_html_t.HtmlEntity = parsers.fail
    parsers.inlines_no_html = Ct(inlines_no_html_t)

    local inlines_nbsp_t = util.table_copy(inlines_t)
    inlines_nbsp_t.Endline = parsers.NonbreakingEndline
    inlines_nbsp_t.Space = parsers.NonbreakingSpace
    parsers.inlines_nbsp = Ct(inlines_nbsp_t)

    local inlines_identity_t = util.table_copy(inlines_t)
    inlines_identity_t.Str = parsers.any / function(s) return s end
    parsers.inlines_identity = Ct(inlines_identity_t)

    local inlines_string_t = util.table_copy(inlines_t)
    inlines_string_t.Str = parsers.any / writer.string
    parsers.inlines_string = Ct(inlines_string_t)

    local inlines_math_t = util.table_copy(inlines_t)
    inlines_math_t.Str = parsers.any / writer.math
    parsers.inlines_math = Ct(inlines_math_t)

    local inlines_no_link_or_emphasis_t = util.table_copy(inlines_t)
    inlines_no_link_or_emphasis_t.LinkAndEmph = parsers.fail
    inlines_no_link_or_emphasis_t.EndlineExceptions
      = parsers.EndlineExceptions - parsers.eof
    parsers.inlines_no_link_or_emphasis
      = Ct(inlines_no_link_or_emphasis_t)
    return function(input)
      if options.unicodeNormalization then
        local form = options.unicodeNormalizationForm
        input = util.normalize(input, form)
      end
      input = input:gsub("\r\n?", "\n")
      if input:sub(-1) ~= "\n" then
        input = input .. "\n"
      end
      references = {}
      local document = self.parser_functions.parse_blocks(input)
      local output = util.rope_to_string(writer.document(document))
      local undosep_start, undosep_end
      local potential_secend_start, secend_start
      local potential_sep_start, sep_start
      while true do
        -- find a `writer->undosep`
        undosep_start, undosep_end
          = output:find(writer.undosep_text, 1, true)
        if undosep_start == nil then break end
        -- skip any preceding section ends
        secend_start = undosep_start
        while true do
          potential_secend_start = secend_start - #writer.secend_text
          if potential_secend_start < 1
             or output:sub(potential_secend_start,
                           secend_start - 1) ~= writer.secend_text
             then
            break
          end
          secend_start = potential_secend_start
        end
        -- find an immediately preceding
        -- block element / paragraph separator
        sep_start = secend_start
        potential_sep_start = sep_start - #writer.interblocksep_text
        if potential_sep_start >= 1
           and output:sub(potential_sep_start,
                          sep_start - 1) == writer.interblocksep_text
           then
          sep_start = potential_sep_start
        else
          potential_sep_start = sep_start - #writer.paragraphsep_text
          if potential_sep_start >= 1
             and output:sub(potential_sep_start,
                            sep_start - 1) == writer.paragraphsep_text
             then
            sep_start = potential_sep_start
          end
        end
        -- remove `writer->undosep` and immediately preceding
        -- block element / paragraph separator
        output = output:sub(1, sep_start - 1)
              .. output:sub(secend_start, undosep_start - 1)
              .. output:sub(undosep_end + 1)
      end
      return output
    end
  end
  return self
end
M.extensions = {}
M.extensions.acronyms = function(acronyms)
  assert(#acronyms > 0)
  return {
    name = "built-in acronyms syntax extension",
    extend_writer = function(self)
      function self.acronym(s)
        if self.flatten_inlines then return s end
        return {"\\markdownRendererAcronym{",s,"}"}
      end
    end, extend_reader = function(self)
      local parsers = self.parsers
      local options = self.options
      local writer = self.writer
      local prefix_tree = {_type = "intermediate"}
      for _, acronym in ipairs(acronyms) do
        local node = prefix_tree
        if options.unicodeNormalization then
          local form = options.unicodeNormalizationForm
          acronym = util.normalize(acronym, form)
        end
        for i = 1, #acronym do
          local acronym_byte = acronym:sub(i, i)
          if i < #acronym then
            if node[acronym_byte] == nil then
              node[acronym_byte] = {_type = "intermediate"}
            end
            node = node[acronym_byte]
          else
            table.insert(node, {acronym_byte, _type = "leaf"})
          end
        end
      end
      local subparsers = {}
      depth_first_search(prefix_tree, "", function(node, path)
        if node._type == "leaf" then
          local acronym_byte = table.unpack(node)
          if subparsers[path] == nil then
            subparsers[path] = parsers.fail
          end
          subparsers[path] = subparsers[path] + P(acronym_byte)
        end
      end, function(_, path)
        if #path > 0 then
          local byte = path:sub(#path, #path)
          local parent_path = path:sub(1, #path-1)
          local prefix = P(byte)
          local suffix = prefix * subparsers[path]
          if subparsers[parent_path] == nil then
            subparsers[parent_path] = parsers.fail
          end
          subparsers[parent_path] = subparsers[parent_path] + suffix
        end
      end)
      assert(subparsers[""] ~= nil)
      local Acronym = ( parsers.unicode.punctuation
                      - V("SpecialChar")
                      + parsers.unicode.whitespace
                      - V("EndlineExceptions"))^0
                    / writer.string
                    * (
                      subparsers[""]
                      * #(-parsers.normalchar
                         + parsers.unicode.punctuation
                         + parsers.unicode.whitespace
                         + parsers.eof)
                      / writer.acronym)
      self.insert_pattern("Inline before Str", Acronym, "Acronym")
    end
  }
end
M.extensions.bracketed_spans = function()
  return {
    name = "built-in bracketed_spans syntax extension",
    extend_writer = function(self)
      function self.span(s, attr)
        if self.flatten_inlines then return s end
        return {"\\markdownRendererBracketedSpanAttributeContextBegin",
                self.attributes(attr),
                "\\markdownRendererBracketedSpan{",s,"}",
                "\\markdownRendererBracketedSpanAttributeContextEnd{}"}
      end
    end, extend_reader = function(self)
      local parsers = self.parsers
      local writer = self.writer

      local span_label  = parsers.lbracket
                          * (Cs((parsers.alphanumeric^1
                              + parsers.inticks
                              + parsers.autolink
                              + V("InlineHtml")
                              + ( parsers.backslash * parsers.backslash)
                              + ( parsers.backslash
                                * (parsers.lbracket + parsers.rbracket)
                                + V("Space") + V("Endline")
                                + (parsers.any
                                  - ( parsers.newline
                                    + parsers.lbracket
                                    + parsers.rbracket
                                    + parsers.blankline^2))))^1)
                          / self.parser_functions.parse_inlines)
                          * parsers.rbracket

      local Span = span_label
                 * Ct(parsers.attributes)
                 / writer.span

      self.insert_pattern("Inline before LinkAndEmph",
                          Span, "Span")
    end
  }
end
M.extensions.citations = function(citation_nbsps)
  return {
    name = "built-in citations syntax extension",
    extend_writer = function(self)
      function self.citations(text_cites, cites)
        local buffer = {}
        if self.flatten_inlines then
          for _,cite in ipairs(cites) do
            if cite.prenote then
              table.insert(buffer, {cite.prenote, " "})
            end
            table.insert(buffer, cite.name)
            if cite.postnote then
              table.insert(buffer, {" ", cite.postnote})
            end
          end
        else
          table.insert(buffer,
                       {"\\markdownRenderer",
                        text_cites and "TextCite" or "Cite",
                        "{", #cites, "}"})
          for _,cite in ipairs(cites) do
            table.insert(buffer,
                         {cite.suppress_author and "-" or "+", "{",
                          cite.prenote or "", "}{",
                          cite.postnote or "", "}{", cite.name, "}"})
          end
        end
        return buffer
      end
    end, extend_reader = function(self)
      local parsers = self.parsers
      local writer = self.writer

      local citation_chars
                    = parsers.alphanumeric
                    + S("#$%&-+<>~/_")

      local citation_name
                    = Cs(parsers.dash^-1) * parsers.at
                    * Cs(citation_chars
                        * ((( citation_chars
                            + parsers.internal_punctuation
                            - parsers.comma - parsers.semicolon)
                           * -#(( parsers.internal_punctuation
                                - parsers.comma
                                - parsers.semicolon)^0
                               * -( citation_chars
                                  + parsers.internal_punctuation
                                  - parsers.comma
                                  - parsers.semicolon)))^0
                          * citation_chars)^-1)

      local citation_body_prenote
                    = Cs((parsers.alphanumeric^1
                         + parsers.bracketed
                         + parsers.inticks
                         + parsers.autolink
                         + V("InlineHtml")
                         + V("Space") + V("EndlineNoSub")
                         + (parsers.anyescaped
                           - ( parsers.newline
                             + parsers.rbracket
                             + parsers.blankline^2))
                         - ( parsers.spnl
                           * parsers.dash^-1
                           * parsers.at))^1)

      local citation_body_postnote
                    = Cs((parsers.alphanumeric^1
                         + parsers.bracketed
                         + parsers.inticks
                         + parsers.autolink
                         + V("InlineHtml")
                         + V("Space") + V("EndlineNoSub")
                         + (parsers.anyescaped
                           - ( parsers.newline
                             + parsers.rbracket
                             + parsers.semicolon
                             + parsers.blankline^2))
                         - (parsers.spnl * parsers.rbracket))^1)

      local citation_body_chunk
                    = ( citation_body_prenote
                      * parsers.spnlc_sep
                      + Cc("")
                      * parsers.spnlc
                    )
                    * citation_name
                    * ( parsers.internal_punctuation
                      - parsers.semicolon)^-1
                    * ( parsers.spnlc / function(_) return end
                      * citation_body_postnote
                      + Cc("")
                      * parsers.spnlc
                    )

      local citation_body
                    = citation_body_chunk
                    * ( parsers.semicolon
                      * parsers.spnlc
                      * citation_body_chunk
                    )^0

      local citation_headless_body_postnote
                    = Cs((parsers.alphanumeric^1
                         + parsers.bracketed
                         + parsers.inticks
                         + parsers.autolink
                         + V("InlineHtml")
                         + V("Space") + V("Endline")
                         + (parsers.anyescaped
                           - ( parsers.newline
                             + parsers.rbracket
                             + parsers.at
                             + parsers.semicolon + parsers.blankline^2))
                         - (parsers.spnl * parsers.rbracket))^0)

      local citation_headless_body
                    = citation_headless_body_postnote
                    * ( parsers.semicolon
                      * parsers.spnlc
                      * citation_body_chunk
                    )^0

      local citations
                    = function(text_cites, raw_cites)
          local function normalize(str)
              if str == "" then
                  str = nil
              else
                  str = (citation_nbsps and
                    self.parser_functions.parse_inlines_nbsp or
                    self.parser_functions.parse_inlines)(str)
              end
              return str
          end

          local cites = {}
          for i = 1,#raw_cites,4 do
              cites[#cites+1] = {
                  prenote = normalize(raw_cites[i]),
                  suppress_author = raw_cites[i+1] == "-",
                  name = writer.identifier(raw_cites[i+2]),
                  postnote = normalize(raw_cites[i+3]),
              }
          end
          return writer.citations(text_cites, cites)
      end

      local TextCitations
                    = Ct((parsers.spnlc
                    * Cc("")
                    * citation_name
                    * ((parsers.spnlc
                        * parsers.lbracket
                        * citation_headless_body
                        * parsers.rbracket) + Cc("")))^1)
                    / function(raw_cites)
                        return citations(true, raw_cites)
                      end

      local ParenthesizedCitations
                    = Ct((parsers.spnlc
                    * parsers.lbracket
                    * citation_body
                    * parsers.rbracket)^1)
                    / function(raw_cites)
                        return citations(false, raw_cites)
                      end

      local Citations = TextCitations + ParenthesizedCitations

      self.insert_pattern("Inline before LinkAndEmph",
                          Citations, "Citations")

      self.add_special_character("@")
      self.add_special_character("-")
    end
  }
end
M.extensions.content_blocks = function(language_map)
  local languages_json = (function()
    local base, prev, curr
    for _, pathname in ipairs(util.find_files(language_map)) do
      local file = io.open(pathname, "r")
      if not file then goto continue end
      local input = assert(file:read("*a"))
      assert(file:close())
      local json = input:gsub('("[^\n]-"):','[%1]=')
      curr = load("_ENV = {}; return "..json)()
      if type(curr) == "table" then
        if base == nil then
          base = curr
        else
          setmetatable(prev, { __index = curr })
        end
        prev = curr
      end
      ::continue::
    end
    return base or {}
  end)()

  return {
    name = "built-in content_blocks syntax extension",
    extend_writer = function(self)
      function self.contentblock(src,suf,type,tit)
        if not self.is_writing then return "" end
        src = src.."."..suf
        suf = suf:lower()
        if type == "onlineimage" then
          return {"\\markdownRendererContentBlockOnlineImage{",suf,"}",
                  "{",self.string(src),"}",
                  "{",self.uri(src),"}",
                  "{",self.string(tit or ""),"}"}
        elseif languages_json[suf] then
          return {"\\markdownRendererContentBlockCode{",suf,"}",
                  "{",self.string(languages_json[suf]),"}",
                  "{",self.string(src),"}",
                  "{",self.uri(src),"}",
                  "{",self.string(tit or ""),"}"}
        else
          return {"\\markdownRendererContentBlock{",suf,"}",
                  "{",self.string(src),"}",
                  "{",self.uri(src),"}",
                  "{",self.string(tit or ""),"}"}
        end
      end
    end, extend_reader = function(self)
      local parsers = self.parsers
      local writer = self.writer

      local contentblock_tail
                    = parsers.optionaltitle
                    * (parsers.newline + parsers.eof)

      -- case insensitive online image suffix:
      local onlineimagesuffix
                    = (function(...)
                        local parser = nil
                        for _, suffix in ipairs({...}) do
                          local pattern=nil
                          for i=1,#suffix do
                            local char=suffix:sub(i,i)
                            char = S(char:lower()..char:upper())
                            if pattern == nil then
                              pattern = char
                            else
                              pattern = pattern * char
                            end
                          end
                          if parser == nil then
                            parser = pattern
                          else
                            parser = parser + pattern
                          end
                        end
                        return parser
                      end)("png", "jpg", "jpeg", "gif", "tif", "tiff")

      -- online image url for iA Writer content blocks with
      -- mandatory suffix, allowing nested brackets:
      local onlineimageurl
                    = (parsers.less
                      * Cs((parsers.anyescaped
                           - parsers.more
                           - parsers.spacing
                           - #(parsers.period
                              * onlineimagesuffix
                              * parsers.more
                              * contentblock_tail))^0)
                      * parsers.period
                      * Cs(onlineimagesuffix)
                      * parsers.more
                      + (Cs((parsers.inparens
                            + (parsers.anyescaped
                              - parsers.spacing
                              - parsers.rparent
                              - #(parsers.period
                                 * onlineimagesuffix
                                 * contentblock_tail)))^0)
                        * parsers.period
                        * Cs(onlineimagesuffix))
                      ) * Cc("onlineimage")

      -- filename for iA Writer content blocks with mandatory suffix:
      local localfilepath
                    = parsers.slash
                    * Cs((parsers.anyescaped
                         - parsers.tab
                         - parsers.newline
                         - #(parsers.period
                            * parsers.alphanumeric^1
                            * contentblock_tail))^1)
                    * parsers.period
                    * Cs(parsers.alphanumeric^1)
                    * Cc("localfile")

      local ContentBlock
                    = parsers.check_trail_no_rem
                    * (localfilepath + onlineimageurl)
                    * contentblock_tail
                    / writer.contentblock

      self.insert_pattern("Block before Blockquote",
                          ContentBlock, "ContentBlock")
    end
  }
end
M.extensions.definition_lists = function(tight_lists)
  return {
    name = "built-in definition_lists syntax extension",
    extend_writer = function(self)
      local function dlitem(term, defs)
        local retVal = {"\\markdownRendererDlItem{",term,"}"}
        for _, def in ipairs(defs) do
          retVal[#retVal+1]
            = {"\\markdownRendererDlDefinitionBegin ",def,
               "\\markdownRendererDlDefinitionEnd "}
        end
        retVal[#retVal+1] = "\\markdownRendererDlItemEnd "
        return retVal
      end

      function self.definitionlist(items,tight)
        if not self.is_writing then return "" end
        local buffer = {}
        for _,item in ipairs(items) do
          buffer[#buffer + 1] = dlitem(item.term, item.definitions)
        end
        if tight and tight_lists then
          return {"\\markdownRendererDlBeginTight\n", buffer,
            "\n\\markdownRendererDlEndTight"}
        else
          return {"\\markdownRendererDlBegin\n", buffer,
            "\n\\markdownRendererDlEnd"}
        end
      end
    end, extend_reader = function(self)
      local parsers = self.parsers
      local writer = self.writer

      local defstartchar = S("~:")

      local defstart
        = parsers.check_trail_length(0) * defstartchar
        * #parsers.spacing
        * (parsers.tab + parsers.space^-3)
        + parsers.check_trail_length(1)
        * defstartchar * #parsers.spacing
        * (parsers.tab + parsers.space^-2)
        + parsers.check_trail_length(2)
        * defstartchar * #parsers.spacing
        * (parsers.tab + parsers.space^-1)
        + parsers.check_trail_length(3)
        * defstartchar * #parsers.spacing

      local indented_line
        = (parsers.check_minimal_indent / "")
        * parsers.check_code_trail * parsers.line

      local blank
        = parsers.check_minimal_blank_indent_and_any_trail
        * parsers.optionalspace * parsers.newline

      local dlchunk = Cs(parsers.line * (indented_line - blank)^0)

      local indented_blocks = function(bl)
        return Cs( bl
              * (blank^1 * (parsers.check_minimal_indent / "")
                * parsers.check_code_trail * -parsers.blankline * bl)^0
              * (blank^1 + parsers.eof))
      end

      local function definition_list_item(term, defs, _)
        return { term = self.parser_functions.parse_inlines(term),
                 definitions = defs }
      end

      local DefinitionListItemLoose
        = C(parsers.line) * blank^0
        * Ct((parsers.check_minimal_indent * (defstart
             * indented_blocks(dlchunk)
             / self.parser_functions.parse_blocks_nested))^1)
        * Cc(false) / definition_list_item

      local DefinitionListItemTight
        = C(parsers.line)
        * Ct((parsers.check_minimal_indent * (defstart * dlchunk
             / self.parser_functions.parse_blocks_nested))^1)
        * Cc(true) / definition_list_item

      local DefinitionList
        = ( Ct(DefinitionListItemLoose^1) * Cc(false)
          + Ct(DefinitionListItemTight^1)
          * (blank^0
            * -DefinitionListItemLoose * Cc(true))
          ) / writer.definitionlist

      self.insert_pattern("Block after Heading",
                          DefinitionList, "DefinitionList")
    end
  }
end
M.extensions.fancy_lists = function()
  return {
    name = "built-in fancy_lists syntax extension",
    extend_writer = function(self)
      local options = self.options

      function self.fancylist(items,tight,startnum,numstyle,numdelim)
        if not self.is_writing then return "" end
        local buffer = {}
        local num = startnum
        for _,item in ipairs(items) do
          if item ~= "" then
            buffer[#buffer + 1] = self.fancyitem(item,num)
          end
          if num ~= nil and item ~= "" then
            num = num + 1
          end
        end
        local contents = util.intersperse(buffer,"\n")
        if tight and options.tightLists then
          return {"\\markdownRendererFancyOlBeginTight{",
                  numstyle,"}{",numdelim,"}",contents,
                  "\n\\markdownRendererFancyOlEndTight "}
        else
          return {"\\markdownRendererFancyOlBegin{",
                  numstyle,"}{",numdelim,"}",contents,
                  "\n\\markdownRendererFancyOlEnd "}
        end
      end
      function self.fancyitem(s,num)
        if num ~= nil then
          return {"\\markdownRendererFancyOlItemWithNumber{",num,"}",s,
                  "\\markdownRendererFancyOlItemEnd "}
        else
          return {"\\markdownRendererFancyOlItem ",s,
                  "\\markdownRendererFancyOlItemEnd "}
        end
      end
    end, extend_reader = function(self)
      local parsers = self.parsers
      local options = self.options
      local writer = self.writer

      local function combine_markers_and_delims(markers, delims)
        local markers_table = {}
        for _,marker in ipairs(markers) do
          local start_marker
          local continuation_marker
          if type(marker) == "table" then
            start_marker = marker[1]
            continuation_marker = marker[2]
          else
            start_marker = marker
            continuation_marker = marker
          end
          for _,delim in ipairs(delims) do
            table.insert(markers_table,
                         {start_marker, continuation_marker, delim})
          end
        end
        return markers_table
      end

      local function join_table_with_func(func, markers_table)
        local pattern = func(table.unpack(markers_table[1]))
        for i = 2, #markers_table do
          pattern = pattern + func(table.unpack(markers_table[i]))
        end
        return pattern
      end

      local lowercase_letter_marker = R("az")
      local uppercase_letter_marker = R("AZ")

      local roman_marker = function(chars)
        local m, d, c = P(chars[1]), P(chars[2]), P(chars[3])
        local l, x, v, i
          = P(chars[4]), P(chars[5]), P(chars[6]), P(chars[7])
        return  m^-3
                * (c*m + c*d + d^-1 * c^-3)
                * (x*c + x*l + l^-1 * x^-3)
                * (i*x + i*v + v^-1 * i^-3)
      end

      local lowercase_roman_marker
        = roman_marker({"m", "d", "c", "l", "x", "v", "i"})
      local uppercase_roman_marker
        = roman_marker({"M", "D", "C", "L", "X", "V", "I"})

      local lowercase_opening_roman_marker  = P("i")
      local uppercase_opening_roman_marker  = P("I")

      local digit_marker = parsers.dig * parsers.dig^-8

      local markers = {
        {lowercase_opening_roman_marker, lowercase_roman_marker},
        {uppercase_opening_roman_marker, uppercase_roman_marker},
        lowercase_letter_marker,
        uppercase_letter_marker,
        lowercase_roman_marker,
        uppercase_roman_marker,
        digit_marker
      }

      local delims = {
        parsers.period,
        parsers.rparent
      }

      local markers_table = combine_markers_and_delims(markers, delims)

      local function enumerator(start_marker, _,
                                delimiter_type, interrupting)
        local delimiter_range
        local allowed_end
        if interrupting then
          delimiter_range = P("1")
          allowed_end = C(parsers.spacechar^1) * #parsers.linechar
        else
          delimiter_range = start_marker
          allowed_end = C(parsers.spacechar^1)
                      + #(parsers.newline + parsers.eof)
        end

        return parsers.check_trail
                * Ct(C(delimiter_range) * C(delimiter_type))
                * allowed_end
      end

      local starter = join_table_with_func(enumerator, markers_table)

      local TightListItem = function(starter)
        return  parsers.add_indent(starter, "li")
                * parsers.indented_content_tight
      end

      local LooseListItem = function(starter)
        return  parsers.add_indent(starter, "li")
                * parsers.indented_content_loose
                * remove_indent("li")
      end

      local function roman2number(roman)
        local romans = { ["M"] = 1000, ["D"] = 500, ["C"] = 100,
                         ["L"] = 50, ["X"] = 10, ["V"] = 5, ["I"] = 1 }
        local numeral = 0

        local i = 1
        local len = string.len(roman)
        while i < len do
          local z1, z2 = romans[ string.sub(roman, i, i) ],
                         romans[ string.sub(roman, i+1, i+1) ]
          if z1 < z2 then
              numeral = numeral + (z2 - z1)
              i = i + 2
          else
              numeral = numeral + z1
              i = i + 1
          end
        end
        if i <= len then
          numeral = numeral + romans[ string.sub(roman,i,i) ]
        end
        return numeral
      end

      local function sniffstyle(numstr, delimend)
        local numdelim
        if delimend == ")" then
          numdelim = "OneParen"
        elseif delimend == "." then
          numdelim = "Period"
        else
          numdelim = "Default"
        end

        local num
        num = numstr:match("^([I])$")
        if num then
          return roman2number(num), "UpperRoman", numdelim
        end
        num = numstr:match("^([i])$")
        if num then
          return roman2number(string.upper(num)), "LowerRoman", numdelim
        end
        num = numstr:match("^([A-Z])$")
        if num then
          return string.byte(num) - string.byte("A") + 1,
                 "UpperAlpha", numdelim
        end
        num = numstr:match("^([a-z])$")
        if num then
          return string.byte(num) - string.byte("a") + 1,
                 "LowerAlpha", numdelim
        end
        num = numstr:match("^([IVXLCDM]+)")
        if num then
          return roman2number(num), "UpperRoman", numdelim
        end
        num = numstr:match("^([ivxlcdm]+)")
        if num then
          return roman2number(string.upper(num)), "LowerRoman", numdelim
        end
        return math.floor(tonumber(numstr) or 1), "Decimal", numdelim
      end

      local function fancylist(items,tight,start)
        local startnum, numstyle, numdelim
          = sniffstyle(start[2][1], start[2][2])
        return writer.fancylist(items,tight,
                                options.startNumber and startnum or 1,
                                numstyle or "Decimal",
                                numdelim or "Default")
      end

      local FancyListOfType
        = function(start_marker, continuation_marker, delimiter_type)
          local enumerator_start
            = enumerator(start_marker, continuation_marker,
                         delimiter_type)
          local enumerator_cont
            = enumerator(continuation_marker, continuation_marker,
                         delimiter_type)
          return Cg(enumerator_start, "listtype")
               * (Ct( TightListItem(Cb("listtype"))
                   * ((parsers.check_minimal_indent / "")
                   * TightListItem(enumerator_cont))^0)
               * Cc(true)
               * -#((parsers.conditionally_indented_blankline^0 / "")
                   * parsers.check_minimal_indent * enumerator_cont)
               + Ct( LooseListItem(Cb("listtype"))
                   * ((parsers.conditionally_indented_blankline^0 / "")
                     * (parsers.check_minimal_indent / "")
                     * LooseListItem(enumerator_cont))^0)
               * Cc(false)
               ) * Ct(Cb("listtype")) / fancylist
        end

      local FancyList
        = join_table_with_func(FancyListOfType, markers_table)

      local ListStarter = starter

      self.update_rule("OrderedList", FancyList)
      self.update_rule("ListStarter", ListStarter)
    end
  }
end
M.extensions.fenced_code = function(blank_before_code_fence,
                                    allow_attributes,
                                    allow_raw_blocks)
  return {
    name = "built-in fenced_code syntax extension",
    extend_writer = function(self)
      local options = self.options

      function self.fencedCode(s, i, attr)
        if not self.is_writing then return "" end
        s = s:gsub("\n$", "")
        local buf = {}
        if attr ~= nil then
          table.insert(buf,
            {"\\markdownRendererFencedCodeAttributeContextBegin",
             self.attributes(attr)})
        end
        local name = util.cache_verbatim(options.cacheDir, s)
        table.insert(buf,
          {"\\markdownRendererInputFencedCode{",
           name,"}{",self.string(i),"}{",self.infostring(i),"}"})
        if attr ~= nil then
          table.insert(buf,
            "\\markdownRendererFencedCodeAttributeContextEnd{}")
        end
        return buf
      end

      if allow_raw_blocks then
        function self.rawBlock(s, attr)
          if not self.is_writing then return "" end
          s = s:gsub("\n$", "")
          local name = util.cache_verbatim(options.cacheDir, s)
          return {"\\markdownRendererInputRawBlock{",
                  name,"}{", self.string(attr),"}"}
        end
      end
    end, extend_reader = function(self)
      local parsers = self.parsers
      local writer = self.writer

      local function captures_geq_length(_,i,a,b)
        return #a >= #b and i
      end

      local function strip_enclosing_whitespaces(str)
        return str:gsub("^%s*(.-)%s*$", "%1")
      end

      local tilde_infostring = Cs(Cs((V("HtmlEntity")
                                     + parsers.anyescaped
                                     - parsers.newline)^0)
                                 / strip_enclosing_whitespaces)

      local backtick_infostring
        = Cs( Cs((V("HtmlEntity")
            + ( -#(parsers.backslash * parsers.backtick)
              * parsers.anyescaped)
              - parsers.newline
              - parsers.backtick)^0)
        / strip_enclosing_whitespaces)

      local fenceindent

      local function has_trail(indent_table)
        return indent_table ~= nil and
          indent_table.trail ~= nil and
          next(indent_table.trail) ~= nil
      end

      local function has_indents(indent_table)
        return indent_table ~= nil and
          indent_table.indents ~= nil and
          next(indent_table.indents) ~= nil
      end

      local function get_last_indent_name(indent_table)
        if has_indents(indent_table) then
          return indent_table.indents[#indent_table.indents].name
        end
      end

      local count_fenced_start_indent =
        function(_, _, indent_table, trail)
          local last_indent_name = get_last_indent_name(indent_table)
          fenceindent = 0
          if last_indent_name ~= "li" then
            fenceindent = #trail
          end
          return true
        end

      local fencehead = function(char, infostring)
        return Cmt( Cb("indent_info")
                  * parsers.check_trail, count_fenced_start_indent)
             * Cg(char^3, "fencelength")
             * parsers.optionalspace
             * infostring
             * (parsers.newline + parsers.eof)
      end

      local fencetail = function(char)
        return parsers.check_trail_no_rem
             * Cmt(C(char^3) * Cb("fencelength"), captures_geq_length)
             * parsers.optionalspace * (parsers.newline + parsers.eof)
             + parsers.eof
      end

      local process_fenced_line =
        function(s, i, -- luacheck: ignore s i
                 indent_table, line_content, is_blank)
          local remainder = ""
          if has_trail(indent_table) then
            remainder = indent_table.trail.internal_remainder
          end

          if is_blank
             and get_last_indent_name(indent_table) == "li" then
            remainder = ""
          end

          local str = remainder .. line_content
          local index = 1
          local remaining = fenceindent

          while true do
            local c = str:sub(index, index)
            if c == " " and remaining > 0 then
              remaining = remaining - 1
              index = index + 1
            elseif c == "\t" and remaining > 3 then
              remaining = remaining - 4
              index = index + 1
            else
              break
            end
          end

          return true, str:sub(index)
        end

      local fencedline = function(char)
        return Cmt( Cb("indent_info")
                  * C(parsers.line - fencetail(char))
                  * Cc(false), process_fenced_line)
      end

      local blankfencedline
        = Cmt( Cb("indent_info")
             * C(parsers.blankline)
             * Cc(true), process_fenced_line)

      local TildeFencedCode
        = fencehead(parsers.tilde, tilde_infostring)
        * Cs(( (parsers.check_minimal_blank_indent / "")
             * blankfencedline
             + ( parsers.check_minimal_indent / "")
               * fencedline(parsers.tilde))^0)
        * ( (parsers.check_minimal_indent / "")
          * fencetail(parsers.tilde) + parsers.succeed)

      local BacktickFencedCode
             = fencehead(parsers.backtick, backtick_infostring)
             * Cs(( (parsers.check_minimal_blank_indent / "")
                  * blankfencedline
                  + (parsers.check_minimal_indent / "")
                  * fencedline(parsers.backtick))^0)
             * ( (parsers.check_minimal_indent / "")
               * fencetail(parsers.backtick) + parsers.succeed)

      local infostring_with_attributes
                        = Ct(C((parsers.linechar
                              - ( parsers.optionalspace
                                * parsers.attributes))^0)
                            * parsers.optionalspace
                            * Ct(parsers.attributes))

      local FencedCode
        = ((TildeFencedCode + BacktickFencedCode)
        / function(infostring, code)
          local expanded_code = self.expandtabs(code)

          if allow_raw_blocks then
            local raw_attr = lpeg.match(parsers.raw_attribute,
                                        infostring)
            if raw_attr then
              return writer.rawBlock(expanded_code, raw_attr)
            end
          end

          local attr = nil
          if allow_attributes then
            local match = lpeg.match(infostring_with_attributes,
                                     infostring)
            if match then
              infostring, attr = table.unpack(match)
            end
          end
          return writer.fencedCode(expanded_code, infostring, attr)
        end)

      self.insert_pattern("Block after Verbatim",
                          FencedCode, "FencedCode")

      local fencestart
      if blank_before_code_fence then
        fencestart = parsers.fail
      else
        fencestart = fencehead(parsers.backtick, backtick_infostring)
                   + fencehead(parsers.tilde, tilde_infostring)
      end

      self.update_rule("EndlineExceptions", function(previous_pattern)
        if previous_pattern == nil then
          previous_pattern = parsers.EndlineExceptions
        end
        return previous_pattern + fencestart
      end)

      self.add_special_character("`")
      self.add_special_character("~")
    end
  }
end
M.extensions.fenced_divs = function(blank_before_div_fence)
  return {
    name = "built-in fenced_divs syntax extension",
    extend_writer = function(self)
      function self.div_begin(attributes)
        local start_output
          = {"\\markdownRendererFencedDivAttributeContextBegin\n",
             self.attributes(attributes)}
        local end_output
          = {"\\markdownRendererFencedDivAttributeContextEnd{}"}
        return self.push_attributes(
          "div", attributes, start_output, end_output)
      end
      function self.div_end()
        return self.pop_attributes("div")
      end
    end, extend_reader = function(self)
      local parsers = self.parsers
      local writer = self.writer
      local fenced_div_infostring
                             = Ct(parsers.attributes)
                             + (
                               C( parsers.attribute_classname
                                - parsers.colon)^1
                               / function (infostring)
                                 return {"." .. infostring}
                               end
                             )

      local fenced_div_begin = parsers.nonindentspace
                             * parsers.colon^3
                             * parsers.optionalspace
                             * fenced_div_infostring
                             * ( parsers.spacechar^1
                               * parsers.colon^1)^0
                             * parsers.optionalspace
                             * (parsers.newline + parsers.eof)

      local fenced_div_end = parsers.nonindentspace
                           * parsers.colon^3
                           * parsers.optionalspace
                           * (parsers.newline + parsers.eof)
      self.initialize_named_group("fenced_div_level", "0")
      self.initialize_named_group("fenced_div_num_opening_indents")

      local function increment_div_level()
        local push_indent_table =
          function(s, i, indent_table, -- luacheck: ignore s i
                   fenced_div_num_opening_indents, fenced_div_level)
            fenced_div_level = tonumber(fenced_div_level) + 1
            local num_opening_indents = 0
            if indent_table.indents ~= nil then
              num_opening_indents = #indent_table.indents
            end
            fenced_div_num_opening_indents[fenced_div_level]
              = num_opening_indents
            return true, fenced_div_num_opening_indents
          end

        local increment_level =
          function(s, i, fenced_div_level) -- luacheck: ignore s i
            fenced_div_level = tonumber(fenced_div_level) + 1
            return true, tostring(fenced_div_level)
          end

        return Cg( Cmt( Cb("indent_info")
                      * Cb("fenced_div_num_opening_indents")
                      * Cb("fenced_div_level"), push_indent_table)
                 , "fenced_div_num_opening_indents")
             * Cg( Cmt( Cb("fenced_div_level"), increment_level)
                 , "fenced_div_level")
      end

      local function decrement_div_level()
        local pop_indent_table =
          function(s, i, -- luacheck: ignore s i
                   fenced_div_indent_table, fenced_div_level)
            fenced_div_level = tonumber(fenced_div_level)
            fenced_div_indent_table[fenced_div_level] = nil
            return true, tostring(fenced_div_level - 1)
          end

        return Cg( Cmt( Cb("fenced_div_num_opening_indents")
                      * Cb("fenced_div_level"), pop_indent_table)
                 , "fenced_div_level")
      end

      local non_fenced_div_block
        = parsers.check_minimal_indent * V("Block")
        - parsers.check_minimal_indent_and_trail * fenced_div_end

      local non_fenced_div_paragraph
        = parsers.check_minimal_indent * V("Paragraph")
        - parsers.check_minimal_indent_and_trail * fenced_div_end

      local blank = parsers.minimally_indented_blank

      local block_separated = parsers.block_sep_group(blank)
                            * non_fenced_div_block

      local loop_body_pair
        = parsers.create_loop_body_pair(block_separated,
                                        non_fenced_div_paragraph,
                                        parsers.block_sep_group(blank),
                                        parsers.par_sep_group(blank))

      local content_loop  = ( non_fenced_div_block
                            * loop_body_pair.block^0
                            + non_fenced_div_paragraph
                            * block_separated
                            * loop_body_pair.block^0
                            + non_fenced_div_paragraph
                            * loop_body_pair.par^0)
                          * blank^0

      local FencedDiv = fenced_div_begin
                      / writer.div_begin
                      * increment_div_level()
                      * parsers.skipblanklines
                      * Ct(content_loop)
                      * parsers.minimally_indented_blank^0
                      * parsers.check_minimal_indent_and_trail
                      * fenced_div_end
                      * decrement_div_level()
                      * (Cc("") / writer.div_end)

      self.insert_pattern("Block after Verbatim",
                          FencedDiv, "FencedDiv")

      self.add_special_character(":")

      local function is_inside_div()
        local check_div_level =
          function(s, i, fenced_div_level) -- luacheck: ignore s i
            fenced_div_level = tonumber(fenced_div_level)
            return fenced_div_level > 0
          end

        return Cmt(Cb("fenced_div_level"), check_div_level)
      end

      local function check_indent()
        local compare_indent =
          function(s, i, indent_table, -- luacheck: ignore s i
                   fenced_div_num_opening_indents, fenced_div_level)
            fenced_div_level = tonumber(fenced_div_level)
            local num_current_indents
              = ( indent_table.current_line_indents ~= nil and
                 #indent_table.current_line_indents) or 0
            local num_opening_indents
              = fenced_div_num_opening_indents[fenced_div_level]
            return num_current_indents == num_opening_indents
          end

        return Cmt( Cb("indent_info")
                  * Cb("fenced_div_num_opening_indents")
                  * Cb("fenced_div_level"), compare_indent)
      end

      local fencestart = is_inside_div()
                       * fenced_div_end
                       * check_indent()

      if not blank_before_div_fence then
        self.update_rule("EndlineExceptions", function(previous_pattern)
          if previous_pattern == nil then
            previous_pattern = parsers.EndlineExceptions
          end
          return previous_pattern + fencestart
        end)
      end
    end
  }
end
M.extensions.header_attributes = function()
  return {
    name = "built-in header_attributes syntax extension",
    extend_writer = function()
    end, extend_reader = function(self)
      local parsers = self.parsers
      local writer = self.writer

      local function strip_atx_end(s)
        return s:gsub("%s+#*%s*$","")
      end

      local AtxHeading = Cg(parsers.heading_start, "level")
                       * parsers.optionalspace
                       * (C(((parsers.linechar
                              - (parsers.attributes
                                * parsers.optionalspace
                                * parsers.newline))
                             * (parsers.linechar
                               - parsers.lbrace)^0)^1)
                             / strip_atx_end
                             / parsers.parse_heading_text)
                       * Cg(Ct(parsers.newline
                              + (parsers.attributes
                                * parsers.optionalspace
                                * parsers.newline)), "attributes")
                       * Cb("level")
                       * Cb("attributes")
                       / writer.heading

      local function strip_trailing_spaces(s)
        return s:gsub("%s*$","")
      end

      local heading_line  = (parsers.linechar
                            - (parsers.attributes
                              * parsers.optionalspace
                              * parsers.newline))^1
                          - parsers.thematic_break_lines

      local heading_text
        = heading_line
        * ( (V("Endline") / "\n")
          * (heading_line - parsers.heading_level))^0
        * parsers.newline^-1

      local SetextHeading
        = parsers.freeze_trail * parsers.check_trail_no_rem
        * #(heading_text
           * (parsers.attributes
             * parsers.optionalspace
             * parsers.newline)^-1
           * parsers.check_minimal_indent
           * parsers.check_trail
           * parsers.heading_level)
        * Cs(heading_text) / strip_trailing_spaces
        / parsers.parse_heading_text
        * Cg(Ct((parsers.attributes
              * parsers.optionalspace
              * parsers.newline)^-1), "attributes")
        * parsers.check_minimal_indent_and_trail * parsers.heading_level
        * Cb("attributes")
        * parsers.newline
        * parsers.unfreeze_trail
        / writer.heading

      local Heading = AtxHeading + SetextHeading
      self.update_rule("Heading", Heading)
    end
  }
end
M.extensions.inline_code_attributes = function()
  return {
    name = "built-in inline_code_attributes syntax extension",
    extend_writer = function()
    end, extend_reader = function(self)
      local writer = self.writer

      local CodeWithAttributes = parsers.inticks
                               * Ct(parsers.attributes)
                               / writer.code

      self.insert_pattern("Inline before Code",
                          CodeWithAttributes,
                          "CodeWithAttributes")
    end
  }
end
M.extensions.line_blocks = function()
  return {
    name = "built-in line_blocks syntax extension",
    extend_writer = function(self)
      function self.lineblock(lines)
        if not self.is_writing then return "" end
        local buffer = {}
        for i = 1, #lines - 1 do
          buffer[#buffer + 1] = { lines[i], self.hard_line_break }
        end
        buffer[#buffer + 1] = lines[#lines]

        return {"\\markdownRendererLineBlockBegin\n"
                  ,buffer,
                  "\n\\markdownRendererLineBlockEnd "}
      end
    end, extend_reader = function(self)
      local parsers = self.parsers
      local writer = self.writer

      local LineBlock
        = Ct((Cs(( (parsers.pipe * parsers.space) / ""
                 * ((parsers.space)/entities.char_entity("nbsp"))^0
                 * parsers.linechar^0 * (parsers.newline/""))
                 * (-parsers.pipe
                   * (parsers.space^1/" ")
                   * parsers.linechar^1
                   * (parsers.newline/"")
                   )^0)
             / self.parser_functions.parse_inlines)^1)
        / writer.lineblock

      self.insert_pattern("Block after Blockquote",
                           LineBlock, "LineBlock")
    end
  }
end
M.extensions.mark = function()
  return {
    name = "built-in mark syntax extension",
    extend_writer = function(self)
      function self.mark(s)
        if self.flatten_inlines then return s end
        return {"\\markdownRendererMark{", s, "}"}
      end
    end, extend_reader = function(self)
      local parsers = self.parsers
      local writer = self.writer

      local doubleequals = P("==")

      local Mark
        = parsers.between(V("Inline"), doubleequals, doubleequals)
        / function (inlines) return writer.mark(inlines) end

      self.add_special_character("=")
      self.insert_pattern("Inline before LinkAndEmph",
                          Mark, "Mark")
    end
  }
end
M.extensions.link_attributes = function()
  return {
    name = "built-in link_attributes syntax extension",
    extend_writer = function()
    end, extend_reader = function(self)
      local parsers = self.parsers
      local options = self.options

      local define_reference_parser
        = (parsers.check_trail / "")
        * parsers.link_label
        * parsers.colon
        * parsers.spnlc * parsers.url
        * ( parsers.spnlc_sep * parsers.title
          * (parsers.spnlc * Ct(parsers.attributes))
          * parsers.only_blank
          + parsers.spnlc_sep * parsers.title * parsers.only_blank
          + Cc("") * (parsers.spnlc * Ct(parsers.attributes))
          * parsers.only_blank
          + Cc("") * parsers.only_blank)

      local ReferenceWithAttributes = define_reference_parser
                                    / self.register_link

      self.update_rule("Reference", ReferenceWithAttributes)


      local LinkWithAttributesAndEmph
        = Ct(parsers.link_and_emph_table * Cg(Cc(true),
             "match_link_attributes"))
        / self.defer_link_and_emphasis_processing

      self.update_rule("LinkAndEmph", LinkWithAttributesAndEmph)

      local AutoLinkUrlWithAttributes
                      = parsers.auto_link_url
                      * Ct(parsers.attributes)
                      / self.auto_link_url

      self.insert_pattern("Inline before AutoLinkUrl",
                          AutoLinkUrlWithAttributes,
                          "AutoLinkUrlWithAttributes")

      local AutoLinkEmailWithAttributes
                      = parsers.auto_link_email
                      * Ct(parsers.attributes)
                      / self.auto_link_email

      self.insert_pattern("Inline before AutoLinkEmail",
                          AutoLinkEmailWithAttributes,
                          "AutoLinkEmailWithAttributes")

      if options.relativeReferences then

        local AutoLinkRelativeReferenceWithAttributes
                        = parsers.auto_link_relative_reference
                        * Ct(parsers.attributes)
                        / self.auto_link_url

        self.insert_pattern(
          "Inline before AutoLinkRelativeReference",
          AutoLinkRelativeReferenceWithAttributes,
          "AutoLinkRelativeReferenceWithAttributes")

      end

    end
  }
end
M.extensions.notes = function(notes, inline_notes)
  assert(notes or inline_notes)
  return {
    name = "built-in notes syntax extension",
    extend_writer = function(self)
      function self.note(s)
        if self.flatten_inlines then return "" end
        return {"\\markdownRendererNote{",s,"}"}
      end
    end, extend_reader = function(self)
      local parsers = self.parsers
      local writer = self.writer

      local rawnotes = parsers.rawnotes

      if inline_notes then
        local InlineNote
          = parsers.circumflex
          * ( parsers.link_label
            / self.parser_functions.parse_inlines_no_inline_note)
          / writer.note

        self.insert_pattern("Inline after LinkAndEmph",
                            InlineNote, "InlineNote")
      end
      if notes then
        local function strip_first_char(s)
          return s:sub(2)
        end

        local RawNoteRef
                      = #(parsers.lbracket * parsers.circumflex)
                      * parsers.link_label / strip_first_char

        -- like indirect_link
        local function lookup_note(ref)
          return writer.defer_call(function()
            local found = rawnotes[self.normalize_tag(ref)]
            if found then
              return writer.note(
                self.parser_functions.parse_blocks_nested(found))
            else
              local text = string.format(
                'Undefined note reference "%s"', ref)
              local more = string.format(
                "Look for the text `[^%s]`.", ref)
              return {writer.warning(text, more), "[",
                self.parser_functions.parse_inlines("^" .. ref), "]"}
            end
          end)
        end

        local function register_note(ref,rawnote)
          local normalized_tag = self.normalize_tag(ref)
          if rawnotes[normalized_tag] == nil then
            rawnotes[normalized_tag] = rawnote
            return ""
          else
            local text
              = string.format('Multiply defined note reference "%s"',
                              ref)
            local more
              = string.format("Look for the text `[^%s]: ...`.", ref)
            return writer.warning(text, more)
          end
        end

        local NoteRef = RawNoteRef / lookup_note

        local optionally_indented_line
          = parsers.check_optional_indent_and_any_trail * parsers.line

        local blank
          = parsers.check_optional_blank_indent_and_any_trail
          * parsers.optionalspace * parsers.newline

        local chunk
          = Cs(parsers.line
          * (optionally_indented_line - blank)^0)

        local indented_blocks = function(bl)
          return Cs( bl
                * ( blank^1 * (parsers.check_optional_indent / "")
                  * parsers.check_code_trail
                  * -parsers.blankline * bl)^0)
        end

        local NoteBlock
                    = parsers.check_trail_no_rem
                    * RawNoteRef * parsers.colon
                    * parsers.spnlc * indented_blocks(chunk)
                    / register_note

        self.update_rule("Reference", function(previous_pattern)
          if previous_pattern == nil then
            previous_pattern = parsers.Reference
          end
          return NoteBlock + previous_pattern
        end)

        self.insert_pattern("Inline before LinkAndEmph",
                            NoteRef, "NoteRef")
      end

      self.add_special_character("^")
    end
  }
end
M.extensions.pipe_tables = function(table_captions, table_attributes)

  local function make_pipe_table_rectangular(rows)
    local num_columns = #rows[2]
    local rectangular_rows = {}
    for i = 1, #rows do
      local row = rows[i]
      local rectangular_row = {}
      for j = 1, num_columns do
        rectangular_row[j] = row[j] or ""
      end
      table.insert(rectangular_rows, rectangular_row)
    end
    return rectangular_rows
  end

  local function pipe_table_row(allow_empty_first_column
                               , nonempty_column
                               , column_separator
                               , column)
    local row_beginning
    if allow_empty_first_column then
      row_beginning = -- empty first column
                      #(parsers.spacechar^4
                       * column_separator)
                    * parsers.optionalspace
                    * column
                    * parsers.optionalspace
                    -- non-empty first column
                    + parsers.nonindentspace
                    * nonempty_column^-1
                    * parsers.optionalspace
    else
      row_beginning = parsers.nonindentspace
                    * nonempty_column^-1
                    * parsers.optionalspace
    end

    return Ct(row_beginning
             * (-- single column with no leading pipes
                #(column_separator
                 * parsers.optionalspace
                 * parsers.newline)
               * column_separator
               * parsers.optionalspace
               -- single column with leading pipes or
               -- more than a single column
               + (column_separator
                 * parsers.optionalspace
                 * column
                 * parsers.optionalspace)^1
               * (column_separator
                 * parsers.optionalspace)^-1))
  end

  return {
    name = "built-in pipe_tables syntax extension",
    extend_writer = function(self)
      function self.table(rows, caption, attributes)
        if not self.is_writing then return "" end
        local buffer = {}
        if attributes ~= nil then
          table.insert(buffer,
                       "\\markdownRendererTableAttributeContextBegin\n")
          table.insert(buffer, self.attributes(attributes))
        end
        table.insert(buffer,
                     {"\\markdownRendererTable{",
                      caption or "", "}{", #rows - 1, "}{",
                      #rows[1], "}"})
        local temp = rows[2] -- put alignments on the first row
        rows[2] = rows[1]
        rows[1] = temp
        for i, row in ipairs(rows) do
          table.insert(buffer, "{")
          for _, column in ipairs(row) do
            if i > 1 then -- do not use braces for alignments
              table.insert(buffer, "{")
            end
            table.insert(buffer, column)
            if i > 1 then
              table.insert(buffer, "}")
            end
          end
          table.insert(buffer, "}")
        end
        if attributes ~= nil then
          table.insert(buffer,
                       "\\markdownRendererTableAttributeContextEnd{}")
        end
        return buffer
      end
    end, extend_reader = function(self)
      local parsers = self.parsers
      local writer = self.writer

      local table_hline_separator = parsers.pipe + parsers.plus

      local table_hline_column = (parsers.dash
                                 - #(parsers.dash
                                    * (parsers.spacechar
                                      + table_hline_separator
                                      + parsers.newline)))^1
                               * (parsers.colon * Cc("r")
                                 + parsers.dash * Cc("d"))
                               + parsers.colon
                               * (parsers.dash
                                 - #(parsers.dash
                                    * (parsers.spacechar
                                      + table_hline_separator
                                      + parsers.newline)))^1
                               * (parsers.colon * Cc("c")
                                 + parsers.dash * Cc("l"))

      local table_hline = pipe_table_row(false
                                        , table_hline_column
                                        , table_hline_separator
                                        , table_hline_column)

      local table_caption_beginning
        = ( parsers.check_minimal_blank_indent_and_any_trail_no_rem
          * parsers.optionalspace * parsers.newline)^0
        * parsers.check_minimal_indent_and_trail
        * (P("Table")^-1 * parsers.colon)
        * parsers.optionalspace

      local function strip_trailing_spaces(s)
        return s:gsub("%s*$","")
      end

      local table_row
        = pipe_table_row(true
                        , (C((parsers.linechar - parsers.pipe)^1)
                          / strip_trailing_spaces
                          / self.parser_functions.parse_inlines)
                        , parsers.pipe
                        , (C((parsers.linechar - parsers.pipe)^0)
                          / strip_trailing_spaces
                          / self.parser_functions.parse_inlines))

      local table_caption
      if table_captions then
        table_caption = #table_caption_beginning
                      * table_caption_beginning
        if table_attributes then
          table_caption = table_caption
                        * (C(((( parsers.linechar
                               - (parsers.attributes
                                 * parsers.optionalspace
                                 * parsers.newline
                                 * -#( parsers.optionalspace
                                     * parsers.linechar)))
                              + ( parsers.newline
                                * #( parsers.optionalspace
                                   * parsers.linechar)
                                * C(parsers.optionalspace)
                                / writer.space))
                             * (parsers.linechar
                               - parsers.lbrace)^0)^1)
                             / strip_trailing_spaces
                             / self.parser_functions.parse_inlines)
                        * (parsers.newline
                          + ( Ct(parsers.attributes)
                            * parsers.optionalspace
                            * parsers.newline))
        else
          table_caption = table_caption
                        * C(( parsers.linechar
                            + ( parsers.newline
                              * #( parsers.optionalspace
                                 * parsers.linechar)
                              * C(parsers.optionalspace)
                              / writer.space))^1)
                        / self.parser_functions.parse_inlines
                        * parsers.newline
        end
      else
        table_caption = parsers.fail
      end

      local PipeTable
        = Ct( table_row * parsers.newline
            * (parsers.check_minimal_indent_and_trail / {})
          * table_hline * parsers.newline
          * ( (parsers.check_minimal_indent / {})
            * table_row * parsers.newline)^0)
        / make_pipe_table_rectangular
        * table_caption^-1
        / writer.table

      self.insert_pattern("Block after Blockquote",
                          PipeTable, "PipeTable")
    end
  }
end
M.extensions.raw_inline = function()
  return {
    name = "built-in raw_inline syntax extension",
    extend_writer = function(self)
      local options = self.options

      function self.rawInline(s, attr)
        if not self.is_writing then return "" end
        if self.flatten_inlines then return s end
        local name = util.cache_verbatim(options.cacheDir, s)
        return {"\\markdownRendererInputRawInline{",
                name,"}{", self.string(attr),"}"}
      end
    end, extend_reader = function(self)
      local writer = self.writer

      local RawInline = parsers.inticks
                      * parsers.raw_attribute
                      / writer.rawInline

      self.insert_pattern("Inline before Code",
                          RawInline, "RawInline")
    end
  }
end
M.extensions.strike_through = function()
  return {
    name = "built-in strike_through syntax extension",
    extend_writer = function(self)
      function self.strike_through(s)
        if self.flatten_inlines then return s end
        return {"\\markdownRendererStrikeThrough{",s,"}"}
      end
    end, extend_reader = function(self)
      local parsers = self.parsers
      local writer = self.writer

      local StrikeThrough = (
        parsers.between(parsers.Inline, parsers.doubletildes,
                        parsers.doubletildes)
      ) / writer.strike_through

      self.insert_pattern("Inline after LinkAndEmph",
                          StrikeThrough, "StrikeThrough")

      self.add_special_character("~")
    end
  }
end
M.extensions.subscripts = function()
  return {
    name = "built-in subscripts syntax extension",
    extend_writer = function(self)
      function self.subscript(s, parsed)
        if self.flatten_inlines then return s end
        return {"\\markdownRendererSubscript{",parsed,"}"}
      end
    end, extend_reader = function(self)
      local parsers = self.parsers
      local writer = self.writer

      local Subscript = (
        parsers.between(parsers.Str, parsers.tilde, parsers.tilde)
      ) / function(s)
            return writer.subscript(
              s, self.parser_functions.parse_inlines_identity(s[1])
            )
          end

      self.insert_pattern("Inline after LinkAndEmph",
                          Subscript, "Subscript")

      self.add_special_character("~")
    end
  }
end
M.extensions.superscripts = function()
  return {
    name = "built-in superscripts syntax extension",
    extend_writer = function(self)
      function self.superscript(s, parsed)
        if self.flatten_inlines then return s end
        return {"\\markdownRendererSuperscript{",parsed,"}"}
      end
    end, extend_reader = function(self)
      local parsers = self.parsers
      local writer = self.writer

      local Superscript = (
        parsers.between(parsers.Str, parsers.circumflex,
                        parsers.circumflex)
      ) / function(s)
            return writer.superscript(
              s, self.parser_functions.parse_inlines_identity(s[1])
            )
          end

      self.insert_pattern("Inline after LinkAndEmph",
                          Superscript, "Superscript")

      self.add_special_character("^")
    end
  }
end
M.extensions.tex_math = function(tex_math_dollars,
                                 tex_math_single_backslash,
                                 tex_math_double_backslash)
  return {
    name = "built-in tex_math syntax extension",
    extend_writer = function(self)
      function self.display_math(s, parsed)
        if self.flatten_inlines then return s end
        return {"\\markdownRendererDisplayMath{",parsed,"}"}
      end
      function self.inline_math(s, parsed)
        if self.flatten_inlines then return s end
        return {"\\markdownRendererInlineMath{",parsed,"}"}
      end
    end, extend_reader = function(self)
      local parsers = self.parsers
      local writer = self.writer

      local function between(p, starter, ender)
        return (starter * Cs(p * (p - ender)^0) * ender)
      end

      local function strip_preceding_whitespaces(str)
        return str:gsub("^%s*(.-)$", "%1")
      end

      local allowed_before_closing
        = B( parsers.backslash * parsers.any
           + parsers.any * (parsers.any - parsers.backslash))

      local allowed_before_closing_no_space
        = B( parsers.backslash * parsers.any
           + parsers.any * (parsers.nonspacechar - parsers.backslash))

      local dollar_math_content
        = (parsers.newline * (parsers.check_optional_indent / "")
        + parsers.backslash^-1
        * parsers.linechar)
        - parsers.blankline^2
        - parsers.dollar

      local inline_math_opening_dollars = parsers.dollar
                                        * #(parsers.nonspacechar)

      local inline_math_closing_dollars
        = allowed_before_closing_no_space
        * parsers.dollar
        * -#(parsers.digit)

      local inline_math_dollars = between(Cs( dollar_math_content),
                                          inline_math_opening_dollars,
                                          inline_math_closing_dollars)

      local display_math_opening_dollars  = parsers.dollar
                                          * parsers.dollar

      local display_math_closing_dollars  = parsers.dollar
                                          * parsers.dollar

      local display_math_dollars = between(Cs( dollar_math_content),
                                           display_math_opening_dollars,
                                           display_math_closing_dollars)
      local backslash_math_content
        = (parsers.newline * (parsers.check_optional_indent / "")
        + parsers.linechar)
        - parsers.blankline^2
      local inline_math_opening_double  = parsers.backslash
                                        * parsers.backslash
                                        * parsers.lparent

      local inline_math_closing_double  = allowed_before_closing
                                        * parsers.spacechar^0
                                        * parsers.backslash
                                        * parsers.backslash
                                        * parsers.rparent

      local inline_math_double  = between(Cs( backslash_math_content),
                                          inline_math_opening_double,
                                          inline_math_closing_double)
                                / strip_preceding_whitespaces

      local display_math_opening_double = parsers.backslash
                                        * parsers.backslash
                                        * parsers.lbracket

      local display_math_closing_double = allowed_before_closing
                                        * parsers.spacechar^0
                                        * parsers.backslash
                                        * parsers.backslash
                                        * parsers.rbracket

      local display_math_double = between(Cs( backslash_math_content),
                                          display_math_opening_double,
                                          display_math_closing_double)
                                / strip_preceding_whitespaces
      local inline_math_opening_single  = parsers.backslash
                                        * parsers.lparent

      local inline_math_closing_single  = allowed_before_closing
                                        * parsers.spacechar^0
                                        * parsers.backslash
                                        * parsers.rparent

      local inline_math_single  = between(Cs( backslash_math_content),
                                          inline_math_opening_single,
                                          inline_math_closing_single)
                                / strip_preceding_whitespaces

      local display_math_opening_single = parsers.backslash
                                        * parsers.lbracket

      local display_math_closing_single = allowed_before_closing
                                        * parsers.spacechar^0
                                        * parsers.backslash
                                        * parsers.rbracket

      local display_math_single = between(Cs( backslash_math_content),
                                          display_math_opening_single,
                                          display_math_closing_single)
                                / strip_preceding_whitespaces

      local display_math = parsers.fail

      local inline_math = parsers.fail

      if tex_math_dollars then
        display_math = display_math + display_math_dollars
        inline_math = inline_math + inline_math_dollars
      end

      if tex_math_double_backslash then
        display_math = display_math + display_math_double
        inline_math = inline_math + inline_math_double
      end

      if tex_math_single_backslash then
        display_math = display_math + display_math_single
        inline_math = inline_math + inline_math_single
      end

      local TexMath = display_math
                    / function(s)
                        return writer.display_math(
                          s, self.parser_functions.parse_inlines_math(s)
                        )
                      end
                    + inline_math
                    / function(s)
                        return writer.inline_math(
                          s, self.parser_functions.parse_inlines_math(s)
                        )
                      end

      self.insert_pattern("Inline after LinkAndEmph",
                          TexMath, "TexMath")

      if tex_math_dollars then
        self.add_special_character("$")
      end

      if tex_math_single_backslash or tex_math_double_backslash then
        self.add_special_character("\\")
        self.add_special_character("[")
        self.add_special_character("]")
        self.add_special_character(")")
        self.add_special_character("(")
      end
    end
  }
end
M.extensions.jekyll_data = function(expect_jekyll_data,
                                    ensure_jekyll_data)
  return {
    name = "built-in jekyll_data syntax extension",
    extend_writer = function(self)
      function self.jekyllData(d, t, p)
        if not self.is_writing then return "" end

        local buf = {}

        local keys = {}
        for k, _ in pairs(d) do
          table.insert(keys, k)
        end
        table.sort(keys, function(first, second)
          if type(first) ~= type(second) then
            return type(first) < type(second)
          else
            return first < second
          end
        end)

        if not p then
          table.insert(buf, "\\markdownRendererJekyllDataBegin")
        end

        local is_sequence = false
        if #d > 0 and #d == #keys then
          for i=1, #d do
            if d[i] == nil then
              goto not_a_sequence
            end
          end
          is_sequence = true
        end
        ::not_a_sequence::

        if is_sequence then
          table.insert(buf,
            "\\markdownRendererJekyllDataSequenceBegin{")
          table.insert(buf, self.identifier(p or "null"))
          table.insert(buf, "}{")
          table.insert(buf, #keys)
          table.insert(buf, "}")
        else
          table.insert(buf, "\\markdownRendererJekyllDataMappingBegin{")
          table.insert(buf, self.identifier(p or "null"))
          table.insert(buf, "}{")
          table.insert(buf, #keys)
          table.insert(buf, "}")
        end

        for _, k in ipairs(keys) do
          local v = d[k]
          local typ = type(v)
          k = tostring(k or "null")
          if typ == "table" and next(v) ~= nil then
            table.insert(
              buf,
              self.jekyllData(v, t, k)
            )
          else
            k = self.identifier(k)
            v = tostring(v)
            if typ == "boolean" then
              table.insert(buf, "\\markdownRendererJekyllDataBoolean{")
              table.insert(buf, k)
              table.insert(buf, "}{")
              table.insert(buf, v)
              table.insert(buf, "}")
            elseif typ == "number" then
              table.insert(buf, "\\markdownRendererJekyllDataNumber{")
              table.insert(buf, k)
              table.insert(buf, "}{")
              table.insert(buf, v)
              table.insert(buf, "}")
            elseif typ == "string" then
              table.insert(buf,
                "\\markdownRendererJekyllDataProgrammaticString{")
              table.insert(buf, k)
              table.insert(buf, "}{")
              table.insert(buf, self.identifier(v))
              table.insert(buf, "}")
              table.insert(buf,
                "\\markdownRendererJekyllDataTypographicString{")
              table.insert(buf, k)
              table.insert(buf, "}{")
              table.insert(buf, t(v))
              table.insert(buf, "}")
            elseif typ == "table" then
              table.insert(buf, "\\markdownRendererJekyllDataEmpty{")
              table.insert(buf, k)
              table.insert(buf, "}")
            else
              local error = self.error(format(
                "Unexpected type %s for value of "
                .. "YAML key %s.", typ, k))
              table.insert(buf, error)
            end
          end
        end

        if is_sequence then
          table.insert(buf, "\\markdownRendererJekyllDataSequenceEnd")
        else
          table.insert(buf, "\\markdownRendererJekyllDataMappingEnd")
        end

        if not p then
          table.insert(buf, "\\markdownRendererJekyllDataEnd")
        end

        return buf
      end
    end, extend_reader = function(self)
      local parsers = self.parsers
      local writer = self.writer

      local JekyllData
        = Cmt( C((parsers.line - P("---") - P("..."))^0)
             , function(s, i, text) -- luacheck: ignore s i
                 local data
                 local ran_ok, _ = pcall(function()
                   local tinyyaml = require("tinyyaml")
                   data = tinyyaml.parse(text, {timestamps=false})
                 end)
                 if ran_ok and data ~= nil then
                   return true, writer.jekyllData(data, function(s)
                     return self.parser_functions.parse_blocks_nested(s)
                   end, nil)
                 else
                   return false
                 end
               end
             )

      local UnexpectedJekyllData
        = P("---")
        * parsers.blankline / 0
        -- if followed by blank, it's thematic break
        * #(-parsers.blankline)
        * JekyllData
        * (P("---") + P("..."))

      local ExpectedJekyllData
        = ( P("---")
          * parsers.blankline / 0
          -- if followed by blank, it's thematic break
          * #(-parsers.blankline)
          )^-1
        * JekyllData
        * (P("---") + P("..."))^-1

      if ensure_jekyll_data then
        ExpectedJekyllData = ExpectedJekyllData
                           * parsers.eof
      else
        ExpectedJekyllData = ( ExpectedJekyllData
                             * (V("Blank")^0 / writer.interblocksep)
                             )^-1
      end

      self.insert_pattern("Block before Blockquote",
                          UnexpectedJekyllData, "UnexpectedJekyllData")
      if expect_jekyll_data then
        self.update_rule("ExpectedJekyllData", ExpectedJekyllData)
      end
    end
  }
end
function M.new(options)
  options = options or {}
  setmetatable(options, { __index = function (_, key)
    return defaultOptions[key] end })
  if options.experimental then
    setmetatable(options, { __index = function (_, key)
      return experimentalOptions[key] end })
  end
  if options.singletonCache and singletonCache.convert then
    for k, v in pairs(defaultOptions) do
      if type(v) == "table" then
        for i = 1, math.max(#singletonCache.options[k], #options[k]) do
          if singletonCache.options[k][i] ~= options[k][i] then
            goto miss
          end
        end
      elseif k ~= "cacheDir"
         and singletonCache.options[k] ~= options[k] then
        goto miss
      end
    end
    return singletonCache.convert
  end
  ::miss::
  local extensions = {}

  if #options.acronyms > 0 then
    local acronyms_extension = M.extensions.acronyms(options.acronyms)
    table.insert(extensions, acronyms_extension)
  end

  if options.bracketedSpans then
    local bracketed_spans_extension = M.extensions.bracketed_spans()
    table.insert(extensions, bracketed_spans_extension)
  end

  if options.contentBlocks then
    local content_blocks_extension = M.extensions.content_blocks(
      options.contentBlocksLanguageMap)
    table.insert(extensions, content_blocks_extension)
  end

  if options.definitionLists then
    local definition_lists_extension = M.extensions.definition_lists(
      options.tightLists)
    table.insert(extensions, definition_lists_extension)
  end

  if options.fencedCode then
    local fenced_code_extension = M.extensions.fenced_code(
      options.blankBeforeCodeFence,
      options.fencedCodeAttributes,
      options.rawAttribute)
    table.insert(extensions, fenced_code_extension)
  end

  if options.fencedDivs then
    local fenced_div_extension = M.extensions.fenced_divs(
      options.blankBeforeDivFence)
    table.insert(extensions, fenced_div_extension)
  end

  if options.headerAttributes then
    local header_attributes_extension = M.extensions.header_attributes()
    table.insert(extensions, header_attributes_extension)
  end

  if options.inlineCodeAttributes then
    local inline_code_attributes_extension =
      M.extensions.inline_code_attributes()
    table.insert(extensions, inline_code_attributes_extension)
  end

  if options.jekyllData then
    local jekyll_data_extension = M.extensions.jekyll_data(
      options.expectJekyllData, options.ensureJekyllData)
    table.insert(extensions, jekyll_data_extension)
  end

  if options.linkAttributes then
    local link_attributes_extension =
      M.extensions.link_attributes()
    table.insert(extensions, link_attributes_extension)
  end

  if options.lineBlocks then
    local line_block_extension = M.extensions.line_blocks()
    table.insert(extensions, line_block_extension)
  end

  if options.mark then
    local mark_extension = M.extensions.mark()
    table.insert(extensions, mark_extension)
  end

  if options.pipeTables then
    local pipe_tables_extension = M.extensions.pipe_tables(
      options.tableCaptions, options.tableAttributes)
    table.insert(extensions, pipe_tables_extension)
  end

  if options.rawAttribute then
    local raw_inline_extension = M.extensions.raw_inline()
    table.insert(extensions, raw_inline_extension)
  end

  if options.strikeThrough then
    local strike_through_extension = M.extensions.strike_through()
    table.insert(extensions, strike_through_extension)
  end

  if options.subscripts then
    local subscript_extension = M.extensions.subscripts()
    table.insert(extensions, subscript_extension)
  end

  if options.superscripts then
    local superscript_extension = M.extensions.superscripts()
    table.insert(extensions, superscript_extension)
  end

  if options.texMathDollars or
     options.texMathSingleBackslash or
     options.texMathDoubleBackslash then
    local tex_math_extension = M.extensions.tex_math(
      options.texMathDollars,
      options.texMathSingleBackslash,
      options.texMathDoubleBackslash)
    table.insert(extensions, tex_math_extension)
  end

  if options.notes or options.inlineNotes then
    local notes_extension = M.extensions.notes(
      options.notes, options.inlineNotes)
    table.insert(extensions, notes_extension)
  end

  if options.citations then
    local citations_extension
      = M.extensions.citations(options.citationNbsps)
    table.insert(extensions, citations_extension)
  end

  if options.fancyLists then
    local fancy_lists_extension = M.extensions.fancy_lists()
    table.insert(extensions, fancy_lists_extension)
  end
  for _, user_extension_filename in ipairs(options.extensions) do
    local user_extension = (function(filename)
      local pathname = assert(util.find_file(filename),
        [[Could not locate user-defined syntax extension "]]
        .. filename)
      local input_file = assert(io.open(pathname, "r"),
        [[Could not open user-defined syntax extension "]]
        .. pathname .. [[" for reading]])
      local input = assert(input_file:read("*a"))
      assert(input_file:close())
      local user_extension, err = load([[
        local sandbox = {}
        setmetatable(sandbox, {__index = _G})
        _ENV = sandbox
      ]] .. input)()
      assert(user_extension,
        [[Failed to compile user-defined syntax extension "]]
        .. pathname .. [[": ]] .. (err or [[]]))
      assert(user_extension.api_version ~= nil,
        [[User-defined syntax extension "]] .. pathname
        .. [[" does not specify mandatory field "api_version"]])
      assert(type(user_extension.api_version) == "number",
        [[User-defined syntax extension "]] .. pathname
        .. [[" specifies field "api_version" of type "]]
        .. type(user_extension.api_version)
        .. [[" but "number" was expected]])
      assert(user_extension.api_version > 0
         and user_extension.api_version
          <= metadata.user_extension_api_version,
        [[User-defined syntax extension "]] .. pathname
        .. [[" uses syntax extension API version "]]
        .. user_extension.api_version .. [[ but markdown.lua ]]
        .. metadata.version .. [[ uses API version ]]
        .. metadata.user_extension_api_version
        .. [[, which is incompatible]])

      assert(user_extension.grammar_version ~= nil,
        [[User-defined syntax extension "]] .. pathname
        .. [[" does not specify mandatory field "grammar_version"]])
      assert(type(user_extension.grammar_version) == "number",
        [[User-defined syntax extension "]] .. pathname
        .. [[" specifies field "grammar_version" of type "]]
        .. type(user_extension.grammar_version)
        .. [[" but "number" was expected]])
      assert(user_extension.grammar_version == metadata.grammar_version,
        [[User-defined syntax extension "]] .. pathname
        .. [[" uses grammar version "]]
        .. user_extension.grammar_version
        .. [[ but markdown.lua ]] .. metadata.version
        .. [[ uses grammar version ]] .. metadata.grammar_version
        .. [[, which is incompatible]])

      assert(user_extension.finalize_grammar ~= nil,
        [[User-defined syntax extension "]] .. pathname
        .. [[" does not specify mandatory "finalize_grammar" field]])
      assert(type(user_extension.finalize_grammar) == "function",
        [[User-defined syntax extension "]] .. pathname
        .. [[" specifies field "finalize_grammar" of type "]]
        .. type(user_extension.finalize_grammar)
        .. [[" but "function" was expected]])
      local extension = {
        name = [[user-defined "]] .. pathname .. [[" syntax extension]],
        extend_reader = user_extension.finalize_grammar,
        extend_writer = function() end,
      }
      return extension
    end)(user_extension_filename)
    table.insert(extensions, user_extension)
  end
  local writer = M.writer.new(options)
  local reader = M.reader.new(writer, options)
  local convert = reader.finalize_grammar(extensions)
  collectgarbage("collect")
  if options.singletonCache then
    local singletonCacheOptions = {}
    for k, v in pairs(options) do
      singletonCacheOptions[k] = v
    end
    setmetatable(singletonCacheOptions,
      { __index = function (_, key)
        return defaultOptions[key] end })
    singletonCache.options = singletonCacheOptions
    singletonCache.convert = convert
  end
  return convert
end
return M
