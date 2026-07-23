param(
    [Parameter(Mandatory = $true)][int] $LincoPid,
    [int] $PollMilliseconds = 600
)

$ErrorActionPreference = 'Stop'
$logPath = Join-Path (Join-Path $env:USERPROFILE '.linco') 'powerpoint-monitor.log'

function Write-MonitorLog([string] $Message) {
    try {
        [IO.Directory]::CreateDirectory((Split-Path -Parent $logPath)) | Out-Null
        [IO.File]::AppendAllText(
            $logPath,
            "$(Get-Date -Format o) $Message`r`n",
            [Text.UTF8Encoding]::new($false)
        )
    } catch {}
}

function Parent-IsRunning {
    return $null -ne (Get-Process -Id $LincoPid -ErrorAction SilentlyContinue)
}

function Get-ActivePowerPoint {
    try { return [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application') }
    catch { return $null }
}

function Get-SlideFingerprint($Slide) {
    $parts = [Collections.Generic.List[string]]::new()
    $parts.Add("slide=$($Slide.SlideIndex);count=$($Slide.Shapes.Count)")
    for ($i = 1; $i -le $Slide.Shapes.Count; $i++) {
        $shape = $Slide.Shapes.Item($i)
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

function Read-Descriptor([string] $Path) {
    if (-not [IO.File]::Exists($Path)) { return $null }
    try { return ([IO.File]::ReadAllText($Path) | ConvertFrom-Json) }
    catch { return $null }
}

function Write-Descriptor($Presentation, $Slide, [string] $Fingerprint, [string] $Operation) {
    $lincoDirectory = Join-Path $env:USERPROFILE '.linco'
    $previewDirectory = Join-Path $lincoDirectory 'powerpoint-live-preview'
    [IO.Directory]::CreateDirectory($previewDirectory) | Out-Null
    $previewWidth = 3200
    $previewHeight = [int] [math]::Round(
        $previewWidth * $Presentation.PageSetup.SlideHeight / $Presentation.PageSetup.SlideWidth
    )
    $previewPath = Join-Path $previewDirectory ("monitor-{0}-{1}.png" -f $LincoPid, [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    $Slide.Export($previewPath, 'PNG', $previewWidth, $previewHeight)

    $descriptorPath = Join-Path $lincoDirectory 'powerpoint-live.json'
    $previous = Read-Descriptor $descriptorPath
    $operationCount = if ($null -ne $previous.operation_count) { [int] $previous.operation_count + 1 } else { 1 }
    $payload = [ordered]@{
        version = 1
        ready = $true
        file_path = [string] $Presentation.FullName
        preview_path = $previewPath
        slide_index = [int] $Slide.SlideIndex
        slide_count = [int] $Presentation.Slides.Count
        shape_count = [int] $Slide.Shapes.Count
        slide_width = [double] $Presentation.PageSetup.SlideWidth
        slide_height = [double] $Presentation.PageSetup.SlideHeight
        canvas_preset = 'existing'
        operation_count = $operationCount
        last_operation = $Operation
        preview_pixel_width = $previewWidth
        preview_pixel_height = $previewHeight
        fingerprint = $Fingerprint
        updated_at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        monitor_pid = $PID
        monitor_parent_pid = $LincoPid
    }
    [IO.File]::WriteAllText(
        $descriptorPath,
        ($payload | ConvertTo-Json -Depth 5),
        [Text.UTF8Encoding]::new($false)
    )
    if ($null -ne $previous -and [string] $previous.preview_path -like '*\powerpoint-live-preview\monitor-*.png') {
        try { [IO.File]::Delete([string] $previous.preview_path) } catch {}
    }
}

try {
    Write-MonitorLog "monitor started; linco_pid=$LincoPid monitor_pid=$PID"

    $lastFingerprint = $null
    $lastFilePath = $null
    $lastSlideIndex = 0
    while (Parent-IsRunning) {
        try {
            $powerPoint = Get-ActivePowerPoint
            if ($null -eq $powerPoint -or $null -eq $powerPoint.ActivePresentation -or $null -eq $powerPoint.ActiveWindow) {
                Start-Sleep -Milliseconds $PollMilliseconds
                continue
            }
            $presentation = $powerPoint.ActivePresentation
            $slide = $powerPoint.ActiveWindow.View.Slide
            if ($null -eq $slide) {
                Start-Sleep -Milliseconds $PollMilliseconds
                continue
            }
            $filePath = [string] $presentation.FullName
            $slideIndex = [int] $slide.SlideIndex
            $fingerprint = Get-SlideFingerprint $slide
            $descriptorPath = Join-Path (Join-Path $env:USERPROFILE '.linco') 'powerpoint-live.json'
            $descriptor = Read-Descriptor $descriptorPath
            $ownerPid = if ($null -ne $descriptor.monitor_parent_pid) { [int] $descriptor.monitor_parent_pid } else { 0 }
            if ($ownerPid -gt 0 -and $ownerPid -ne $LincoPid -and $null -ne (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue)) {
                Start-Sleep -Milliseconds $PollMilliseconds
                continue
            }
            if ($null -ne $descriptor -and
                [string] $descriptor.file_path -eq $filePath -and
                [int] $descriptor.slide_index -eq $slideIndex -and
                [string] $descriptor.fingerprint -eq $fingerprint) {
                $lastFilePath = $filePath
                $lastSlideIndex = $slideIndex
                $lastFingerprint = $fingerprint
            } elseif ($filePath -ne $lastFilePath -or $slideIndex -ne $lastSlideIndex -or $fingerprint -ne $lastFingerprint) {
                $operation = if ($filePath -ne $lastFilePath) {
                    'user_switch_presentation'
                } elseif ($slideIndex -ne $lastSlideIndex) {
                    'user_switch_slide'
                } else {
                    'user_edit'
                }
                Write-Descriptor $presentation $slide $fingerprint $operation
                $lastFilePath = $filePath
                $lastSlideIndex = $slideIndex
                $lastFingerprint = $fingerprint
            }
        } catch {
            Write-MonitorLog "sync error: $($_.Exception.Message) line=$($_.InvocationInfo.ScriptLineNumber)"
        }
        Start-Sleep -Milliseconds $PollMilliseconds
    }
} finally {
    Write-MonitorLog "monitor stopped; linco_pid=$LincoPid monitor_pid=$PID"
}
