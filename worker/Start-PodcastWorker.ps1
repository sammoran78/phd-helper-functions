param(
    [switch]$Once,
    [switch]$CheckNotebookLM,
    [switch]$SkipNotebookLMUpdate
)

$ErrorActionPreference = 'Stop'
$workerDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$systemNode = Get-Command node -ErrorAction SilentlyContinue
$bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$venvPython = Join-Path $workerDirectory '.venv\Scripts\python.exe'

function Get-NotebookLMVersion {
    $version = & $venvPython -c "from importlib.metadata import version; print(version('notebooklm-mcp-cli'))" 2>$null
    if ($LASTEXITCODE -ne 0) {
        return $null
    }
    return ($version | Select-Object -First 1).Trim()
}

if (-not $SkipNotebookLMUpdate) {
    if (Test-Path -LiteralPath $venvPython) {
        Write-Host 'Checking for NotebookLM CLI updates...'
        $previousNotebookLMVersion = Get-NotebookLMVersion
        & $venvPython -m pip --disable-pip-version-check install `
            --quiet `
            --upgrade `
            --timeout 15 `
            --retries 1 `
            notebooklm-mcp-cli

        if ($LASTEXITCODE -ne 0) {
            Write-Warning 'NotebookLM CLI could not be updated. Continuing with the installed version.'
        } else {
            $currentNotebookLMVersion = Get-NotebookLMVersion
            if ($previousNotebookLMVersion -and $currentNotebookLMVersion -and $previousNotebookLMVersion -ne $currentNotebookLMVersion) {
                Write-Host "NotebookLM CLI updated: $previousNotebookLMVersion -> $currentNotebookLMVersion"
            } elseif ($currentNotebookLMVersion) {
                Write-Host "NotebookLM CLI is up to date ($currentNotebookLMVersion)."
            }
        }
    } else {
        Write-Warning "NotebookLM virtual environment was not found at $venvPython. Skipping the automatic update."
    }
}

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
