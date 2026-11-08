param([Parameter(Mandatory=$true)][string]$Hwnd)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AF {
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public U u; }
  [StructLayout(LayoutKind.Explicit)] public struct U { [FieldOffset(0)] public K ki; }
  [StructLayout(LayoutKind.Sequential)] public struct K { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] i, int cb);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public static void Combo(ushort mod, ushort key) {
    var a = new INPUT[4];
    a[0].type = 1; a[0].u.ki.wVk = mod; a[0].u.ki.dwFlags = 0;
    a[1].type = 1; a[1].u.ki.wVk = key; a[1].u.ki.dwFlags = 0;
    a[2].type = 1; a[2].u.ki.wVk = key; a[2].u.ki.dwFlags = 2;
    a[3].type = 1; a[3].u.ki.wVk = mod; a[3].u.ki.dwFlags = 2;
    SendInput(4, a, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@
$h=[IntPtr]([Convert]::ToInt64($Hwnd,16))
[void][AF]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 400
[AF]::Combo(0x12, 0x73)   # ALT + F4
"sent alt+f4"
