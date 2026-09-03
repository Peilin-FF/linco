if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error "请右键 PowerShell 选择“以管理员身份运行”，然后再执行此脚本。"
  exit 1
}

bcdedit /deletevalue '{current}' safeboot
Write-Host "已清除安全模式启动标记。请重启。"
