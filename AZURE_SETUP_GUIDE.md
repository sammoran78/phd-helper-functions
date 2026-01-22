# Azure Portal Setup Guide

Step-by-step instructions for manually configuring Azure resources for the PhD Helper Dashboard.

## Overview

You'll need to configure:
1. ✅ CosmosDB (database + 3 containers)
2. ✅ Blob Storage (container + CORS)
3. ✅ Function App (environment variables)
4. ⬜ Static Web App (link to Functions API)

---

## 1. CosmosDB Configuration

### Create Database and Containers

1. **Navigate to your CosmosDB Account** in Azure Portal
   - Search for "Cosmos DB" in the top search bar
   - Select your CosmosDB account

2. **Create Database**
   - Click "Data Explorer" in the left menu
   - Click "New Database"
   - Settings:
     - Database id: `phd-helper`
     - ☑️ Provision throughput: **Checked**
     - Throughput: `400` (Manual) - This will be shared across all containers
   - Click "OK"

3. **Create Container: references**
   - In Data Explorer, expand the `phd-helper` database
   - Click "New Container"
   - Settings:
     - Database id: Use existing `phd-helper`
     - Container id: `references`
     - Partition key: `/id`
     - ☐ Provision dedicated throughput: **Unchecked** (uses shared 400 RU/s)
   - Click "OK"

4. **Create Container: projects**
   - Click "New Container" again
   - Settings:
     - Database id: Use existing `phd-helper`
     - Container id: `projects`
     - Partition key: `/id`
     - ☐ Provision dedicated throughput: **Unchecked**
   - Click "OK"

5. **Create Container: analytics**
   - Click "New Container" again
   - Settings:
     - Database id: Use existing `phd-helper`
     - Container id: `analytics`
     - Partition key: `/id`
     - ☐ Provision dedicated throughput: **Unchecked**
   - Click "OK"

6. **Get Connection String**
   - In your CosmosDB account, click "Keys" in the left menu
   - Copy the **PRIMARY CONNECTION STRING**
   - Save this - you'll need it for Function App configuration

### Configure Firewall (Optional but Recommended)

1. In CosmosDB account, click "Networking" in left menu
2. Under "Firewall and virtual networks":
   - Select "Selected networks"
   - ☑️ Allow access from Azure Portal
   - ☑️ Allow access from Azure datacenters
   - Add your current IP if testing locally
3. Click "Save"

---

## 2. Blob Storage Configuration

### Create Container

1. **Navigate to your Storage Account** in Azure Portal
   - Search for "Storage accounts"
   - Select your storage account

2. **Create Container**
   - Click "Containers" in the left menu (under Data storage)
   - Click "+ Container" at the top
   - Settings:
     - Name: `uploads`
     - Public access level: **Blob (anonymous read access for blobs only)**
       - This allows uploaded PDFs to be accessed via URL
       - If you prefer private, select "Private" and use SAS tokens
   - Click "Create"

3. **Get Connection String**
   - In your Storage Account, click "Access keys" in the left menu
   - Under "key1", click "Show" next to Connection string
   - Copy the **Connection string**
   - Save this - you'll need it for Function App configuration

### Configure CORS

1. In your Storage Account, click "Resource sharing (CORS)" in left menu
2. Select the "Blob service" tab
3. Click "+ Add" and configure:
   - **Allowed origins**: `*` (or your Static Web App URL for production)
   - **Allowed methods**: ☑️ GET, ☑️ POST, ☑️ PUT, ☑️ DELETE
   - **Allowed headers**: `*`
   - **Exposed headers**: `*`
   - **Max age**: `3600`
4. Click "Save"

---

## 3. Function App Configuration

### Add Application Settings (Environment Variables)

1. **Navigate to your Function App** in Azure Portal
   - Search for "Function App"
   - Select your function app

2. **Add Configuration Settings**
   - Click "Configuration" in the left menu (under Settings)
   - Click "+ New application setting" for each of the following:

   | Name | Value | Notes |
   |------|-------|-------|
   | `COSMOSDB_CONNECTION_STRING` | *paste from step 1.6* | Primary connection string |
   | `COSMOSDB_DATABASE_NAME` | `phd-helper` | Database name |
   | `COSMOSDB_CONTAINER_REFERENCES` | `references` | Container for references |
   | `COSMOSDB_CONTAINER_PROJECTS` | `projects` | Container for projects |
   | `COSMOSDB_CONTAINER_ANALYTICS` | `analytics` | Container for analytics |
   | `BLOB_STORAGE_CONNECTION_STRING` | *paste from step 2.3* | Storage account connection string |
   | `BLOB_CONTAINER_UPLOADS` | `uploads` | Container name for uploads |
   | `OPENAI_API_KEY` | *your OpenAI key* | From OpenAI dashboard |
   | `OPENAI_MODEL` | `gpt-4o-mini` | Model to use |
   | `OPENAI_REASONING_EFFORT` | `low` | Reasoning effort level |

3. **Click "Save"** at the top
4. **Click "Continue"** to confirm restart

### Configure CORS (if needed)

1. In Function App, click "CORS" in the left menu (under API)
2. Add allowed origins:
   - Your Static Web App URL: `https://your-app.azurestaticapps.net`
   - For local development: `http://localhost:3000`
   - Or use `*` for testing (not recommended for production)
3. Click "Save"

---

## 4. Static Web App Configuration

### Link Function App as API Backend

**Option A: Integrated API (Recommended)**

If you created the Static Web App with an API location pointing to your functions folder, it will automatically deploy the functions together. No additional configuration needed.

**Option B: Bring Your Own Functions (Separate Function App)**

1. **Navigate to your Static Web App** in Azure Portal
2. Click "APIs" in the left menu
3. Click "Link" and select:
   - API type: "Functions"
   - Select your Function App from the dropdown
4. Click "Link"

### Configure Application Settings

1. In Static Web App, click "Configuration" in left menu
2. Add any frontend-specific environment variables if needed
3. The Static Web App will automatically proxy `/api/*` requests to your linked Function App

---

## 5. Verify Configuration

### Test CosmosDB Connection

```bash
# Using Azure CLI
az cosmosdb sql database show \
  --account-name <your-cosmosdb-account> \
  --name phd-helper \
  --resource-group <your-resource-group>
```

### Test Blob Storage

1. Go to Storage Account → Containers → uploads
2. Click "Upload" and try uploading a test file
3. Verify you can access the file via its URL

### Test Function App

1. Go to Function App → Functions
2. You should see all deployed functions listed
3. Click on "GetReferences" → "Code + Test" → "Test/Run"
4. Click "Run" and verify it returns data (or empty array if no data yet)

---

## 6. Security Checklist

- [ ] CosmosDB firewall configured to allow only Azure services + your IP
- [ ] Blob Storage CORS configured with specific origins (not `*` in production)
- [ ] Function App CORS configured with specific origins
- [ ] All connection strings stored as Application Settings (not in code)
- [ ] Consider enabling Azure AD authentication on Function App
- [ ] Consider using Managed Identity instead of connection strings
- [ ] Review and rotate access keys periodically

---

## 7. Cost Management

### Monitor Costs

1. Go to "Cost Management + Billing" in Azure Portal
2. Click "Cost analysis"
3. Filter by resource group to see costs for this project

### Expected Monthly Costs (Approximate)

- **CosmosDB**: $24-48/month (400 RU/s shared throughput)
- **Function App**: $0-10/month (Consumption plan, first 1M executions free)
- **Blob Storage**: $1-5/month (depends on storage size and transactions)
- **Static Web App**: Free tier available (100 GB bandwidth/month)
- **Total**: ~$25-65/month for low-medium usage

### Cost Optimization Tips

1. **CosmosDB**:
   - Use shared throughput across containers (already configured)
   - Consider serverless tier if usage is sporadic
   - Enable autoscale if usage varies

2. **Functions**:
   - Consumption plan is most cost-effective for low traffic
   - Monitor execution time and optimize slow functions

3. **Blob Storage**:
   - Use lifecycle management to move old files to Cool/Archive tier
   - Delete unused blobs regularly

---

## 8. Troubleshooting

### "Connection string is invalid"
- Verify you copied the entire connection string
- Check for extra spaces or line breaks
- Ensure the connection string includes `AccountEndpoint` and `AccountKey`

### "Container not found"
- Verify container names match exactly (case-sensitive)
- Check database name is correct
- Ensure containers were created successfully in Data Explorer

### "Access denied" errors
- Check firewall settings in CosmosDB
- Verify Function App has correct connection string
- Ensure Managed Identity is configured if using it

### Functions not appearing in Static Web App
- Verify API location in workflow file matches function folder
- Check GitHub Actions deployment logs
- Ensure functions are deployed to the correct Function App

---

## Next Steps

After completing this setup:

1. ✅ Run the migration script to import existing data
2. ✅ Deploy the Azure Functions
3. ✅ Update frontend to use new API endpoints
4. ✅ Test all functionality end-to-end
5. ✅ Set up monitoring and alerts
6. ✅ Configure CI/CD pipeline

For detailed migration instructions, see [README.md](README.md).
