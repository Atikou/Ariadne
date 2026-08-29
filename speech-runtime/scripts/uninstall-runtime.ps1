[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$RootPath = 'E:\AI\AriadneSpeech',
  [switch]$RemoveModelsAndVoices
)

$ErrorActionPreference = 'Stop'
$resolvedRoot = [System.IO.Path]::GetFullPath($RootPath)
if (-not [System.IO.Path]::IsPathRooted($resolvedRoot)) { throw 'RootPath must be absolute.' }
if ($resolvedRoot -eq [System.IO.Path]::GetPathRoot($resolvedRoot)) { throw 'Refusing to remove a drive root.' }
$runtimeTarget = [System.IO.Path]::GetFullPath((Join-Path $resolvedRoot 'runtime'))
if (-not $runtimeTarget.StartsWith($resolvedRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Resolved runtime target escaped RootPath.'
}
if ($PSCmdlet.ShouldProcess($runtimeTarget, 'Remove optional Ariadne speech runtime')) {
  Remove-Item -LiteralPath $runtimeTarget -Recurse -Force -ErrorAction SilentlyContinue
}
if ($RemoveModelsAndVoices -and $PSCmdlet.ShouldProcess($resolvedRoot, 'Remove all speech models, voices, datasets and WSL data')) {
  Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
}
