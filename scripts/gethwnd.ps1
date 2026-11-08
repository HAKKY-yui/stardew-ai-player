# gethwnd.ps1 -- print the hex handle of the MODDED Stardew window.
#
# Why: typing the handle by hand is how "the game won't take input" happens
# (2f04c0 vs 2f0480 looks identical and silently posts into the void).
# The modded instance is the one whose title ends with "[main player]".
#
# Prints one line: e.g. 2f0480   (or nothing + exit 1)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class WinFind {
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
'@

$found = New-Object System.Collections.ArrayList
$cb = [WinFind+EnumProc]{
    param($h, $l)
    if (-not [WinFind]::IsWindowVisible($h)) { return $true }
    $cn = New-Object System.Text.StringBuilder 128
    [void][WinFind]::GetClassName($h, $cn, 128)
    if ($cn.ToString() -ne 'SDL_app') { return $true }
    $t = New-Object System.Text.StringBuilder 256
    [void][WinFind]::GetWindowText($h, $t, 256)
    $title = $t.ToString()
    if ($title -match '\[main player\]') { [void]$script:found.Add($h.ToInt64()) }
    return $true
}
[void][WinFind]::EnumWindows($cb, [IntPtr]::Zero)

if ($found.Count -eq 0) { Write-Error 'no modded Stardew window found'; exit 1 }
'{0:x}' -f $found[0]
