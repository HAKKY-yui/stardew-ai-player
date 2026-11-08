# keyer.ps1 -- a PERSISTENT key poster. Reads one command per line on stdin.
#
# Why: inject.ps1 is a fresh powershell per key (~0.8 s of process startup), which
# makes "walk 20 tiles and sample after each" take 20+ seconds of pure overhead.
# This process starts once and posts messages until stdin closes.
#
# Protocol (one command per line, space separated):
#   <hwnd-hex> <key> <holdMs>
# Reply (one line per command):
#   ok <key>
#   err <reason>
#
# Keys: w a s d e c x f 4 enter esc space tab up down left right
#
# Usage from node:
#   const p = spawn('powershell', ['-NoProfile','-ExecutionPolicy','Bypass','-File','keyer.ps1']);

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Keyer {
    [DllImport("user32.dll", SetLastError = true)] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
    public const uint WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_CHAR = 0x0102;

    public static uint Vk(string n) {
        switch (n.ToLowerInvariant()) {
            case "up": return 0x26; case "down": return 0x28;
            case "left": return 0x25; case "right": return 0x27;
            case "enter": return 0x0D; case "esc": return 0x1B;
            case "space": return 0x20; case "tab": return 0x09;
            case "e": return 0x45; case "w": return 0x57; case "a": return 0x41;
            case "s": return 0x53; case "d": return 0x44;
            case "c": return 0x43; case "x": return 0x58; case "f": return 0x46;
            case "0": return 0x30; case "1": return 0x31; case "2": return 0x32;
            case "3": return 0x33; case "4": return 0x34; case "5": return 0x35;
            case "6": return 0x36; case "7": return 0x37; case "8": return 0x38;
            case "9": return 0x39; case ".": return 0xBE; case "-": return 0xBD;
            default: return 0;
        }
    }

    public static void Tap(IntPtr h, uint vk, int holdMs) {
        uint scan = MapVirtualKey(vk, 0);
        long ext = (vk >= 0x25 && vk <= 0x28) ? 0x01000000L : 0L;   // arrow keys are extended
        IntPtr down = (IntPtr)(1L | ((long)scan << 16) | ext);
        IntPtr up   = (IntPtr)(1L | ((long)scan << 16) | ext | 0xC0000000L);
        PostMessage(h, WM_KEYDOWN, (IntPtr)(long)vk, down);
        System.Threading.Thread.Sleep(Math.Max(30, holdMs / 2));
        PostMessage(h, WM_CHAR, (IntPtr)(long)vk, down);
        System.Threading.Thread.Sleep(Math.Max(20, holdMs / 2));
        PostMessage(h, WM_KEYUP, (IntPtr)(long)vk, up);
    }

    // Held keys: the game keeps walking while the key is down, so a long run is
    // "press once, poll the position, release" instead of one tap per tile.
    public static void Down(IntPtr h, uint vk) {
        uint scan = MapVirtualKey(vk, 0);
        long ext = (vk >= 0x25 && vk <= 0x28) ? 0x01000000L : 0L;
        IntPtr l = (IntPtr)(1L | ((long)scan << 16) | ext);
        PostMessage(h, WM_KEYDOWN, (IntPtr)(long)vk, l);
        PostMessage(h, WM_CHAR, (IntPtr)(long)vk, l);
    }

    public static void Up(IntPtr h, uint vk) {
        uint scan = MapVirtualKey(vk, 0);
        long ext = (vk >= 0x25 && vk <= 0x28) ? 0x01000000L : 0L;
        IntPtr l = (IntPtr)(1L | ((long)scan << 16) | ext | 0xC0000000L);
        PostMessage(h, WM_KEYUP, (IntPtr)(long)vk, l);
    }
}
'@

$stdout = [Console]::Out
# [Console]::Out has no AutoFlush property; flush explicitly or the parent
# process blocks waiting for a line that is still sitting in the buffer.
function Say([string]$text) { $stdout.WriteLine($text); $stdout.Flush() }

while ($null -ne ($line = [Console]::In.ReadLine())) {
    $line = $line.Trim()
    if ($line -eq '') { continue }
    if ($line -eq 'quit') { break }
    $parts = $line -split '\s+'
    if ($parts.Count -lt 3) { Say 'err bad_command'; continue }
    try {
        $h = [IntPtr]([Convert]::ToInt64($parts[0], 16))
        $key = $parts[1]
        $vk = [Keyer]::Vk($key)
        if ($vk -eq 0) { Say "err unknown_key $key"; continue }
        if ($parts[2] -eq 'down') { [Keyer]::Down($h, $vk); Say "ok $key down"; continue }
        if ($parts[2] -eq 'up') { [Keyer]::Up($h, $vk); Say "ok $key up"; continue }
        $hold = [int]$parts[2]
        [Keyer]::Tap($h, $vk, $hold)
        Say "ok $key"
    }
    catch {
        Say ("err " + $_.Exception.Message.Replace(' ', '_'))
    }
}
exit 0
