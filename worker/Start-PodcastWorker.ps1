param(
    [switch]$Once,
    [switch]$CheckNotebookLM
)

$ErrorActionPreference = 'Stop'
$workerDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$systemNode = Get-Command node -ErrorAction SilentlyContinue
$bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'

if ($systemNode) {
    $nodeExecutable = $systemNode.Source
} elseif (Test-Path -LiteralPath $bundledNode) {
    $nodeExecutable = $bundledNode
} else {
    throw 'Node.js was not found. Install Node.js 22 or run this worker from a Codex-enabled machine.'
}

if ($CheckNotebookLM) {
    & $nodeExecutable (Join-Path $workerDirectory 'check-notebooklm.js')
    exit $LASTEXITCODE
}

if ($Once) {
    $env:PODCAST_WORKER_ONCE = 'true'
}

& $nodeExecutable (Join-Path $workerDirectory 'podcast-worker.js')
exit $LASTEXITCODE
