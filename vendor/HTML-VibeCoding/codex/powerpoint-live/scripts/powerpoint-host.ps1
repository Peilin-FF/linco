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
$script:LivePreviewWidth = 1400
$script:AgentLockPath = Join-Path (Join-Path $env:USERPROFILE '.linco') 'powerpoint-live-agent.lock'

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

function Has-Property($Object, [string] $Name) {
    return $null -ne $Object -and $Object.PSObject.Properties.Name -contains $Name
}

function Write-AtomicText([string] $Path, [string] $Content) {
    $parent = Split-Path -Parent $Path
    if ($parent) { [IO.Directory]::CreateDirectory($parent) | Out-Null }
    $temporaryPath = "$Path.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
    $backupPath = "$Path.$PID.bak"
    [IO.File]::WriteAllText($temporaryPath, $Content, [Text.UTF8Encoding]::new($false))
    try {
        for ($attempt = 0; $attempt -lt 6; $attempt++) {
            try {
                if ([IO.File]::Exists($Path)) {
                    [IO.File]::Replace($temporaryPath, $Path, $backupPath, $true)
                    if ([IO.File]::Exists($backupPath)) {
                        try { [IO.File]::Delete($backupPath) } catch {}
                    }
                } else {
                    [IO.File]::Move($temporaryPath, $Path)
                }
                return
            } catch {
                if ($attempt -ge 5) { throw }
                Start-Sleep -Milliseconds ([math]::Min(250, 20 * [math]::Pow(2, $attempt)))
            }
        }
    } finally {
        if ([IO.File]::Exists($temporaryPath)) {
            try { [IO.File]::Delete($temporaryPath) } catch {}
        }
        if ([IO.File]::Exists($backupPath)) {
            try { [IO.File]::Delete($backupPath) } catch {}
        }
    }
}

function Set-AgentBusy {
    $payload = [ordered]@{
        pid = $PID
        expires_at = [DateTimeOffset]::UtcNow.AddMinutes(10).ToUnixTimeMilliseconds()
    }
    Write-AtomicText $script:AgentLockPath ($payload | ConvertTo-Json -Compress)
}

function Clear-AgentBusy {
    try {
        if (-not [IO.File]::Exists($script:AgentLockPath)) { return }
        $payload = [IO.File]::ReadAllText($script:AgentLockPath) | ConvertFrom-Json
        if ([int] $payload.pid -eq $PID) { [IO.File]::Delete($script:AgentLockPath) }
    } catch {}
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

function Publish-LiveStatus(
    [int] $PreviewWidth = 1400,
    [bool] $IncludeFingerprint = $true
) {
    Ensure-Slide
    $lincoDirectory = Join-Path $env:USERPROFILE '.linco'
    $previewDirectory = Join-Path $lincoDirectory 'powerpoint-live-preview'
    [IO.Directory]::CreateDirectory($previewDirectory) | Out-Null
    $script:PreviewSequence += 1
    $previewPath = Join-Path $previewDirectory ("slide-{0}-{1}.png" -f $PID, $script:PreviewSequence)
    $previewWidth = [math]::Max(600, $PreviewWidth)
    $previewHeight = [int] [math]::Round(
        $previewWidth * $script:Presentation.PageSetup.SlideHeight / $script:Presentation.PageSetup.SlideWidth
    )
    $script:Slide.Export($previewPath, 'PNG', $previewWidth, $previewHeight)
    $fingerprint = $script:LastFingerprint
    if ($IncludeFingerprint -or [string]::IsNullOrEmpty($fingerprint)) {
        $fingerprint = Get-SlideFingerprint
        $script:LastFingerprint = $fingerprint
    }

    $descriptorPath = Join-Path $lincoDirectory 'powerpoint-live.json'
    $previousDescriptor = $null
    try {
        if ([IO.File]::Exists($descriptorPath)) {
            $previousDescriptor = [IO.File]::ReadAllText($descriptorPath) | ConvertFrom-Json
        }
    } catch {}
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
        monitor_pid = Get-Property $previousDescriptor 'monitor_pid' $null
        monitor_parent_pid = Get-Property $previousDescriptor 'monitor_parent_pid' $null
        monitor_protocol_version = Get-Property $previousDescriptor 'monitor_protocol_version' $null
    }
    Write-AtomicText $descriptorPath ($descriptor | ConvertTo-Json -Depth 5)
    if ($script:LastPreviewPath -and $script:LastPreviewPath -ne $previewPath) {
        try { [IO.File]::Delete($script:LastPreviewPath) } catch {}
    }
    $script:LastPreviewPath = $previewPath
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

function Set-ShapeText($Shape, $Parameters, [bool] $UseDefaults = $false) {
    if ($Shape.HasTextFrame -eq 0) { return }
    $textRuns = Get-Property $Parameters 'text_runs' $null
    $hasRuns = $null -ne $textRuns -and @($textRuns).Count -gt 0
    if ($hasRuns) {
        $builder = [Text.StringBuilder]::new()
        foreach ($run in @($textRuns)) { [void] $builder.Append([string] (Get-Property $run 'text' '')) }
        $Shape.TextFrame2.TextRange.Text = $builder.ToString()
    } elseif (Has-Property $Parameters 'text') {
        $Shape.TextFrame2.TextRange.Text = [string] $Parameters.text
    }

    $textRange = $Shape.TextFrame2.TextRange
    if ($UseDefaults -or (Has-Property $Parameters 'font_size')) {
        $textRange.Font.Size = [single] (Get-Property $Parameters 'font_size' 7)
    }
    if ($UseDefaults -or (Has-Property $Parameters 'bold')) {
        $textRange.Font.Bold = if (Get-Property $Parameters 'bold' $false) { -1 } else { 0 }
    }
    if ($UseDefaults -or (Has-Property $Parameters 'italic')) {
        $textRange.Font.Italic = if (Get-Property $Parameters 'italic' $false) { -1 } else { 0 }
    }
    $fontName = Get-Property $Parameters 'font_name' $null
    if ($fontName) { $textRange.Font.Name = [string] $fontName }
    if ($UseDefaults -or (Has-Property $Parameters 'font_color')) {
        $fontColor = Convert-HexColor (Get-Property $Parameters 'font_color' '#202124')
        if ($null -ne $fontColor) { $textRange.Font.Fill.ForeColor.RGB = $fontColor }
    }
    if ($UseDefaults -or (Has-Property $Parameters 'align')) {
        $alignment = [string] (Get-Property $Parameters 'align' 'center')
        $textRange.ParagraphFormat.Alignment = switch ($alignment) {
            'left' { 1 }
            'right' { 3 }
            default { 2 }
        }
    }
    if ($UseDefaults -or (Has-Property $Parameters 'vertical_align')) {
        $vertical = [string] (Get-Property $Parameters 'vertical_align' 'middle')
        $Shape.TextFrame2.VerticalAnchor = switch ($vertical) {
            'top' { 1 }
            'bottom' { 4 }
            default { 3 }
        }
    }
    $Shape.TextFrame2.AutoSize = 0
    $Shape.TextFrame2.WordWrap = -1
    if ($UseDefaults -or (Has-Property $Parameters 'margin')) {
        $margin = [single] (Get-Property $Parameters 'margin' 2)
        $Shape.TextFrame2.MarginLeft = $margin
        $Shape.TextFrame2.MarginRight = $margin
        $Shape.TextFrame2.MarginTop = $margin
        $Shape.TextFrame2.MarginBottom = $margin
    }

    if ($hasRuns) {
        $start = 1
        foreach ($run in @($textRuns)) {
            $runText = [string] (Get-Property $run 'text' '')
            $length = $runText.Length
            if ($length -le 0) { continue }
            $range = $textRange.Characters($start, $length)
            if (Has-Property $run 'font_size') { $range.Font.Size = [single] $run.font_size }
            if (Has-Property $run 'font_name') { $range.Font.Name = [string] $run.font_name }
            if (Has-Property $run 'font_color') {
                $runColor = Convert-HexColor ([string] $run.font_color)
                if ($null -ne $runColor) { $range.Font.Fill.ForeColor.RGB = $runColor }
            }
            if (Has-Property $run 'bold') { $range.Font.Bold = if ($run.bold) { -1 } else { 0 } }
            if (Has-Property $run 'italic') { $range.Font.Italic = if ($run.italic) { -1 } else { 0 } }
            if (Has-Property $run 'underline') { $range.Font.UnderlineStyle = if ($run.underline) { 1 } else { 0 } }
            $start += $length
        }
    }
}

function Set-ShapeStyle($Shape, $Parameters) {
    $fill = Get-Property $Parameters 'fill_color' $null
    if ($fill -eq 'none' -or $fill -eq 'transparent') {
        $Shape.Fill.Visible = 0
    } elseif ($fill) {
        $Shape.Fill.Visible = -1
        $Shape.Fill.Solid()
        $Shape.Fill.ForeColor.RGB = Convert-HexColor $fill
        $transparency = [single] (Get-Property $Parameters 'fill_transparency' 0)
        if ($transparency -lt 0 -or $transparency -gt 1) { throw 'fill_transparency must be between 0 and 1.' }
        $Shape.Fill.Transparency = $transparency
    } elseif (Has-Property $Parameters 'fill_transparency') {
        $transparency = [single] $Parameters.fill_transparency
        if ($transparency -lt 0 -or $transparency -gt 1) { throw 'fill_transparency must be between 0 and 1.' }
        $Shape.Fill.Transparency = $transparency
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
    Set-ShapeText $shape $Parameters $true
    return Shape-Summary $shape
}

function Add-Text($Parameters) {
    Ensure-Slide
    $shape = $script:Slide.Shapes.AddTextbox(
        1, [single] $Parameters.x, [single] $Parameters.y,
        [single] $Parameters.width, [single] $Parameters.height
    )
    $shape.Name = [string] $Parameters.name
    Set-ShapeText $shape $Parameters $true
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

function Invoke-DrawSequence($Parameters) {
    Ensure-Slide
    $operations = @($Parameters.operations)
    if ($operations.Count -lt 1) { throw 'draw_sequence requires at least one operation.' }
    $allowed = @(
        'new_slide', 'select_slide', 'clear', 'add_shape', 'add_text', 'add_connector',
        'connect_shapes', 'add_image', 'group', 'ungroup', 'align', 'distribute',
        'z_order', 'duplicate', 'update', 'delete'
    )
    $publishEvery = [math]::Max(1, [int] (Get-Property $Parameters 'publish_every_operations' 8))
    $publishInterval = [math]::Max(100, [int] (Get-Property $Parameters 'publish_interval_ms' 650))
    $previewWidth = [math]::Max(600, [int] (Get-Property $Parameters 'live_preview_width' $script:LivePreviewWidth))
    $stepDelay = [math]::Max(0, [int] (Get-Property $Parameters 'step_delay_ms' 0))
    $includeResults = [bool] (Get-Property $Parameters 'include_results' $false)
    $results = [Collections.Generic.List[object]]::new()
    $appliedCount = 0
    $failedIndex = $null
    $failure = $null
    $lastPublish = [Diagnostics.Stopwatch]::StartNew()

    Set-AgentBusy
    try {
        for ($index = 0; $index -lt $operations.Count; $index++) {
            $operation = $operations[$index]
            $command = [string] (Get-Property $operation 'type' '')
            if ($command -notin $allowed) {
                $failedIndex = $index
                $failure = "Unsupported draw_sequence operation: $command"
                break
            }
            try {
                $result = Invoke-Command ([pscustomobject]@{ command = $command; args = $operation })
                if ($includeResults) { $results.Add($result) }
                $appliedCount += 1
                $script:OperationCount += 1
                $script:LastOperation = $command
            } catch {
                $failedIndex = $index
                $failure = "$($_.Exception.Message) (line $($_.InvocationInfo.ScriptLineNumber))"
                break
            }

            $shouldPublish = ($appliedCount % $publishEvery -eq 0) -or
                ($lastPublish.ElapsedMilliseconds -ge $publishInterval)
            if ($shouldPublish -and $index -lt ($operations.Count - 1)) {
                Set-AgentBusy
                Publish-LiveStatus -PreviewWidth $previewWidth -IncludeFingerprint $false
                $lastPublish.Restart()
            }
            if ($stepDelay -gt 0) { Start-Sleep -Milliseconds $stepDelay }
        }
        $script:LastOperation = if ($null -eq $failure) { 'draw_sequence' } else { 'draw_sequence_partial' }
        Publish-LiveStatus -PreviewWidth $previewWidth -IncludeFingerprint $true
    } finally {
        Clear-AgentBusy
    }

    $response = [ordered]@{
        completed = $null -eq $failure
        operation_count = $operations.Count
        applied_count = $appliedCount
        failed_index = $failedIndex
        error = $failure
        preview_publish_every_operations = $publishEvery
        preview_publish_interval_ms = $publishInterval
        live_preview_width = $previewWidth
    }
    if ($includeResults) { $response.results = @($results) }
    return $response
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
        'draw_sequence' { return Invoke-DrawSequence $parameters }
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
            $names = @(Get-Property $parameters 'names' @())
            if ($names.Count -gt 0) {
                foreach ($name in $names) { $items += Shape-Summary (Get-Shape ([string] $name)) }
            } else {
                for ($i = 1; $i -le $script:Slide.Shapes.Count; $i++) { $items += Shape-Summary $script:Slide.Shapes.Item($i) }
            }
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
        $publishesAfterMutation = [string] $request.command -in @(
            'launch', 'new_slide', 'select_slide', 'clear', 'add_shape', 'add_text',
            'add_connector', 'connect_shapes', 'add_image', 'group', 'ungroup',
            'align', 'distribute', 'z_order', 'duplicate', 'update', 'delete', 'save'
        )
        $commandSucceeded = $false
        if ($publishesAfterMutation) { Set-AgentBusy }
        try {
            $result = Invoke-Command $request
            $commandSucceeded = $true
        } finally {
            if ($publishesAfterMutation -and -not $commandSucceeded) { Clear-AgentBusy }
        }
        if ($publishesAfterMutation) {
            $script:OperationCount += 1
            $script:LastOperation = [string] $request.command
            try {
                Publish-LiveStatus -PreviewWidth $script:LivePreviewWidth -IncludeFingerprint $true
            } finally {
                Clear-AgentBusy
            }
        }
        [Console]::Out.WriteLine((@{ id = $id; ok = $true; result = $result } | ConvertTo-Json -Depth 12 -Compress))
    } catch {
        $location = if ($_.InvocationInfo.ScriptLineNumber) { " (line $($_.InvocationInfo.ScriptLineNumber))" } else { '' }
        [Console]::Out.WriteLine((@{ id = $id; ok = $false; error = "$($_.Exception.Message)$location" } | ConvertTo-Json -Depth 5 -Compress))
    }
    [Console]::Out.Flush()
}
