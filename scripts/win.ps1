# win.ps1 - pure PowerShell window/screenshot/input helper for a 1280x720
# windowed game (Stardew Valley). No AutoHotkey, Python, or npm dependencies.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File win.ps1 shot <out.png> [window-title] [--full]
#   powershell -NoProfile -ExecutionPolicy Bypass -File win.ps1 click <x> <y>
#   powershell -NoProfile -ExecutionPolicy Bypass -File win.ps1 key <text> [--window <window-title>]
#   powershell -NoProfile -ExecutionPolicy Bypass -File win.ps1 focus <window-title>
#
# shot modes:
#   no title       -> primary screen
#   title          -> exact window rectangle
#   --full         -> whole virtual desktop (all monitors)
#
# key defaults to the "Stardew Valley" window and accepts SendKeys escapes such
# as {ENTER}, {ESC}, {TAB}. Use --window to target another window title.
#
# DPI NOTE (important):
#   SetProcessDPIAware() is called immediately after the Win32 declarations
#   below, before any geometry, screenshot, mouse, or window call. Without it,
#   Windows DPI virtualization makes GetWindowRect(), CopyFromScreen(),
#   Screen.Bounds and SetCursorPos() use different coordinate spaces on a
#   scaled desktop, so screenshots are cropped and clicks land in the wrong
#   place. This call is the main reason this script exists.

$ErrorActionPreference = 'Stop'

if (-not ('StardewWin32' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class StardewWin32
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetProcessDPIAware();

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const int SW_RESTORE = 9;
}
'@
}

# MUST happen before any screen geometry use. See the DPI note at the top.
[void][StardewWin32]::SetProcessDPIAware()

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

function Show-Usage {
    $text = @"
Usage:
  win.ps1 shot <out.png> [window-title] [--full]
  win.ps1 click <x> <y>
  win.ps1 key <text> [--window <window-title>]
  win.ps1 focus <window-title>

shot: no title = primary screen, title = that window, --full = virtual desktop.
key: defaults to the "Stardew Valley" window; SendKeys escapes are supported.
"@
    [Console]::Error.WriteLine($text)
    exit 2
}

function Exit-WindowNotFound([string]$Title) {
    # The required machine-readable failure marker goes to stdout so callers
    # that only capture stdout still see it. Details go to stderr.
    Write-Output 'WINDOW_NOT_FOUND'
    [Console]::Error.WriteLine("No top-level window found with title: $Title")
    exit 1
}

function Get-WindowHandle([string]$Title) {
    if ([string]::IsNullOrWhiteSpace($Title)) {
        return [IntPtr]::Zero
    }

    # Fast path: exact title lookup (this also matches without regard to case).
    $hWnd = [StardewWin32]::FindWindow($null, $Title)
    if ($hWnd -ne [IntPtr]::Zero) {
        return $hWnd
    }

    # Fallback: enumerate process top-level windows. The first pass requires an
    # exact title match. If none exists, accept a title that begins with the
    # requested text: SMAPI retitles the game to e.g.
    # "Stardew Valley 1.6.15 - running SMAPI ...", so "Stardew Valley" still
    # needs to find it.
    $exact = [IntPtr]::Zero
    $prefix = [IntPtr]::Zero
    foreach ($proc in [System.Diagnostics.Process]::GetProcesses()) {
        try {
            if ($proc.MainWindowHandle -ne [IntPtr]::Zero) {
                $windowTitle = $proc.MainWindowTitle
                if ([string]::Equals($windowTitle, $Title, [System.StringComparison]::OrdinalIgnoreCase)) {
                    $exact = [IntPtr]$proc.MainWindowHandle
                    break
                }
                if ($prefix -eq [IntPtr]::Zero -and
                    $windowTitle.StartsWith($Title, [System.StringComparison]::OrdinalIgnoreCase)) {
                    $prefix = [IntPtr]$proc.MainWindowHandle
                }
            }
        }
        catch {
            # Some processes deny access to their window metadata; skip them.
        }
    }
    if ($exact -ne [IntPtr]::Zero) {
        return $exact
    }
    return $prefix
}

function Get-WindowRectChecked([IntPtr]$hWnd) {
    $rect = New-Object 'StardewWin32+RECT'
    if (-not [StardewWin32]::GetWindowRect($hWnd, [ref]$rect)) {
        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw "GetWindowRect failed for hwnd=$($hWnd.ToInt64()) (Win32 error $err)"
    }
    return $rect
}

function Set-TargetForeground([IntPtr]$hWnd) {
    if ([StardewWin32]::IsIconic($hWnd)) {
        [void][StardewWin32]::ShowWindow($hWnd, 9) # SW_RESTORE
        Start-Sleep -Milliseconds 150
    }

    if ([StardewWin32]::GetForegroundWindow() -eq $hWnd) {
        return $true
    }

    # The foreground lock often refuses a SetForegroundWindow call from a
    # background process. Temporarily attaching to the current foreground and
    # target input queues is the standard way to make it succeed.
    $foreground = [StardewWin32]::GetForegroundWindow()
    $foregroundPid = [uint32]0
    $foregroundThread = [uint32]0
    if ($foreground -ne [IntPtr]::Zero) {
        $foregroundThread = [StardewWin32]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)
    }

    $targetPid = [uint32]0
    $targetThread = [StardewWin32]::GetWindowThreadProcessId($hWnd, [ref]$targetPid)
    $currentThread = [StardewWin32]::GetCurrentThreadId()
    $attachedForeground = $false
    $attachedTarget = $false

    try {
        if ($foregroundThread -ne 0 -and $foregroundThread -ne $currentThread) {
            $attachedForeground = [StardewWin32]::AttachThreadInput($currentThread, $foregroundThread, $true)
        }
        if ($targetThread -ne 0 -and $targetThread -ne $currentThread) {
            $attachedTarget = [StardewWin32]::AttachThreadInput($currentThread, $targetThread, $true)
        }

        [void][StardewWin32]::BringWindowToTop($hWnd)
        [void][StardewWin32]::SetForegroundWindow($hWnd)
    }
    finally {
        if ($attachedForeground) {
            [void][StardewWin32]::AttachThreadInput($currentThread, $foregroundThread, $false)
        }
        if ($attachedTarget) {
            [void][StardewWin32]::AttachThreadInput($currentThread, $targetThread, $false)
        }
    }

    Start-Sleep -Milliseconds 200
    return ([StardewWin32]::GetForegroundWindow() -eq $hWnd)
}

function Resolve-OutputPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw 'shot: output path must not be empty'
    }
    try {
        $full = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
    }
    catch {
        throw "shot: invalid output path '$Path': $($_.Exception.Message)"
    }
    $dir = [System.IO.Path]::GetDirectoryName($full)
    if (-not [System.IO.Directory]::Exists($dir)) {
        throw "shot: output directory does not exist: $dir"
    }
    return $full
}

function Save-ScreenRegion {
    param(
        [int]$Left,
        [int]$Top,
        [int]$Width,
        [int]$Height,
        [string]$OutPath
    )

    if ($Width -le 0 -or $Height -le 0) {
        throw "shot: invalid capture size ${Width}x${Height}"
    }

    $full = Resolve-OutputPath $OutPath
    $bitmap = $null
    $graphics = $null
    try {
        # Physical pixel dimensions, which is why SetProcessDPIAware above is
        # essential on a scaled display.
        $bitmap = New-Object System.Drawing.Bitmap($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $size = New-Object System.Drawing.Size($Width, $Height)
        $graphics.CopyFromScreen($Left, $Top, 0, 0, $size, [System.Drawing.CopyPixelOperation]::SourceCopy)
        $bitmap.Save($full, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        if ($null -ne $graphics) { $graphics.Dispose() }
        if ($null -ne $bitmap) { $bitmap.Dispose() }
    }

    $info = Get-Item -LiteralPath $full
    if ($info.Length -le 0) {
        throw "shot: output file is empty: $full"
    }

    Write-Output ("OK {0}x{1} saved={2}" -f $Width, $Height, $full)
}

function Parse-ScreenCoordinate([string]$Text, [string]$Name) {
    $value = 0
    if (-not [int]::TryParse($Text, [System.Globalization.NumberStyles]::Integer, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$value)) {
        throw "click: invalid $Name coordinate '$Text'"
    }
    return $value
}

try {
    $rawArgs = @($args)
    if ($rawArgs.Count -eq 0) {
        Show-Usage
    }

    $command = ([string]$rawArgs[0]).ToLowerInvariant()

    switch ($command) {
        'shot' {
            if ($rawArgs.Count -lt 2) {
                Show-Usage
            }

            $outPath = [string]$rawArgs[1]
            $titleParts = @()
            $captureVirtual = $false
            for ($i = 2; $i -lt $rawArgs.Count; $i++) {
                $arg = [string]$rawArgs[$i]
                if ($arg -eq '--full') {
                    $captureVirtual = $true
                }
                else {
                    $titleParts += $arg
                }
            }
            $title = $null
            if ($titleParts.Count -gt 0) {
                $title = $titleParts -join ' '
            }

            if ($captureVirtual) {
                $virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
                Save-ScreenRegion -Left $virtual.Left -Top $virtual.Top -Width $virtual.Width -Height $virtual.Height -OutPath $outPath
            }
            elseif (-not [string]::IsNullOrWhiteSpace($title)) {
                $hWnd = Get-WindowHandle $title
                if ($hWnd -eq [IntPtr]::Zero) {
                    Exit-WindowNotFound $title
                }
                if ([StardewWin32]::IsIconic($hWnd)) {
                    throw "shot: window '$title' is minimized; run focus first"
                }
                $rect = Get-WindowRectChecked $hWnd
                $width = $rect.Right - $rect.Left
                $height = $rect.Bottom - $rect.Top
                Save-ScreenRegion -Left $rect.Left -Top $rect.Top -Width $width -Height $height -OutPath $outPath
            }
            else {
                $primary = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
                Save-ScreenRegion -Left $primary.Left -Top $primary.Top -Width $primary.Width -Height $primary.Height -OutPath $outPath
            }
        }

        'place' {
            # Reposition a window without touching z-order or focus. Needed so
            # two game instances can be screenshotted side by side while
            # NEITHER is the foreground window.
            if ($rawArgs.Count -lt 4) {
                Show-Usage
            }
            $hex = ([string]$rawArgs[1]).Trim()
            $hWnd = [IntPtr]([Convert]::ToInt64($hex, 16))
            $px = Parse-ScreenCoordinate ([string]$rawArgs[2]) 'x'
            $py = Parse-ScreenCoordinate ([string]$rawArgs[3]) 'y'
            $physW = 0
            $physH = 0
            if ($rawArgs.Count -ge 6) {
                $physW = Parse-ScreenCoordinate ([string]$rawArgs[4]) 'w'
                $physH = Parse-ScreenCoordinate ([string]$rawArgs[5]) 'h'
            }
            if ($physW -gt 0 -and $physH -gt 0) {
                $ok = [StardewWin32]::SetWindowPos($hWnd, [IntPtr]::Zero, $px, $py, $physW, $physH, 0x0004 -bor 0x0010)
            }
            else {
                $ok = [StardewWin32]::SetWindowPos($hWnd, [IntPtr]::Zero, $px, $py, 0, 0, 0x0004 -bor 0x0001)
            }
            if (-not $ok) { throw "place: SetWindowPos failed" }
            $rect = Get-WindowRectChecked $hWnd
            Write-Output ("OK hwnd={0} rect={1},{2},{3},{4}" -f $hWnd.ToInt64(), $rect.Left, $rect.Top, $rect.Right, $rect.Bottom)
        }

        'move' {
            # Cursor reposition only, no buttons. Used to test whether a window
            # receives mouse MOVE at all (hover state) before blaming clicks.
            if ($rawArgs.Count -lt 3) {
                Show-Usage
            }
            $x = Parse-ScreenCoordinate ([string]$rawArgs[1]) 'x'
            $y = Parse-ScreenCoordinate ([string]$rawArgs[2]) 'y'
            if (-not [StardewWin32]::SetCursorPos($x, $y)) {
                throw "move: SetCursorPos($x, $y) failed"
            }
            Write-Output "OK move x=$x y=$y"
        }

        'click' {
            if ($rawArgs.Count -lt 3) {
                Show-Usage
            }
            $x = Parse-ScreenCoordinate ([string]$rawArgs[1]) 'x'
            $y = Parse-ScreenCoordinate ([string]$rawArgs[2]) 'y'
            # Optional hold time. Stardew polls mouse state once per frame; a
            # 40 ms press was observed to highlight a title button without
            # activating it, so the hold is now tunable.
            $holdMs = 40
            if ($rawArgs.Count -ge 4) {
                $holdMs = Parse-ScreenCoordinate ([string]$rawArgs[3]) 'holdMs'
            }

            if (-not [StardewWin32]::SetCursorPos($x, $y)) {
                $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
                throw "click: SetCursorPos($x, $y) failed (Win32 error $err)"
            }
            Start-Sleep -Milliseconds 60
            [void][StardewWin32]::mouse_event([StardewWin32]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
            Start-Sleep -Milliseconds $holdMs
            [void][StardewWin32]::mouse_event([StardewWin32]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)

            Write-Output "OK click x=$x y=$y holdMs=$holdMs"
        }

        'key' {
            if ($rawArgs.Count -lt 2) {
                Show-Usage
            }

            $textParts = @()
            $windowTitle = 'Stardew Valley'
            $i = 1
            while ($i -lt $rawArgs.Count) {
                $arg = [string]$rawArgs[$i]
                if ($arg -eq '--window') {
                    if ($i + 1 -ge $rawArgs.Count) {
                        throw 'key: --window requires a window title'
                    }
                    $windowTitle = [string]$rawArgs[$i + 1]
                    $i += 2
                }
                else {
                    $textParts += $arg
                    $i++
                }
            }

            if ($textParts.Count -eq 0) {
                throw 'key: text must not be empty'
            }
            $text = $textParts -join ' '

            $hWnd = Get-WindowHandle $windowTitle
            if ($hWnd -eq [IntPtr]::Zero) {
                Exit-WindowNotFound $windowTitle
            }
            if (-not (Set-TargetForeground $hWnd)) {
                throw "key: could not bring window '$windowTitle' to the foreground"
            }

            Start-Sleep -Milliseconds 200
            [System.Windows.Forms.SendKeys]::SendWait($text)
            Write-Output "OK key hwnd=$($hWnd.ToInt64())"
        }

        'focushwnd' {
            # Same as 'focus' but addressed by handle. Needed because a Unity
            # process exposes two top-level windows (SMAPI console + game) and
            # Process.MainWindowHandle resolves to the console, so title lookup
            # in Get-WindowHandle cannot find the game at all.
            if ($rawArgs.Count -lt 2) {
                Show-Usage
            }
            $hex = ([string]$rawArgs[1]).Trim()
            $hWnd = [IntPtr]([Convert]::ToInt64($hex, 16))
            if (-not [StardewWin32]::IsWindow($hWnd)) {
                Write-Output 'WINDOW_NOT_FOUND'
                [Console]::Error.WriteLine("No window with handle 0x$hex")
                exit 1
            }
            if (-not (Set-TargetForeground $hWnd)) {
                throw "focushwnd: could not bring 0x$hex to the foreground"
            }
            $rect = Get-WindowRectChecked $hWnd
            $fg = [StardewWin32]::GetForegroundWindow()
            Write-Output ("OK hwnd={0} foreground={1} rect={2},{3},{4},{5}" -f $hWnd.ToInt64(), ($fg -eq $hWnd), $rect.Left, $rect.Top, $rect.Right, $rect.Bottom)
        }

        'focus' {
            if ($rawArgs.Count -lt 2) {
                Show-Usage
            }
            $title = ($rawArgs[1..($rawArgs.Count - 1)] -join ' ').Trim()
            if ([string]::IsNullOrWhiteSpace($title)) {
                Show-Usage
            }

            $hWnd = Get-WindowHandle $title
            if ($hWnd -eq [IntPtr]::Zero) {
                Exit-WindowNotFound $title
            }
            if (-not (Set-TargetForeground $hWnd)) {
                throw "focus: could not bring window '$title' to the foreground"
            }

            $rect = Get-WindowRectChecked $hWnd
            Write-Output ("OK hwnd={0} rect={1},{2},{3},{4}" -f $hWnd.ToInt64(), $rect.Left, $rect.Top, $rect.Right, $rect.Bottom)
        }

        default {
            Show-Usage
        }
    }
}
catch {
    [Console]::Error.WriteLine("ERROR: $($_.Exception.Message)")
    exit 1
}

exit 0
