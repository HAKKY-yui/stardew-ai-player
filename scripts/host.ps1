# host.ps1 -- place the modded window, move the SMAPI console out of the way,
# then click 合作 -> 主持 -> save row to host the existing save.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$winX = 40; $winY = 60; $winW = 1302; $winH = 776   # adjust to your monitor layout

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class HostWin {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
'@

[void][HostWin]::SetProcessDPIAware()

$hex = (powershell -NoProfile -ExecutionPolicy Bypass -File "$here\gethwnd.ps1").Trim()
$h = [IntPtr]([Convert]::ToInt64($hex, 16))
Write-Output "game hwnd=$hex"
[void][HostWin]::SetWindowPos($h, [IntPtr]::Zero, $winX, $winY, $winW, $winH, 0x0014)

# SMAPI console is a separate top-level window and sits on top of the game,
# swallowing any real click aimed at the title screen.
$cb = [HostWin+EnumProc]{
    param($w, $l)
    if (-not [HostWin]::IsWindowVisible($w)) { return $true }
    $cn = New-Object System.Text.StringBuilder 128
    [void][HostWin]::GetClassName($w, $cn, 128)
    if ($cn.ToString() -ne 'ConsoleWindowClass') { return $true }
    $t = New-Object System.Text.StringBuilder 256
    [void][HostWin]::GetWindowText($w, $t, 256)
    if ($t.ToString() -match 'SMAPI') {
        [void][HostWin]::SetWindowPos($w, [IntPtr]::Zero, 1500, 1000, 900, 400, 0x0014)
    }
    return $true
}
[void][HostWin]::EnumWindows($cb, [IntPtr]::Zero)

Start-Sleep -Milliseconds 600
& powershell -NoProfile -ExecutionPolicy Bypass -File "$here\win.ps1" click 782 710 | Out-Null
Start-Sleep -Seconds 3
& powershell -NoProfile -ExecutionPolicy Bypass -File "$here\win.ps1" click 270 162 | Out-Null
Start-Sleep -Seconds 3
& powershell -NoProfile -ExecutionPolicy Bypass -File "$here\win.ps1" click 640 435 | Out-Null
Write-Output 'host clicks sent'
