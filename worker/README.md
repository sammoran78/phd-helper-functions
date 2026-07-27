# PhD Helper Podcast Worker

This worker runs on the dashboard owner's laptop. It claims podcast jobs from
the Azure Function App, downloads the reference PDF, uses the local NotebookLM
MCP server to create a two-host Deep Dive Audio Overview, and uploads the audio
through the Function App's existing Blob Storage mechanism.

The laptop only needs to be online while a podcast is being generated. Once the
audio is uploaded, playback and download are served from Azure.

## One-time setup

1. Create a local Python environment and install the NotebookLM MCP package:

   ```powershell
   python -m venv .venv
   .\.venv\Scripts\python.exe -m pip install notebooklm-mcp-cli
   .\.venv\Scripts\nlm.exe login
   .\.venv\Scripts\nlm.exe login --check
   ```

   The worker detects `.venv\Scripts\notebooklm-mcp.exe` automatically.

2. In this directory, install the worker dependency:

   ```powershell
   npm install
   ```

3. Set `PODCAST_WORKER_TOKEN` to the same high-entropy value configured in the
   Azure Function App. It may be stored as a Windows user environment variable
   or in a local `.env` copied from `.env.example`.
4. Start the worker:

   ```powershell
   .\Start-PodcastWorker.ps1 -CheckNotebookLM
   .\Start-PodcastWorker.ps1
   ```

The worker reads `.env` without a third-party package, so it can also be
configured entirely through Windows environment variables.

## Run automatically when signed in

Create a Windows Task Scheduler task that runs `powershell.exe` with:

```text
-ExecutionPolicy Bypass -File "<this-directory>\Start-PodcastWorker.ps1"
```

The worker performs no cloud compute itself and simply waits when there are no
queued jobs.

## Configuration

- `PHD_HELPER_API_BASE`: Function App origin, without a trailing `/api`.
- `PODCAST_WORKER_TOKEN`: shared worker credential.
- `NOTEBOOKLM_MCP_COMMAND`: optional MCP executable override.
- `NOTEBOOKLM_MCP_ARGS`: JSON array of optional MCP command arguments.
- `PODCAST_WORKER_POLL_MS`: delay between claim attempts.
- `PODCAST_GENERATION_TIMEOUT_MS`: maximum wait for NotebookLM audio.
- `PODCAST_WORKER_ONCE`: process at most one job and exit.
- `PODCAST_KEEP_NOTEBOOKS`: retain temporary notebooks after successful upload.

If NotebookLM authentication expires, run `.\.venv\Scripts\nlm.exe login`
again. The dashboard will show the worker error and allow the job to be retried.
