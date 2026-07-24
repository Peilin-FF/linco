param(
    [Parameter(Mandatory = $true)][int] $LincoPid,
    [int] $PollMilliseconds = 900
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
    for ($attempt = 0; $attempt -lt 4; $attempt++) {
        try { return ([IO.File]::ReadAllText($Path) | ConvertFrom-Json) }
        catch {
            if ($attempt -ge 3) { return $null }
            Start-Sleep -Milliseconds (15 * ($attempt + 1))
        }
    }
    return $null
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

function Agent-IsBusy {
    $path = Join-Path (Join-Path $env:USERPROFILE '.linco') 'powerpoint-live-agent.lock'
    if (-not [IO.File]::Exists($path)) { return $false }
    try {
        $payload = [IO.File]::ReadAllText($path) | ConvertFrom-Json
        $expiresAt = [long] $payload.expires_at
        $owner = [int] $payload.pid
        if ($expiresAt -gt [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -and
            $null -ne (Get-Process -Id $owner -ErrorAction SilentlyContinue)) {
            return $true
        }
        [IO.File]::Delete($path)
    } catch {
        Start-Sleep -Milliseconds 30
        return [IO.File]::Exists($path)
    }
    return $false
}

function Write-Descriptor($Presentation, $Slide, [string] $Fingerprint, [string] $Operation) {
    $lincoDirectory = Join-Path $env:USERPROFILE '.linco'
    $previewDirectory = Join-Path $lincoDirectory 'powerpoint-live-preview'
    [IO.Directory]::CreateDirectory($previewDirectory) | Out-Null
    $previewWidth = 1400
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
        monitor_protocol_version = 2
    }
    Write-AtomicText $descriptorPath ($payload | ConvertTo-Json -Depth 5)
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
            $descriptorPath = Join-Path (Join-Path $env:USERPROFILE '.linco') 'powerpoint-live.json'
            $descriptor = Read-Descriptor $descriptorPath
            $ownerPid = if ($null -ne $descriptor.monitor_parent_pid) { [int] $descriptor.monitor_parent_pid } else { 0 }
            $ownerProtocol = if ($null -ne $descriptor.monitor_protocol_version) { [int] $descriptor.monitor_protocol_version } else { 1 }
            if ($ownerProtocol -ge 2 -and
                $ownerPid -gt 0 -and
                $ownerPid -ne $LincoPid -and
                $null -ne (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue)) {
                Start-Sleep -Milliseconds $PollMilliseconds
                continue
            }
            $takeOwnership = $null -eq $descriptor -or
                $ownerProtocol -lt 2 -or
                $ownerPid -le 0 -or
                $null -eq (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue)
            if (Agent-IsBusy) {
                Start-Sleep -Milliseconds $PollMilliseconds
                continue
            }
            $fingerprint = Get-SlideFingerprint $slide
            if (-not $takeOwnership -and
                $null -ne $descriptor -and
                [string] $descriptor.file_path -eq $filePath -and
                [int] $descriptor.slide_index -eq $slideIndex -and
                [string] $descriptor.fingerprint -eq $fingerprint) {
                $lastFilePath = $filePath
                $lastSlideIndex = $slideIndex
                $lastFingerprint = $fingerprint
            } elseif ($takeOwnership -or $filePath -ne $lastFilePath -or $slideIndex -ne $lastSlideIndex -or $fingerprint -ne $lastFingerprint) {
                $operation = if ($takeOwnership) {
                    'monitor_takeover'
                } elseif ($filePath -ne $lastFilePath) {
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
