$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$script:PowerPoint = $null
$script:Presentation = $null
$script:Slide = $null
$script:FilePath = $null
$script:PreviewSequence = 0
$script:LastPreviewPath = $null
$script:LastFingerprint = $null
$script:CanvasPreset = 'academic-wide'
$script:OperationCount = 0
$script:LastOperation = 'idle'

function Get-CanvasSize($Parameters) {
    $preset = [string] (Get-Property $Parameters 'canvas_preset' 'academic-wide')
    $sizes = @{
        'academic-wide' = @(516.0, 326.0)
        'academic-tall' = @(516.0, 482.0)
        'academic-single' = @(252.0, 252.0)
        'presentation-16x9' = @(960.0, 540.0)
    }
    if ($preset -eq 'custom') {
        return @(
            [single] (Get-Property $Parameters 'slide_width' 516),
            [single] (Get-Property $Parameters 'slide_height' 326)
        )
    }
    if (-not $sizes.ContainsKey($preset)) { throw "Unsupported canvas preset: $preset" }
    return $sizes[$preset]
}

function Convert-HexColor([string] $Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    $hex = $Value.Trim().TrimStart('#')
    if ($hex.Length -ne 6) { throw "Color must use #RRGGBB: $Value" }
    $r = [Convert]::ToInt32($hex.Substring(0, 2), 16)
    $g = [Convert]::ToInt32($hex.Substring(2, 2), 16)
    $b = [Convert]::ToInt32($hex.Substring(4, 2), 16)
    return $r + ($g -shl 8) + ($b -shl 16)
}

function Get-Property($Object, [string] $Name, $Default = $null) {
    if ($null -ne $Object -and $Object.PSObject.Properties.Name -contains $Name) {
        return $Object.$Name
    }
    return $Default
}

function Ensure-PowerPoint {
    if ($null -eq $script:PowerPoint) {
        try {
            $script:PowerPoint = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application')
        } catch {
            $script:PowerPoint = New-Object -ComObject PowerPoint.Application
        }
        $script:PowerPoint.Visible = -1
    }
}

function Get-NormalizedPath($Value) {
    try { return [IO.Path]::GetFullPath([string] $Value).TrimEnd([char] '\') } catch { return '' }
}

function Find-OpenPresentation([string] $Path) {
    $normalizedPath = Get-NormalizedPath $Path
    for ($i = 1; $i -le $script:PowerPoint.Presentations.Count; $i++) {
        $candidate = $script:PowerPoint.Presentations.Item($i)
        $candidatePath = Get-NormalizedPath $candidate.FullName
        if ($candidatePath.Equals($normalizedPath, [StringComparison]::OrdinalIgnoreCase)) {
            return $candidate
        }
    }
    return $null
}

function Show-PresentationSlide($Presentation, $Slide) {
    [void] $script:PowerPoint.Activate()
    $window = $null
    try {
        if ($Presentation.Windows.Count -gt 0) {
            $window = $Presentation.Windows.Item(1)
        }
    } catch {}
    if ($null -eq $window) {
        throw 'The target presentation has no visible PowerPoint window.'
    }
    [void] $window.Activate()
    [void] $window.View.GotoSlide($Slide.SlideIndex)
}

function Ensure-Slide {
    if ($null -eq $script:Presentation -or $null -eq $script:Slide) {
        throw 'Call powerpoint_live_launch first.'
    }
}

function Get-SlideFingerprint {
    Ensure-Slide
    $parts = [Collections.Generic.List[string]]::new()
    $parts.Add("slide=$($script:Slide.SlideIndex);count=$($script:Slide.Shapes.Count)")
    for ($i = 1; $i -le $script:Slide.Shapes.Count; $i++) {
        $shape = $script:Slide.Shapes.Item($i)
        $text = ''
        $fill = ''
        $line = ''
        try {
            if ($shape.HasTextFrame -ne 0 -and $shape.TextFrame2.HasText -ne 0) {
                $text = [string] $shape.TextFrame2.TextRange.Text
            }
        } catch {}
        try { $fill = "$($shape.Fill.Visible):$($shape.Fill.ForeColor.RGB):$($shape.Fill.Transparency)" } catch {}
        try { $line = "$($shape.Line.Visible):$($shape.Line.ForeColor.RGB):$($shape.Line.Weight):$($shape.Line.DashStyle)" } catch {}
        $parts.Add((
            '{0}|{1}|{2:N2}|{3:N2}|{4:N2}|{5:N2}|{6:N2}|{7}|{8}|{9}' -f
            $shape.Name, $shape.Type, $shape.Left, $shape.Top, $shape.Width,
            $shape.Height, $shape.Rotation, $text, $fill, $line
        ))
    }
    return [string]::Join("`n", $parts)
}

function Publish-LiveStatus {
    Ensure-Slide
    $lincoDirectory = Join-Path $env:USERPROFILE '.linco'
    $previewDirectory = Join-Path $lincoDirectory 'powerpoint-live-preview'
    [IO.Directory]::CreateDirectory($previewDirectory) | Out-Null
    $script:PreviewSequence += 1
    $previewPath = Join-Path $previewDirectory ("slide-{0}-{1}.png" -f $PID, $script:PreviewSequence)
    $previewWidth = 3200
    $previewHeight = [int] [math]::Round(
        $previewWidth * $script:Presentation.PageSetup.SlideHeight / $script:Presentation.PageSetup.SlideWidth
    )
    $script:Slide.Export($previewPath, 'PNG', $previewWidth, $previewHeight)
    $fingerprint = Get-SlideFingerprint

    $descriptor = [ordered]@{
        version = 1
        ready = $true
        file_path = $script:FilePath
        preview_path = $previewPath
        slide_index = [int] $script:Slide.SlideIndex
        slide_count = [int] $script:Presentation.Slides.Count
        shape_count = [int] $script:Slide.Shapes.Count
        slide_width = [double] $script:Presentation.PageSetup.SlideWidth
        slide_height = [double] $script:Presentation.PageSetup.SlideHeight
        canvas_preset = $script:CanvasPreset
        operation_count = $script:OperationCount
        last_operation = $script:LastOperation
        preview_pixel_width = $previewWidth
        preview_pixel_height = $previewHeight
        fingerprint = $fingerprint
        updated_at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        power_point_pid = $PID
    }
    $descriptorPath = Join-Path $lincoDirectory 'powerpoint-live.json'
    [IO.File]::WriteAllText(
        $descriptorPath,
        ($descriptor | ConvertTo-Json -Depth 5),
        [Text.UTF8Encoding]::new($false)
    )
    if ($script:LastPreviewPath -and $script:LastPreviewPath -ne $previewPath) {
        try { [IO.File]::Delete($script:LastPreviewPath) } catch {}
    }
    $script:LastPreviewPath = $previewPath
    $script:LastFingerprint = $fingerprint
}

function Sync-ActiveSlide {
    Ensure-Slide
    $activePresentation = $script:PowerPoint.ActivePresentation
    if ($null -eq $activePresentation) { return @{ changed = $false; reason = 'no-active-presentation' } }
    $activePath = ''
    try { $activePath = [IO.Path]::GetFullPath([string] $activePresentation.FullName) } catch {}
    if (-not $activePath.Equals($script:FilePath, [StringComparison]::OrdinalIgnoreCase)) {
        return @{ changed = $false; reason = 'different-presentation-active' }
    }

    $activeSlide = $script:PowerPoint.ActiveWindow.View.Slide
    if ($null -eq $activeSlide) { return @{ changed = $false; reason = 'no-active-slide' } }
    $slideChanged = [int] $activeSlide.SlideIndex -ne [int] $script:Slide.SlideIndex
    if ($slideChanged) { $script:Slide = $activeSlide }
    $fingerprint = Get-SlideFingerprint
    $contentChanged = $fingerprint -ne $script:LastFingerprint
    if ($slideChanged -or $contentChanged) {
        $script:OperationCount += 1
        $script:LastOperation = if ($slideChanged) { 'user_switch_slide' } else { 'user_edit' }
        Publish-LiveStatus
    }
    return @{
        changed = $slideChanged -or $contentChanged
        slide_changed = $slideChanged
        content_changed = $contentChanged
        slide_index = [int] $script:Slide.SlideIndex
        shape_count = [int] $script:Slide.Shapes.Count
    }
}

function Get-Shape([string] $Name) {
    Ensure-Slide
    try { return $script:Slide.Shapes.Item($Name) } catch { throw "Shape not found: $Name" }
}

function Set-ShapeText($Shape, $Parameters) {
    $text = Get-Property $Parameters 'text' $null
    if ($null -eq $text) { return }
    $Shape.TextFrame2.TextRange.Text = [string] $text
    $fontSize = [single] (Get-Property $Parameters 'font_size' 7)
    $Shape.TextFrame2.TextRange.Font.Size = $fontSize
    $Shape.TextFrame2.TextRange.Font.Bold = if (Get-Property $Parameters 'bold' $false) { -1 } else { 0 }
    $fontName = Get-Property $Parameters 'font_name' $null
    if ($fontName) { $Shape.TextFrame2.TextRange.Font.Name = [string] $fontName }
    $fontColor = Convert-HexColor (Get-Property $Parameters 'font_color' '#202124')
    if ($null -ne $fontColor) { $Shape.TextFrame2.TextRange.Font.Fill.ForeColor.RGB = $fontColor }
    $alignment = [string] (Get-Property $Parameters 'align' 'center')
    $Shape.TextFrame2.TextRange.ParagraphFormat.Alignment = switch ($alignment) {
        'left' { 1 }
        'right' { 3 }
        default { 2 }
    }
    $vertical = [string] (Get-Property $Parameters 'vertical_align' 'middle')
    $Shape.TextFrame2.VerticalAnchor = switch ($vertical) {
        'top' { 1 }
        'bottom' { 4 }
        default { 3 }
    }
    $Shape.TextFrame2.WordWrap = -1
    $Shape.TextFrame2.MarginLeft = [single] (Get-Property $Parameters 'margin' 2)
    $Shape.TextFrame2.MarginRight = [single] (Get-Property $Parameters 'margin' 2)
    $Shape.TextFrame2.MarginTop = [single] (Get-Property $Parameters 'margin' 2)
    $Shape.TextFrame2.MarginBottom = [single] (Get-Property $Parameters 'margin' 2)
}

function Set-ShapeStyle($Shape, $Parameters) {
    $fill = Get-Property $Parameters 'fill_color' $null
    if ($fill -eq 'none' -or $fill -eq 'transparent') {
        $Shape.Fill.Visible = 0
    } elseif ($fill) {
        $Shape.Fill.Visible = -1
        $Shape.Fill.Solid()
        $Shape.Fill.ForeColor.RGB = Convert-HexColor $fill
        $Shape.Fill.Transparency = [single] (Get-Property $Parameters 'fill_transparency' 0)
    }
    $stroke = Get-Property $Parameters 'stroke_color' $null
    if ($stroke -eq 'none' -or $stroke -eq 'transparent') {
        $Shape.Line.Visible = 0
    } elseif ($stroke) {
        $Shape.Line.Visible = -1
        $Shape.Line.ForeColor.RGB = Convert-HexColor $stroke
        $Shape.Line.Weight = [single] (Get-Property $Parameters 'stroke_width' 0.75)
    }
    if (Get-Property $Parameters 'dash' $false) { $Shape.Line.DashStyle = 4 }
    $rotation = Get-Property $Parameters 'rotation' $null
    if ($null -ne $rotation) { $Shape.Rotation = [single] $rotation }
}

function Add-Shape($Parameters) {
    Ensure-Slide
    $types = @{
        rectangle = 1; rounded = 5; ellipse = 9; diamond = 4; triangle = 7;
        hexagon = 10; parallelogram = 2; pentagon = 51; chevron = 52; cloud = 179
    }
    $kind = [string] (Get-Property $Parameters 'shape' 'rounded')
    if (-not $types.ContainsKey($kind)) { throw "Unsupported shape type: $kind" }
    $shape = $script:Slide.Shapes.AddShape(
        $types[$kind], [single] $Parameters.x, [single] $Parameters.y,
        [single] $Parameters.width, [single] $Parameters.height
    )
    $shape.Name = [string] $Parameters.name
    Set-ShapeStyle $shape $Parameters
    Set-ShapeText $shape $Parameters
    return Shape-Summary $shape
}

function Add-Text($Parameters) {
    Ensure-Slide
    $shape = $script:Slide.Shapes.AddTextbox(
        1, [single] $Parameters.x, [single] $Parameters.y,
        [single] $Parameters.width, [single] $Parameters.height
    )
    $shape.Name = [string] $Parameters.name
    Set-ShapeText $shape $Parameters
    Set-ShapeStyle $shape $Parameters
    return Shape-Summary $shape
}

function Add-Connector($Parameters) {
    Ensure-Slide
    $connectorType = if ((Get-Property $Parameters 'kind' 'straight') -eq 'elbow') { 2 } else { 1 }
    $shape = $script:Slide.Shapes.AddConnector(
        $connectorType, [single] $Parameters.x1, [single] $Parameters.y1,
        [single] $Parameters.x2, [single] $Parameters.y2
    )
    $shape.Name = [string] $Parameters.name
    Set-ShapeStyle $shape $Parameters
    $shape.Line.BeginArrowheadStyle = switch ([string] (Get-Property $Parameters 'start_arrow' 'none')) {
        'triangle' { 3 }
        'oval' { 6 }
        default { 1 }
    }
    $shape.Line.EndArrowheadStyle = switch ([string] (Get-Property $Parameters 'end_arrow' 'triangle')) {
        'none' { 1 }
        'oval' { 6 }
        default { 3 }
    }
    return Shape-Summary $shape
}

function Connect-Shapes($Parameters) {
    Ensure-Slide
    $source = Get-Shape ([string] $Parameters.source_name)
    $target = Get-Shape ([string] $Parameters.target_name)
    $connectorType = if ((Get-Property $Parameters 'kind' 'straight') -eq 'elbow') { 2 } else { 1 }
    $shape = $script:Slide.Shapes.AddConnector($connectorType, 0, 0, 100, 100)
    $shape.Name = [string] $Parameters.name
    try {
        $shape.ConnectorFormat.BeginConnect($source, [int] (Get-Property $Parameters 'source_site' 1))
        $shape.ConnectorFormat.EndConnect($target, [int] (Get-Property $Parameters 'target_site' 1))
        $shape.RerouteConnections()
    } catch {
        $shape.Delete()
        $shape = $script:Slide.Shapes.AddConnector(
            $connectorType,
            [single] ($source.Left + $source.Width),
            [single] ($source.Top + ($source.Height / 2)),
            [single] $target.Left,
            [single] ($target.Top + ($target.Height / 2))
        )
        $shape.Name = [string] $Parameters.name
    }
    Set-ShapeStyle $shape $Parameters
    $shape.Line.BeginArrowheadStyle = switch ([string] (Get-Property $Parameters 'start_arrow' 'none')) {
        'triangle' { 3 }
        'oval' { 6 }
        default { 1 }
    }
    $shape.Line.EndArrowheadStyle = switch ([string] (Get-Property $Parameters 'end_arrow' 'triangle')) {
        'none' { 1 }
        'oval' { 6 }
        default { 3 }
    }
    return Shape-Summary $shape
}

function Get-ShapeRange($Names) {
    Ensure-Slide
    $items = [object[]] @($Names | ForEach-Object { [string] $_ })
    if ($items.Count -lt 1) { throw 'At least one shape name is required.' }
    Write-Output -NoEnumerate ($script:Slide.Shapes.Range([object] $items))
}

function Add-Image($Parameters) {
    Ensure-Slide
    $path = [IO.Path]::GetFullPath([string] $Parameters.path)
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Image not found: $path" }
    $shape = $script:Slide.Shapes.AddPicture(
        $path, 0, -1, [single] $Parameters.x, [single] $Parameters.y,
        [single] $Parameters.width, [single] $Parameters.height
    )
    $shape.Name = [string] $Parameters.name
    return Shape-Summary $shape
}

function Shape-Summary($Shape) {
    $text = ''
    $textBoundsWidth = 0
    $textBoundsHeight = 0
    $autoShapeType = 0
    try {
        if ($Shape.HasTextFrame -ne 0 -and $Shape.TextFrame2.HasText -ne 0) {
            $text = [string] $Shape.TextFrame2.TextRange.Text
            $textBoundsWidth = [math]::Round([double] $Shape.TextFrame2.TextRange.BoundWidth, 2)
            $textBoundsHeight = [math]::Round([double] $Shape.TextFrame2.TextRange.BoundHeight, 2)
        }
    } catch {}
    try { $autoShapeType = [int] $Shape.AutoShapeType } catch {}
    return [ordered]@{
        name = [string] $Shape.Name
        type = [int] $Shape.Type
        x = [math]::Round([double] $Shape.Left, 2)
        y = [math]::Round([double] $Shape.Top, 2)
        width = [math]::Round([double] $Shape.Width, 2)
        height = [math]::Round([double] $Shape.Height, 2)
        rotation = [math]::Round([double] $Shape.Rotation, 2)
        text = $text
        text_bounds_width = $textBoundsWidth
        text_bounds_height = $textBoundsHeight
        auto_shape_type = $autoShapeType
    }
}

function Invoke-Command($Request) {
    $parameters = $Request.args
    switch ([string] $Request.command) {
        'launch' {
            Ensure-PowerPoint
            $path = [IO.Path]::GetFullPath([string] $parameters.file_path)
            $parent = Split-Path -Parent $path
            if ($parent) { [IO.Directory]::CreateDirectory($parent) | Out-Null }
            $script:Presentation = Find-OpenPresentation $path
            $reusedOpenPresentation = $null -ne $script:Presentation
            if ($reusedOpenPresentation) {
                $script:CanvasPreset = 'existing'
            } elseif (Test-Path -LiteralPath $path -PathType Leaf) {
                $script:Presentation = $script:PowerPoint.Presentations.Open($path, 0, 0, -1)
                $script:CanvasPreset = 'existing'
            } else {
                $script:Presentation = $script:PowerPoint.Presentations.Add(-1)
                $canvasSize = Get-CanvasSize $parameters
                $script:CanvasPreset = [string] (Get-Property $parameters 'canvas_preset' 'academic-wide')
                $script:Presentation.PageSetup.SlideWidth = [single] $canvasSize[0]
                $script:Presentation.PageSetup.SlideHeight = [single] $canvasSize[1]
                while ($script:Presentation.Slides.Count -gt 0) {
                    $script:Presentation.Slides.Item($script:Presentation.Slides.Count).Delete()
                }
                [void] $script:Presentation.Slides.Add(1, 12)
                $script:Presentation.SaveAs($path, 24)
            }
            if ($script:Presentation.Slides.Count -eq 0) {
                $script:Slide = $script:Presentation.Slides.Add(1, 12)
            } else {
                $index = [int] (Get-Property $parameters 'slide_index' 1)
                $script:Slide = $script:Presentation.Slides.Item($index)
            }
            $script:FilePath = $path
            Show-PresentationSlide $script:Presentation $script:Slide
            return @{
                file_path = $path
                slide_index = $script:Slide.SlideIndex
                shape_count = $script:Slide.Shapes.Count
                slide_width = $script:Presentation.PageSetup.SlideWidth
                slide_height = $script:Presentation.PageSetup.SlideHeight
                canvas_preset = $script:CanvasPreset
                reused_open_presentation = $reusedOpenPresentation
                presentation_count = $script:PowerPoint.Presentations.Count
            }
        }
        'new_slide' {
            Ensure-Slide
            $script:Slide = $script:Presentation.Slides.Add($script:Presentation.Slides.Count + 1, 12)
            Show-PresentationSlide $script:Presentation $script:Slide
            return @{ slide_index = $script:Slide.SlideIndex }
        }
        'select_slide' {
            Ensure-Slide
            $script:Slide = $script:Presentation.Slides.Item([int] $parameters.slide_index)
            Show-PresentationSlide $script:Presentation $script:Slide
            return @{ slide_index = $script:Slide.SlideIndex; shape_count = $script:Slide.Shapes.Count }
        }
        'clear' {
            Ensure-Slide
            for ($i = $script:Slide.Shapes.Count; $i -ge 1; $i--) { $script:Slide.Shapes.Item($i).Delete() }
            return @{ slide_index = $script:Slide.SlideIndex; shape_count = 0 }
        }
        'add_shape' { return Add-Shape $parameters }
        'add_text' { return Add-Text $parameters }
        'add_connector' { return Add-Connector $parameters }
        'connect_shapes' { return Connect-Shapes $parameters }
        'add_image' { return Add-Image $parameters }
        'group' {
            $range = Get-ShapeRange $parameters.names
            $group = $range.Group()
            $group.Name = [string] $parameters.name
            return Shape-Summary $group
        }
        'ungroup' {
            $range = (Get-Shape ([string] $parameters.name)).Ungroup()
            $items = @()
            for ($i = 1; $i -le $range.Count; $i++) { $items += Shape-Summary $range.Item($i) }
            return @{ ungrouped = [string] $parameters.name; shapes = $items }
        }
        'align' {
            $commands = @{ left = 0; center = 1; right = 2; top = 3; middle = 4; bottom = 5 }
            $mode = [string] $parameters.mode
            if (-not $commands.ContainsKey($mode)) { throw "Unsupported align mode: $mode" }
            $range = Get-ShapeRange $parameters.names
            $range.Align($commands[$mode], 0)
            return @{ aligned = @($parameters.names); mode = $mode }
        }
        'distribute' {
            $mode = [string] $parameters.mode
            $command = if ($mode -eq 'horizontal') { 0 } elseif ($mode -eq 'vertical') { 1 } else { throw "Unsupported distribute mode: $mode" }
            $range = Get-ShapeRange $parameters.names
            $range.Distribute($command, 0)
            return @{ distributed = @($parameters.names); mode = $mode }
        }
        'z_order' {
            $commands = @{ front = 0; back = 1; forward = 2; backward = 3 }
            $mode = [string] $parameters.mode
            if (-not $commands.ContainsKey($mode)) { throw "Unsupported z-order mode: $mode" }
            $shape = Get-Shape ([string] $parameters.name)
            $shape.ZOrder($commands[$mode])
            return Shape-Summary $shape
        }
        'duplicate' {
            $shape = Get-Shape ([string] $parameters.name)
            $duplicate = $shape.Duplicate().Item(1)
            $duplicate.Name = [string] $parameters.new_name
            $duplicate.Left = $shape.Left + [single] (Get-Property $parameters 'offset_x' 6)
            $duplicate.Top = $shape.Top + [single] (Get-Property $parameters 'offset_y' 6)
            return Shape-Summary $duplicate
        }
        'update' {
            $shape = Get-Shape ([string] $parameters.name)
            foreach ($property in @('x', 'y', 'width', 'height', 'rotation')) {
                $value = Get-Property $parameters $property $null
                if ($null -ne $value) {
                    switch ($property) {
                        'x' { $shape.Left = [single] $value }
                        'y' { $shape.Top = [single] $value }
                        'width' { $shape.Width = [single] $value }
                        'height' { $shape.Height = [single] $value }
                        'rotation' { $shape.Rotation = [single] $value }
                    }
                }
            }
            Set-ShapeStyle $shape $parameters
            Set-ShapeText $shape $parameters
            return Shape-Summary $shape
        }
        'delete' {
            (Get-Shape ([string] $parameters.name)).Delete()
            return @{ deleted = [string] $parameters.name }
        }
        'inspect' {
            Ensure-Slide
            $items = @()
            for ($i = 1; $i -le $script:Slide.Shapes.Count; $i++) { $items += Shape-Summary $script:Slide.Shapes.Item($i) }
            return @{ file_path = $script:FilePath; slide_index = $script:Slide.SlideIndex; slide_width = $script:Presentation.PageSetup.SlideWidth; slide_height = $script:Presentation.PageSetup.SlideHeight; canvas_preset = $script:CanvasPreset; shape_count = $items.Count; shapes = $items }
        }
        'sync' { return Sync-ActiveSlide }
        'export' {
            Ensure-Slide
            $path = [IO.Path]::GetFullPath([string] $parameters.output_path)
            $parent = Split-Path -Parent $path
            if ($parent) { [IO.Directory]::CreateDirectory($parent) | Out-Null }
            $width = [int] (Get-Property $parameters 'width' 3200)
            $height = [int] (Get-Property $parameters 'height' 0)
            if ($height -le 0) {
                $height = [int] [math]::Round(
                    $width * $script:Presentation.PageSetup.SlideHeight / $script:Presentation.PageSetup.SlideWidth
                )
            }
            $script:Slide.Export($path, 'PNG', $width, $height)
            return @{ output_path = $path; slide_index = $script:Slide.SlideIndex; width = $width; height = $height }
        }
        'save' {
            Ensure-Slide
            $script:Presentation.Save()
            return @{ file_path = $script:FilePath; slide_count = $script:Presentation.Slides.Count }
        }
        default { throw "Unknown command: $($Request.command)" }
    }
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
    $line = $line.TrimStart([char] 0xFEFF)
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $id = $null
    try {
        $request = $line | ConvertFrom-Json
        $id = $request.id
        $result = Invoke-Command $request
        if ([string] $request.command -in @(
            'launch', 'new_slide', 'select_slide', 'clear', 'add_shape', 'add_text',
            'add_connector', 'connect_shapes', 'add_image', 'group', 'ungroup',
            'align', 'distribute', 'z_order', 'duplicate', 'update', 'delete', 'save'
        )) {
            $script:OperationCount += 1
            $script:LastOperation = [string] $request.command
            Publish-LiveStatus
        }
        [Console]::Out.WriteLine((@{ id = $id; ok = $true; result = $result } | ConvertTo-Json -Depth 12 -Compress))
    } catch {
        $location = if ($_.InvocationInfo.ScriptLineNumber) { " (line $($_.InvocationInfo.ScriptLineNumber))" } else { '' }
        [Console]::Out.WriteLine((@{ id = $id; ok = $false; error = "$($_.Exception.Message)$location" } | ConvertTo-Json -Depth 5 -Compress))
    }
    [Console]::Out.Flush()
}
