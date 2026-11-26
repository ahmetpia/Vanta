$ErrorActionPreference = 'Stop'

$nativeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $nativeDir
$binDir = Join-Path $rootDir 'bin'
$outExe = Join-Path $binDir 'vanta-audio-engine.exe'
$objFile = Join-Path $nativeDir 'vanta_audio_engine.obj'

if (-not (Test-Path $binDir)) {
  New-Item -ItemType Directory -Path $binDir -Force | Out-Null
}

$clArgs = '/nologo /std:c++17 /EHsc /O2 /W4 /WX /DUNICODE /D_UNICODE vanta_audio_engine.cpp ole32.lib avrt.lib advapi32.lib /Fe:..\bin\vanta-audio-engine.exe'

$clCmd = Get-Command cl.exe -ErrorAction SilentlyContinue
if ($clCmd) {
  Push-Location $nativeDir
  try {
    & cl.exe /nologo /std:c++17 /EHsc /O2 /W4 /WX /DUNICODE /D_UNICODE vanta_audio_engine.cpp ole32.lib avrt.lib advapi32.lib /Fe:..\bin\vanta-audio-engine.exe
    if ($LASTEXITCODE -ne 0) {
      throw "cl.exe exited with code $LASTEXITCODE"
    }
  } finally {
    if (Test-Path $objFile) { Remove-Item $objFile -Force -ErrorAction SilentlyContinue }
    Pop-Location
  }
} else {
  $candidates = @()
  $vsWhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (Test-Path $vsWhere) {
    $vsRoots = & $vsWhere -all -products * -property installationPath
    foreach ($r in $vsRoots) {
      if ($r) { $candidates += (Join-Path $r.Trim() 'VC\Auxiliary\Build\vcvars64.bat') }
    }
  }
  foreach ($year in @('2022', '2019')) {
    foreach ($ed in @('Enterprise', 'Professional', 'Community', 'BuildTools')) {
      $candidates += "C:\Program Files\Microsoft Visual Studio\$year\$ed\VC\Auxiliary\Build\vcvars64.bat"
      $candidates += "C:\Program Files (x86)\Microsoft Visual Studio\$year\$ed\VC\Auxiliary\Build\vcvars64.bat"
    }
  }

  $vcvars = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if (-not $vcvars) {
    throw 'MSVC cl.exe not on PATH and no vcvars64.bat installation was found.'
  }

  $cmdLine = "call `"$vcvars`" >nul && cd /d `"$nativeDir`" && cl.exe $clArgs"
  & cmd.exe /d /c $cmdLine
  $exitCode = $LASTEXITCODE
  if (Test-Path $objFile) { Remove-Item $objFile -Force -ErrorAction SilentlyContinue }
  if ($exitCode -ne 0) {
    throw "MSVC build failed with exit code $exitCode"
  }
}

if (-not (Test-Path $outExe)) {
  throw "Expected output binary missing: $outExe"
}

Write-Host "Built $outExe cleanly (/W4 /WX, 0 warnings)."
