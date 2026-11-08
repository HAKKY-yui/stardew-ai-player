# inject.ps1 -- try several distinct keyboard delivery mechanisms against one HWND.
#
# Each method is a genuinely different path into the game:
#   vk      SendInput with virtual-key code          (system input queue, foreground)
#   scan    SendInput with scan code only            (what hardware actually emits)
#   post    PostMessage(WM_KEYDOWN/WM_CHAR/WM_KEYUP) (async, target's own queue)
#   send    SendMessage(WM_KEYDOWN/WM_CHAR/WM_KEYUP) (synchronous, runs wndproc now)
#   syskey  PostMessage(WM_SYSKEYDOWN/WM_SYSKEYUP)   (alt-key path)
#
# Usage:
#   powershell -File inject.ps1 -Hwnd 0043027e -Key e -Method scan
#
# Prints one JSON line. Verify the effect with the mod's /state, not with this.

param(
    [Parameter(Mandatory = $true)][string]$Hwnd,
    [string]$Key = 'e',
    [ValidateSet('vk', 'scan', 'post', 'send', 'syskey')]
    [string]$Method = 'vk',
    [int]$Count = 1,
    [int]$HoldMs = 120,
    [int]$GapMs = 120
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class Inj {
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public U u; }
    [StructLayout(LayoutKind.Explicit)] public struct U { [FieldOffset(0)] public K ki; }
    [StructLayout(LayoutKind.Sequential)] public struct K { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }

    [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] i, int cb);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();

    public const uint INPUT_KEYBOARD = 1;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_SCANCODE = 0x0008;
    public const uint WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_CHAR = 0x0102;
    public const uint WM_SYSKEYDOWN = 0x0104, WM_SYSKEYUP = 0x0105;

    public static uint Vk(string n) {
        switch (n.ToLowerInvariant()) {
            case "up": return 0x26; case "down": return 0x28;
            case "left": return 0x25; case "right": return 0x27;
            case "enter": return 0x0D; case "esc": return 0x1B;
            case "space": return 0x20; case "tab": return 0x09;
            case "e": return 0x45; case "w": return 0x57; case "a": return 0x41;
            case "s": return 0x53; case "d": return 0x44;
            case "x": return 0x58; case "c": return 0x43; case "v": return 0x56;
            case "f": return 0x46; case "p": return 0x50;
            case "0": return 0x30; case "1": return 0x31; case "2": return 0x32;
            case "3": return 0x33; case "4": return 0x34; case "5": return 0x35;
            case "6": return 0x36; case "7": return 0x37; case "8": return 0x38;
            case "9": return 0x39; case ".": return 0xBE; case "-": return 0xBD;
            default: return 0;
        }
    }

    public static int SendVk(ushort vk, bool scancodeOnly) {
        var a = new INPUT[2];
        a[0].type = INPUT_KEYBOARD;
        a[1].type = INPUT_KEYBOARD;
        if (scancodeOnly) {
            ushort sc = (ushort)MapVirtualKey(vk, 0);
            a[0].u.ki.wScan = sc; a[0].u.ki.dwFlags = KEYEVENTF_SCANCODE;
            a[1].u.ki.wScan = sc; a[1].u.ki.dwFlags = KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP;
        } else {
            a[0].u.ki.wVk = vk;
            a[1].u.ki.wVk = vk; a[1].u.ki.dwFlags = KEYEVENTF_KEYUP;
        }
        return (int)SendInput(2, a, Marshal.SizeOf(typeof(INPUT)));
    }
}
'@

$h = [IntPtr]([Convert]::ToInt64($Hwnd, 16))
$vk = [Inj]::Vk($Key)
if ($vk -eq 0) { Write-Output '{"ok":false,"error":"unknown key"}'; exit 2 }
$scan = [Inj]::MapVirtualKey([uint32]$vk, 0)

# Scancode keyboard messages carry the scan code in bits 16-23 of lParam.
# Arrow keys are "extended" keys: bit 24 must be set or SDL reads the scan code
# as the numpad equivalent (KP_2 instead of DOWN), which Stardew does not bind.
$extended = 0
if ($vk -ge 0x25 -and $vk -le 0x28) { $extended = 0x01000000 }
$downLp = [IntPtr]([int64](1 -bor ($scan -shl 16) -bor $extended))
$upLp = [IntPtr]([int64](1 -bor ($scan -shl 16) -bor 0xC0000000 -bor $extended))

$fgBefore = [Inj]::GetForegroundWindow()
$results = @()

for ($i = 0; $i -lt $Count; $i++) {
    switch ($Method) {
        'vk' {
            $results += [Inj]::SendVk([uint16]$vk, $false)
        }
        'scan' {
            $results += [Inj]::SendVk([uint16]$vk, $true)
        }
        'post' {
            [void][Inj]::PostMessage($h, [Inj]::WM_KEYDOWN, [IntPtr]([int64]$vk), $downLp)
            Start-Sleep -Milliseconds ([Math]::Max(10, $HoldMs / 2))
            [void][Inj]::PostMessage($h, [Inj]::WM_CHAR, [IntPtr]([int64]$vk), $downLp)
            [void][Inj]::PostMessage($h, [Inj]::WM_KEYUP, [IntPtr]([int64]$vk), $upLp)
            $results += 1
        }
        'send' {
            [void][Inj]::SendMessage($h, [Inj]::WM_KEYDOWN, [IntPtr]([int64]$vk), $downLp)
            [void][Inj]::SendMessage($h, [Inj]::WM_CHAR, [IntPtr]([int64]$vk), $downLp)
            [void][Inj]::SendMessage($h, [Inj]::WM_KEYUP, [IntPtr]([int64]$vk), $upLp)
            $results += 1
        }
        'syskey' {
            [void][Inj]::PostMessage($h, [Inj]::WM_SYSKEYDOWN, [IntPtr]([int64]$vk), $downLp)
            Start-Sleep -Milliseconds ([Math]::Max(10, $HoldMs / 2))
            [void][Inj]::PostMessage($h, [Inj]::WM_SYSKEYUP, [IntPtr]([int64]$vk), $upLp)
            $results += 1
        }
    }
    if ($i -lt $Count - 1) { Start-Sleep -Milliseconds $GapMs }
}
Start-Sleep -Milliseconds $HoldMs

$out = [ordered]@{
    ok        = $true
    method    = $Method
    key       = $Key
    vk        = $vk
    scan      = $scan
    count     = $Count
    returns   = $results
    fgBefore  = $fgBefore.ToInt64()
    foreground = ([Inj]::GetForegroundWindow() -eq $h)
}
Write-Output ($out | ConvertTo-Json -Compress)
exit 0
