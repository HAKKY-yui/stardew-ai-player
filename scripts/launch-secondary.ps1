# launch-secondary.ps1 -- start a Stardew Valley instance detached from this shell.
#
# Two shapes:
#   -ModsPath ''            -> the DEFAULT Mods dir (loads JunimoBridge, opens the
#                              API port). This is the instance whose state can be
#                              read back, so it is the one input experiments use.
#   -ModsPath 'Mods-secondary' -> an empty mods dir, no API port. Needed only for
#                              two-instance / co-op work (two processes cannot
#                              both bind the compiled-in port 7850).
#
# Detached via Win32_Process.Create: a plain Start-Process child dies with the
# calling shell, and this has to outlive every bash/pwsh invocation that touches it.
#
# Prints one JSON line: pid + the command line actually used.

param(
    [string]$GameDir = $env:STARDEW_GAME,
    [string]$ModsPath = 'Mods-secondary'
)

$ErrorActionPreference = 'Stop'

# $GameDir must point at the folder containing StardewModdingAPI.exe.
# Set it via the STARDEW_GAME environment variable (recommended) or pass -GameDir.
if (-not $GameDir) { throw 'GameDir is empty: set $env:STARDEW_GAME or pass -GameDir "<path to Stardew Valley>"' }

$exe = Join-Path $GameDir 'StardewModdingAPI.exe'
if (-not (Test-Path -LiteralPath $exe)) {
    Write-Output ('{"ok":false,"error":"exe_not_found","path":"' + $exe + '"}')
    exit 1
}

if ([string]::IsNullOrWhiteSpace($ModsPath)) {
    $cmd = '"' + $exe + '"'
    $modsDir = (Join-Path $GameDir 'Mods')
}
else {
    $modsDir = Join-Path $GameDir $ModsPath
    if (-not (Test-Path -LiteralPath $modsDir)) {
        New-Item -ItemType Directory -Path $modsDir -Force | Out-Null
    }
    $cmd = '"' + $exe + '" --mods-path "' + $ModsPath + '"'
}

# No ProcessStartupInformation: a [wmiclass] instance cannot be marshalled into
# Invoke-CimMethod ("Could not infer CimType"), and the default startup is
# exactly what we want (normal window, no inherited console).
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine      = $cmd
    CurrentDirectory = $GameDir
}

$out = [ordered]@{
    ok          = ($result.ReturnValue -eq 0)
    returnValue = $result.ReturnValue
    pid         = [int]$result.ProcessId
    commandLine = $cmd
    modsPath    = $modsDir
}
Write-Output ($out | ConvertTo-Json -Compress)
exit 0
