const fs = require('fs');
const path = require('path');

async function main() {
    const [{ Client }, { StdioClientTransport }] = await Promise.all([
        import('@modelcontextprotocol/sdk/client/index.js'),
        import('@modelcontextprotocol/sdk/client/stdio.js')
    ]);
    const localCommand = path.join(__dirname, '.venv', 'Scripts', 'notebooklm-mcp.exe');
    const command = process.env.NOTEBOOKLM_MCP_COMMAND
        || (fs.existsSync(localCommand) ? localCommand : 'notebooklm-mcp');
    const client = new Client(
        { name: 'phd-helper-notebooklm-check', version: '1.0.0' },
        { capabilities: {} }
    );
    const transport = new StdioClientTransport({ command, stderr: 'inherit' });

    try {
        await client.connect(transport);
        const tools = await client.listTools();
        const required = [
            'notebook_create',
            'source_add',
            'studio_create',
            'studio_status',
            'download_artifact',
            'notebook_delete'
        ];
        const available = new Set(tools.tools.map(tool => tool.name));
        const missing = required.filter(name => !available.has(name));
        if (missing.length) throw new Error(`Missing MCP tools: ${missing.join(', ')}`);

        const result = await client.callTool({
            name: 'notebook_list',
            arguments: { max_results: 1 }
        });
        if (result.isError) throw new Error('NotebookLM rejected the authenticated request');
        console.log(`NotebookLM MCP check passed (${tools.tools.length} tools available)`);
    } finally {
        await client.close().catch(() => {});
    }
}

main().catch(error => {
    console.error(`NotebookLM MCP check failed: ${error.message}`);
    process.exitCode = 1;
});
