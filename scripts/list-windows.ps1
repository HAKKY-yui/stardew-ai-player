# list-windows.ps1 -- list visible top-level windows whose title matches a substring
param([string]$Match = 'Stardew')
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class WinList {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int L, T, R, B; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  public static List<string> List(string match) {
    var res = new List<string>();
    EnumWindows((h, l) => {
      var sb = new StringBuilder(256);
      GetWindowText(h, sb, 256);
      var t = sb.ToString();
      if (t.Length > 0 && t.IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0 && IsWindowVisible(h)) {
        uint pid; GetWindowThreadProcessId(h, out pid);
        RECT r; GetWindowRect(h, out r);
        res.Add(h.ToString("x8") + " | " + pid.ToString() + " | " + t + " | " + r.L + "," + r.T + "," + r.R + "," + r.B);
      }
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
'@
[WinList]::List($Match)
