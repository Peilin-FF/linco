$ErrorActionPreference = 'Continue'

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error "请右键 PowerShell 选择“以管理员身份运行”，然后再执行此脚本。"
  exit 1
}

$timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$backupRoot = Join-Path $env:USERPROFILE "Desktop\360-enterprise-removal-backup-$timestamp"
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null

$serviceNames = @(
  '360ANTIARPPROT',
  '360AntiAttack',
  '360AntiHacker',
  '360AntiHijack',
  '360AntiSteal',
  '360AvFlt',
  '360Box64',
  '360CactusNet',
  '360Camera',
  '360dc64',
  '360EDRSensor',
  '360elam64',
  '360FsFlt',
  '360LanProtect',
  '360qbus',
  '360qpesv',
  '360SelfProtection',
  'dsmainsrv',
  'eppservice',
  'ZhuDongFangYu'
)

$pathsToRemove = @(
  'C:\Program Files (x86)\360\360Safe',
  'C:\Program Files (x86)\360\360EDRSensor',
  'C:\ProgramData\360safe',
  'C:\ProgramData\360\360epp',
  "$env:APPDATA\360safe"
)

$driverFiles = @(
  "$env:SystemRoot\System32\drivers\360AntiAttack64.sys",
  "$env:SystemRoot\System32\drivers\360AntiHacker64.sys",
  "$env:SystemRoot\System32\drivers\360AntiSteal64.sys",
  "$env:SystemRoot\System32\drivers\360AvFlt.sys",
  "$env:SystemRoot\System32\drivers\360Box64.sys",
  "$env:SystemRoot\System32\drivers\360CactusNet64.sys",
  "$env:SystemRoot\System32\drivers\360Camera64.sys",
  "$env:SystemRoot\System32\drivers\360dc64.sys",
  "$env:SystemRoot\System32\drivers\360elam64.sys",
  "$env:SystemRoot\System32\drivers\360FsFlt.sys",
  "$env:SystemRoot\System32\drivers\360LanProtect.sys",
  "$env:SystemRoot\System32\drivers\360qpesv64.sys"
)

Write-Host "备份服务注册表到: $backupRoot"
foreach ($name in $serviceNames) {
  $svcKey = "HKLM\SYSTEM\CurrentControlSet\Services\$name"
  reg.exe query $svcKey *> $null
  if ($LASTEXITCODE -eq 0) {
    reg.exe export $svcKey (Join-Path $backupRoot "$name.reg") /y | Out-Host
  }
}

Write-Host "停止并删除 360 企业安全端服务/驱动注册项..."
foreach ($name in $serviceNames) {
  sc.exe stop $name | Out-Null
  sc.exe config $name start= disabled | Out-Null
  sc.exe delete $name | Out-Host
}

Write-Host "删除卸载注册表项..."
$uninstallRoots = @(
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
)
foreach ($root in $uninstallRoots) {
  Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
    $item = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    if ($item.DisplayName -eq '360终端安全管理系统') {
      reg.exe export ($_.Name) (Join-Path $backupRoot "uninstall-$($_.PSChildName).reg") /y | Out-Host
      Remove-Item -LiteralPath $_.PSPath -Recurse -Force -ErrorAction Continue
    }
  }
}

Write-Host "删除 360 企业安全端目录；保留 360zip。"
foreach ($path in $pathsToRemove) {
  if (Test-Path -LiteralPath $path) {
    Takeown.exe /F $path /R /D Y | Out-Null
    Icacls.exe $path /grant Administrators:F /T /C | Out-Null
    Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Continue
  }
}

Write-Host "删除 360 企业安全端驱动文件；不删除 xusb22 Xbox 360 驱动。"
foreach ($file in $driverFiles) {
  if (Test-Path -LiteralPath $file) {
    Takeown.exe /F $file /A | Out-Null
    Icacls.exe $file /grant Administrators:F /C | Out-Null
    Remove-Item -LiteralPath $file -Force -ErrorAction Continue
  }
}

Write-Host "清除安全模式启动标记..."
bcdedit /deletevalue '{current}' safeboot | Out-Host

Write-Host ""
Write-Host "完成。请重启回正常模式。备份位置: $backupRoot"
Write-Host "重启后可运行: Get-Service | ? { `$_.Name -match '360|QH|Qihoo|EPP|ZhuDong' -or `$_.DisplayName -match '360|奇虎|终端安全' }"
