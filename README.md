# PhD Helper - Azure Functions API

Azure Functions backend for the PhD Helper Dashboard, replacing the Express.js server with cloud-native serverless functions.

## Architecture

- **CosmosDB**: Stores references, projects, analytics data
- **Blob Storage**: Stores uploaded PDFs and documents
- **Azure Functions**: Serverless API endpoints
- **OpenAI**: LLM analysis for references

## Prerequisites

- Node.js 18+ installed
- Azure CLI installed and logged in
- Azure subscription with:
  - CosmosDB account created
  - Blob Storage account created
  - Function App created (or will be deployed via VS Code)

## Project Structure

```
phd-helper-functions/
├── shared/
│   ├── cosmosClient.js       # CosmosDB utilities
│   ├── blobClient.js          # Blob Storage utilities
│   └── textExtractor.js       # PDF/DOCX text extraction
├── GetReferences/             # GET /api/references
├── CreateReference/           # POST /api/references
├── UpdateReference/           # PUT /api/references/{id}
├── DeleteReference/           # DELETE /api/references/{id}
├── UploadFile/                # POST /api/references/upload
├── AnalyzeReference/          # POST /api/references/analyze
├── scripts/
│   └── migrate-references.js  # Migration script for references.json
├── package.json
├── host.json
└── local.settings.json
```

## Setup Instructions

### 1. Install Dependencies

```bash
cd phd-helper-functions
npm install
```

### 2. Configure Azure Resources (Manual Steps)

#### A. CosmosDB Setup

1. **Go to Azure Portal** → Your CosmosDB Account
2. **Create Database**:
   - Database ID: `phd-helper`
   - Throughput: Shared (400 RU/s recommended for cost savings)
3. **Create Containers**:
   - Container 1:
     - Container ID: `references`
     - Partition key: `/id`
   - Container 2:
     - Container ID: `projects`
     - Partition key: `/id`
   - Container 3:
     - Container ID: `analytics`
     - Partition key: `/id`
4. **Get Connection String**:
   - Go to "Keys" section
   - Copy "PRIMARY CONNECTION STRING"

#### B. Blob Storage Setup

1. **Go to Azure Portal** → Your Storage Account
2. **Create Container**:
   - Name: `uploads`
   - Public access level: **Blob** (anonymous read access for blobs)
   - Or use **Private** and configure SAS tokens if needed
3. **Get Connection String**:
   - Go to "Access keys" section
   - Copy "Connection string" from key1 or key2
4. **Configure CORS** (if accessing from browser):
   - Go to "Resource sharing (CORS)" under Settings
   - Add rule:
     - Allowed origins: `*` (or your Static Web App URL)
     - Allowed methods: GET, POST, PUT, DELETE
     - Allowed headers: `*`
     - Exposed headers: `*`
     - Max age: 3600

#### C. Function App Configuration

1. **Go to Azure Portal** → Your Function App
2. **Configuration** → Application Settings → Add:
   ```
   COSMOSDB_CONNECTION_STRING=<your_cosmosdb_connection_string>
   COSMOSDB_DATABASE_NAME=phd-helper
   COSMOSDB_CONTAINER_REFERENCES=references
   COSMOSDB_CONTAINER_PROJECTS=projects
   COSMOSDB_CONTAINER_ANALYTICS=analytics
   BLOB_STORAGE_CONNECTION_STRING=<your_blob_storage_connection_string>
   BLOB_CONTAINER_UPLOADS=uploads
   OPENAI_API_KEY=<your_openai_api_key>
   OPENAI_MODEL=gpt-4o-mini
   OPENAI_REASONING_EFFORT=low
   ```
3. **Save** the configuration

### 3. Configure Local Development

Create a `.env` file or update `local.settings.json`:

```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "",
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "COSMOSDB_CONNECTION_STRING": "<your_connection_string>",
    "COSMOSDB_DATABASE_NAME": "phd-helper",
    "COSMOSDB_CONTAINER_REFERENCES": "references",
    "COSMOSDB_CONTAINER_PROJECTS": "projects",
    "COSMOSDB_CONTAINER_ANALYTICS": "analytics",
    "BLOB_STORAGE_CONNECTION_STRING": "<your_connection_string>",
    "BLOB_CONTAINER_UPLOADS": "uploads",
    "OPENAI_API_KEY": "<your_key>",
    "OPENAI_MODEL": "gpt-4o-mini",
    "OPENAI_REASONING_EFFORT": "low"
  }
}
```

### 4. Migrate Existing Data

Run the migration script to transfer `references.json` to CosmosDB:

```bash
# Install dotenv for the script
npm install dotenv

# Run migration
node scripts/migrate-references.js ../phd-helper-cloud/references.json
```

The script will:
- Read all references from the JSON file
- Upload them to CosmosDB
- Report success/error counts

### 5. Deploy to Azure

#### Option A: VS Code Azure Functions Extension

1. Install "Azure Functions" extension in VS Code
2. Sign in to Azure
3. Click "Deploy to Function App" icon
4. Select your Function App
5. Confirm deployment

#### Option B: Azure CLI

```bash
# Login to Azure
az login

# Deploy
func azure functionapp publish <your-function-app-name>
```

### 6. Test the API

After deployment, your functions will be available at:
```
https://<your-function-app-name>.azurewebsites.net/api/references
```

Test endpoints:
```bash
# Get all references
curl https://<your-function-app-name>.azurewebsites.net/api/references

# Create reference
curl -X POST https://<your-function-app-name>.azurewebsites.net/api/references \
  -H "Content-Type: application/json" \
  -d '{"title":"Test","authors":"Smith, J.","year":"2024"}'
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/references` | Get all references |
| POST | `/api/references` | Create new reference |
| PUT | `/api/references/{id}` | Update reference |
| DELETE | `/api/references/{id}` | Delete reference |
| POST | `/api/references/upload` | Upload PDF/DOCX to Blob Storage |
| POST | `/api/references/analyze` | Analyze document with OpenAI |

## Frontend Integration

Update the frontend API calls to point to your Azure Functions:

```javascript
// Old (local Express server)
const API_BASE = 'http://localhost:3000/api';

// New (Azure Functions)
const API_BASE = 'https://<your-function-app-name>.azurewebsites.net/api';
// OR for Static Web Apps with integrated API:
const API_BASE = '/api';
```

## Security Notes

1. **OAuth Tokens**: The `oauth-tokens.json` file contains Google OAuth credentials. If still needed:
   - Store in Azure Key Vault
   - Reference in Function App configuration
   - Never commit to git

2. **Service Account**: The `service-account.json` file should:
   - Be stored in Azure Key Vault
   - Or use Azure Managed Identity for Google Cloud access

3. **CORS**: Configure CORS in Function App settings if accessing from different domains

4. **Authentication**: Consider adding Azure AD authentication for production:
   - Update `authLevel` in function.json from `anonymous` to `function` or `admin`
   - Configure authentication in Azure Portal

## Troubleshooting

### CosmosDB Connection Issues
- Verify connection string is correct
- Check firewall rules allow your IP/Azure services
- Ensure database and containers exist

### Blob Storage Upload Fails
- Check connection string
- Verify container exists and has correct access level
- Check file size limits (default 100MB for Functions)

### OpenAI Analysis Fails
- Verify API key is set
- Check model name is correct
- Ensure sufficient OpenAI credits

### Function Timeout
- Default timeout is 5 minutes (configurable in host.json)
- For long-running analysis, consider increasing timeout
- Or use Durable Functions for orchestration

## Cost Optimization

- **CosmosDB**: Use shared throughput (400 RU/s) across containers
- **Functions**: Consumption plan is cheapest for low traffic
- **Blob Storage**: Use "Hot" tier for frequently accessed files
- **OpenAI**: Use `gpt-4o-mini` for cost-effective analysis

## Next Steps

1. ✅ Deploy Functions to Azure
2. ✅ Migrate references.json to CosmosDB
3. ⬜ Update frontend to use new API endpoints
4. ⬜ Test all functionality
5. ⬜ Configure Static Web App to use Functions as API
6. ⬜ Set up CI/CD pipeline (GitHub Actions)
7. ⬜ Add monitoring and Application Insights