param(
    [string] $OutputDirectory = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..\..'))
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $projectRoot 'artifacts\PowerPoint-live-acceptance\live-progress'
}
$outputPath = [IO.Path]::GetFullPath($OutputDirectory)
$artifactRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'artifacts'))
if (-not $outputPath.StartsWith($artifactRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Acceptance output must stay inside $artifactRoot"
}

[IO.Directory]::CreateDirectory($outputPath) | Out-Null
$presentationPath = Join-Path $outputPath 'live-progress.pptx'
if (Test-Path -LiteralPath $presentationPath -PathType Leaf) {
    try {
        $runningPowerPoint = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application')
        for ($index = $runningPowerPoint.Presentations.Count; $index -ge 1; $index -= 1) {
            $openPresentation = $runningPowerPoint.Presentations.Item($index)
            if ([string] $openPresentation.FullName -eq $presentationPath) {
                $openPresentation.Close()
            }
        }
        [void] [Runtime.InteropServices.Marshal]::ReleaseComObject($runningPowerPoint)
        Start-Sleep -Milliseconds 300
    } catch {}
    Remove-Item -LiteralPath $presentationPath -Force
}
Get-ChildItem -LiteralPath $outputPath -Filter 'phase-*.png' -File |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }

$hostScript = Join-Path $PSScriptRoot 'powerpoint-host.ps1'
$startInfo = [Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = 'powershell.exe'
$startInfo.Arguments = "-NoLogo -NoProfile -Sta -ExecutionPolicy Bypass -File `"$hostScript`""
$startInfo.WorkingDirectory = $projectRoot
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$hostProcess = [Diagnostics.Process]::new()
$hostProcess.StartInfo = $startInfo
[void] $hostProcess.Start()

$phase = 0
$records = [Collections.Generic.List[object]]::new()

function Invoke-LiveStep([string] $Command, [hashtable] $Arguments) {
    $script:phase += 1
    $request = @{
        id = $script:phase
        command = $Command
        args = $Arguments
    } | ConvertTo-Json -Depth 10 -Compress
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    $requestBytes = [Text.UTF8Encoding]::new($false).GetBytes("$request`n")
    $hostProcess.StandardInput.BaseStream.Write($requestBytes, 0, $requestBytes.Length)
    $hostProcess.StandardInput.BaseStream.Flush()

    $line = $hostProcess.StandardOutput.ReadLine()
    if ([string]::IsNullOrWhiteSpace($line)) {
        throw "No response for $Command`: $($hostProcess.StandardError.ReadToEnd())"
    }
    $response = $line | ConvertFrom-Json
    if (-not $response.ok) { throw "$Command failed: $($response.error)" }
    $stopwatch.Stop()

    $descriptorPath = Join-Path $env:USERPROFILE '.linco\powerpoint-live.json'
    $status = Get-Content -LiteralPath $descriptorPath -Raw | ConvertFrom-Json
    $framePath = Join-Path $outputPath ('phase-{0:d2}-{1}.png' -f $script:phase, $Command)
    Copy-Item -LiteralPath $status.preview_path -Destination $framePath -Force
    $script:records.Add([pscustomobject]@{
        phase = $script:phase
        command = $Command
        shape_count = [int] $status.shape_count
        slide_width = [double] $status.slide_width
        slide_height = [double] $status.slide_height
        preview_width = [int] $status.preview_pixel_width
        preview_height = [int] $status.preview_pixel_height
        operation_count = [int] $status.operation_count
        updated_at = [long] $status.updated_at
        elapsed_ms = [long] $stopwatch.ElapsedMilliseconds
        frame_path = $framePath
    })
    return $response.result
}

try {
    [void] (Invoke-LiveStep 'launch' @{ file_path = $presentationPath })
    $batch = Invoke-LiveStep 'draw_sequence' @{
        step_delay_ms = 0
        publish_every_operations = 3
        publish_interval_ms = 400
        live_preview_width = 1400
        operations = @(
            @{
                type = 'add_text'; name = 'Title'; x = 28; y = 20; width = 460; height = 22
                text_runs = @(
                    @{ text = 'Live '; font_color = '#202124'; bold = $true },
                    @{ text = 'scientific'; font_color = '#1A73E8'; bold = $true },
                    @{ text = ' figure'; font_color = '#202124'; bold = $true }
                )
                font_size = 12; align = 'left'; fill_color = 'none'; stroke_color = 'none'
            },
            @{
                type = 'add_shape'; name = 'Input'; shape = 'rounded'; x = 35; y = 120; width = 105; height = 54
                text = 'Input'; font_size = 8; bold = $true
                fill_color = '#E8F0FE'; stroke_color = '#1A73E8'; stroke_width = 0.75
            },
            @{
                type = 'add_shape'; name = 'Model'; shape = 'rounded'; x = 205; y = 120; width = 105; height = 54
                text = 'Model'; font_size = 8; bold = $true
                fill_color = '#E6F4EA'; stroke_color = '#188038'; stroke_width = 0.75
            },
            @{
                type = 'connect_shapes'; name = 'InputToModel'; source_name = 'Input'; target_name = 'Model'
                stroke_color = '#5F6368'; stroke_width = 0.75; end_arrow = 'triangle'
            },
            @{
                type = 'add_shape'; name = 'Output'; shape = 'rounded'; x = 375; y = 120; width = 105; height = 54
                text = 'Output'; font_size = 8; bold = $true
                fill_color = '#FCE8E6'; stroke_color = '#D93025'; stroke_width = 0.75
            },
            @{
                type = 'connect_shapes'; name = 'ModelToOutput'; source_name = 'Model'; target_name = 'Output'
                stroke_color = '#5F6368'; stroke_width = 0.75; end_arrow = 'triangle'
            },
            @{
                type = 'add_text'; name = 'Caption'; x = 55; y = 220; width = 405; height = 18
                text = 'A host-side batch keeps native objects editable.'
                font_size = 7; align = 'center'; font_color = '#5F6368'
                fill_color = 'none'; stroke_color = 'none'
            },
            @{
                type = 'update'; name = 'Title'; font_size = 11
            }
        )
    }
    if (-not $batch.completed -or $batch.applied_count -ne 8) {
        throw "Batch did not finish: $($batch | ConvertTo-Json -Compress)"
    }
    [void] (Invoke-LiveStep 'save' @{})
} finally {
    $hostProcess.StandardInput.Close()
    [void] $hostProcess.WaitForExit(5000)
    if (-not $hostProcess.HasExited) { $hostProcess.Kill() }
}

$timelinePath = Join-Path $outputPath 'timeline.json'
[IO.File]::WriteAllText(
    $timelinePath,
    ($records | ConvertTo-Json -Depth 4),
    [Text.UTF8Encoding]::new($false)
)
$progressFrames = Get-ChildItem -LiteralPath $outputPath -Filter 'phase-*.png' -File |
    Sort-Object Name
if ($progressFrames.Count -ne 3) { throw "Expected 3 command preview frames, got $($progressFrames.Count)." }
$distinctProgressHashes = $progressFrames[0..1] | Get-FileHash -Algorithm SHA256 |
    Select-Object -ExpandProperty Hash -Unique
if ($distinctProgressHashes.Count -ne 2) {
    throw "Expected launch and batch frames to differ, got $($distinctProgressHashes.Count) unique frames."
}
$finalHash = (Get-FileHash -LiteralPath $progressFrames[1].FullName -Algorithm SHA256).Hash
$savedHash = (Get-FileHash -LiteralPath $progressFrames[2].FullName -Algorithm SHA256).Hash
if ($finalHash -ne $savedHash) { throw 'Saving changed the rendered final slide.' }
if ($records[0].shape_count -ne 0) {
    throw "A new academic canvas must start blank; got $($records[0].shape_count) objects."
}
if ($records[1].shape_count -ne 7) {
    throw "Expected 7 native objects after drawing; got $($records[1].shape_count)."
}
if ($records[1].preview_width -ne 1400) {
    throw "Expected a 1400px live preview, got $($records[1].preview_width)."
}
if ($records[1].elapsed_ms -gt 30000) {
    throw "Host-side batch took too long: $($records[1].elapsed_ms) ms."
}
$records | Format-Table phase, command, shape_count, preview_width, elapsed_ms
Write-Output "PPTX=$presentationPath"
Write-Output "TIMELINE=$timelinePath"
Write-Output "FRAMES=$($records.Count)"
