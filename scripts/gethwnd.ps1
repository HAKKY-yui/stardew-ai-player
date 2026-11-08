# gethwnd.ps1 -- print the hex handle of the MODDED Stardew window.
#
# Why: typing the handle by hand is how "the game won't take input" happens
# (2f04c0 vs 2f0480 looks identical and silently posts into the void).
#
# Which window: the modded instance is the one whose title contains
# "Stardew Valley" and does NOT say "[farmhand]". Inside a hosted world the
# title also carries "[main player]", which we prefer over a bare title-screen
# window (at the title screen the suffix is not there yet, and host.ps1 still
# needs the handle to click 合作 / 主持).
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
    if ($title -notmatch 'Stardew Valley') { return $true }
    if ($title -match '\[farmhand\]') { return $true }        # 0-mod joiner: never drive this one
    $rank = if ($title -match '\[main player\]') { 2 } else { 1 }
    [void]$script:found.Add([pscustomobject]@{ h = $h.ToInt64(); r = $rank })
    return $true
}
[void][WinFind]::EnumWindows($cb, [IntPtr]::Zero)

if ($found.Count -eq 0) { Write-Error 'no modded Stardew window found'; exit 1 }
$best = $found | Sort-Object r -Descending | Select-Object -First 1
'{0:x}' -f $best.h
