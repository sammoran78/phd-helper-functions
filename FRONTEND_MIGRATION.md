# Frontend Migration Guide

Instructions for updating the PhD Helper Dashboard frontend to use Azure Functions instead of the local Express server.

## Changes Required

### 1. Update API Base URL

The frontend currently makes API calls to `http://localhost:3000/api`. These need to be updated to use the Azure Functions endpoint.

**Location**: Create a new config file or update existing API calls

**Option A: For Static Web App with Integrated API**
```javascript
// The Static Web App automatically proxies /api/* to your Functions
const API_BASE = '/api';
```

**Option B: For Separate Function App**
```javascript
const API_BASE = 'https://<your-function-app-name>.azurewebsites.net/api';
```

### 2. Files to Update

#### `js/views/references.js`

**Current API calls:**
- `GET /api/references` → Load references
- `POST /api/references` → Create reference
- `PUT /api/references/:id` → Update reference
- `DELETE /api/references/:id` → Delete reference
- `POST /api/references/upload` → Upload file
- `POST /api/references/analyze` → Analyze with OpenAI

**Changes needed:**
1. Update fetch URLs to use new API_BASE
2. Update file upload to include `blobName` in analyze request

**Example changes:**

```javascript
// OLD
fetch('/api/references')

// NEW
fetch(`${API_BASE}/references`)
```

For the analyze function, update to pass blobName:
```javascript
// In autofillSection function
const response = await fetch(`${API_BASE}/references/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
        fileUrl: file.url, 
        fileName: file.name,
        blobName: file.blobName, // NEW: Add this from upload response
        section: section 
    })
});
```

#### `js/views/lit-review.js`

Currently uses mock data. If you want to integrate with real file uploads:
- Update `simulateProcessing()` to actually upload to Blob Storage
- Use the same `/api/references/upload` endpoint

#### `server.js` (Local Development Only)

For local development, you can:
1. Keep the Express server running alongside Azure Functions
2. Or update it to proxy requests to Azure Functions
3. Or remove it entirely and use Azure Functions locally with `func start`

### 3. Update File Upload Response Handling

The Azure Functions upload endpoint returns a slightly different response:

**Old response:**
```json
{
  "success": true,
  "url": "https://storage.blob.core.windows.net/uploads/123_file.pdf",
  "fileName": "file.pdf"
}
```

**New response (includes blobName):**
```json
{
  "success": true,
  "url": "https://storage.blob.core.windows.net/uploads/123_file.pdf",
  "fileName": "file.pdf",
  "blobName": "123_file.pdf"
}
```

**Update in `uploadRefFile()` function:**
```javascript
xhr.onload = () => {
    if (xhr.status === 200) {
        const result = JSON.parse(xhr.responseText);
        if (result.success) {
            AppState.currentRefFiles.push({ 
                name: result.fileName, 
                url: result.url,
                blobName: result.blobName // NEW: Store this for later analysis
            });
            renderRefFiles();
            // ... rest of code
        }
    }
};
```

### 4. Remove Google Drive Fallback

The Azure Functions version doesn't include Google Drive upload fallback. All files go directly to Blob Storage.

**Remove or comment out:**
- Any Google Drive API initialization code
- Service account file references
- Drive upload fallback logic

### 5. Update Analytics Endpoints (If Implemented)

If you implement analytics functions:
- `GET /api/analytics/cache` → Get cached analytics
- `POST /api/analytics/analyze` → Analyze references

These would follow the same pattern as references endpoints.

### 6. Environment-Specific Configuration

Create a configuration file to handle different environments:

**Create: `js/config.js`**
```javascript
const Config = {
    // Automatically detect environment
    API_BASE: window.location.hostname === 'localhost' 
        ? 'http://localhost:7071/api'  // Local Azure Functions
        : '/api',  // Production Static Web App
    
    // Or use environment variable if available
    // API_BASE: process.env.API_BASE || '/api'
};

export default Config;
```

**Then import in other files:**
```javascript
import Config from '../config.js';

// Use in fetch calls
fetch(`${Config.API_BASE}/references`)
```

### 7. Update CORS Headers (If Needed)

If you're accessing the Function App directly (not through Static Web App proxy), you may need to handle CORS:

```javascript
fetch(`${API_BASE}/references`, {
    method: 'GET',
    headers: {
        'Content-Type': 'application/json',
        // Add any required headers
    },
    mode: 'cors'
})
```

### 8. Error Handling Updates

Azure Functions return slightly different error formats. Update error handling:

```javascript
// OLD
.catch(err => {
    console.error(err);
    alert('Error loading references');
});

// NEW - Handle both network errors and API errors
.then(res => {
    if (!res.ok) {
        return res.json().then(err => {
            throw new Error(err.error || err.details || 'API request failed');
        });
    }
    return res.json();
})
.catch(err => {
    console.error('API Error:', err);
    alert(`Error: ${err.message}`);
});
```

### 9. Testing Checklist

After making changes, test:

- [ ] Load references list
- [ ] Create new reference
- [ ] Edit existing reference
- [ ] Delete reference
- [ ] Upload PDF file
- [ ] Analyze document (summary, theory, method)
- [ ] DOI lookup (if still using CrossRef)
- [ ] Export BibTeX
- [ ] Search/filter references
- [ ] Pagination

### 10. Migration Steps

1. **Create config.js** with API_BASE configuration
2. **Update references.js**:
   - Import Config
   - Replace all `/api/` with `${Config.API_BASE}/`
   - Update file upload to store blobName
   - Update analyze to pass blobName
3. **Test locally** with Azure Functions running (`func start`)
4. **Deploy frontend** to Static Web App
5. **Test in production**
6. **Remove old server.js** (optional, keep for local dev if needed)

### 11. Backward Compatibility (Optional)

If you want to support both old and new backends during migration:

```javascript
const Config = {
    API_BASE: localStorage.getItem('api_mode') === 'local' 
        ? 'http://localhost:3000/api'  // Old Express server
        : '/api',  // New Azure Functions
};

// Add UI toggle to switch between modes for testing
```

### 12. Static Web App Deployment

Update your GitHub Actions workflow if needed:

```yaml
# .github/workflows/azure-static-web-apps-*.yml
app_location: "/" # Frontend root
api_location: "" # Leave empty if using separate Function App
output_location: "/" # No build output
```

If using integrated API:
```yaml
api_location: "/api" # Points to your functions folder
```

But since your functions are in a separate repo (`phd-helper-functions`), you'll likely use the "Bring Your Own Functions" approach and leave `api_location` empty.

---

## Quick Reference: API Endpoint Mapping

| Old Express Endpoint | New Azure Function | Method |
|---------------------|-------------------|--------|
| `/api/references` | `/api/references` | GET |
| `/api/references` | `/api/references` | POST |
| `/api/references/:id` | `/api/references/{id}` | PUT |
| `/api/references/:id` | `/api/references/{id}` | DELETE |
| `/api/references/upload` | `/api/references/upload` | POST |
| `/api/references/analyze` | `/api/references/analyze` | POST |
| `/api/doi/:doi` | *Keep as proxy or move to function* | GET |
| `/api/analytics/cache` | *To be implemented* | GET |
| `/api/analytics/analyze` | *To be implemented* | POST |
| `/api/projects` | *To be implemented* | GET |
| `/api/projects/task` | *To be implemented* | POST |

---

## Next Steps

1. Create `js/config.js` with API configuration
2. Update `js/views/references.js` with new API calls
3. Test locally with Azure Functions
4. Deploy and test in production
5. Monitor for any issues
6. Remove old Express server code once stable
