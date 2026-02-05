# Azure OpenAI Migration Guide

## Why Azure OpenAI?

**CRITICAL for legal/healthcare use:**
- ✅ **Zero data retention** by default
- ✅ **HIPAA/HITECH compliant** with BAA
- ✅ **Data stays in your Azure tenant**
- ✅ **Better audit logs** for compliance
- ✅ **No Enterprise tier required** for compliance features

**Standard OpenAI:**
- ❌ **30-day data retention** (unless Enterprise ZDR)
- ❌ **BAA only with Enterprise tier**
- ❌ **Data leaves your control**

## Migration Steps

### 1. Get Azure OpenAI Access

1. Apply for access: https://aka.ms/oai/access
   - Mention legal/healthcare use case
   - Approval typically within 1-2 business days

2. Create Azure OpenAI resource in Azure Portal:
   ```
   - Go to portal.azure.com
   - Create Resource → Azure OpenAI
   - Choose region (recommend same as your data)
   - Select pricing tier (Standard works fine)
   ```

3. Deploy Whisper model:
   ```
   - In your Azure OpenAI resource → Model deployments
   - Click "Create new deployment"
   - Model: whisper (latest version)
   - Deployment name: whisper-1 (or your choice)
   - Deploy
   ```

4. Get credentials:
   ```
   - In your Azure OpenAI resource → Keys and Endpoint
   - Copy "Endpoint" (e.g., https://YOUR-NAME.openai.azure.com)
   - Copy "KEY 1"
   ```

### 2. Update Environment Variables

**Railway Environment Variables:**
```bash
USE_AZURE_OPENAI=true
AZURE_OPENAI_ENDPOINT=https://your-resource-name.openai.azure.com
AZURE_OPENAI_API_KEY=your-azure-api-key-here
AZURE_WHISPER_DEPLOYMENT_NAME=whisper-1
```

**Local .env file:**
Copy `.env.example` to `.env` and fill in your Azure credentials.

### 3. Test Locally

```bash
npm run build
npm start
```

Upload a test dictation through your frontend and verify:
- Transcription completes successfully
- Worker logs show "Azure" mode
- No errors in Railway logs

### 4. Deploy to Railway

```bash
git add .
git commit -m "Migrate to Azure OpenAI for HIPAA compliance"
git push
```

Railway will automatically redeploy with the new code.

### 5. Verify in Production

1. Upload a test dictation
2. Check Railway logs for successful transcription
3. Verify transcript appears in your app

## Compliance Checklist

After migration, ensure you have:

- [ ] Azure OpenAI BAA signed (available in Azure Portal)
- [ ] Azure PostgreSQL BAA (included with Azure)
- [ ] Microsoft Entra (already configured)
- [ ] Data Processing Agreement with customer
- [ ] Privacy policy updated to mention AI processing
- [ ] Customer consent for AI processing of PHI

## Rollback Plan

If Azure has issues, you can temporarily rollback:

```bash
# In Railway environment variables
USE_AZURE_OPENAI=false
```

This will use standard OpenAI (but NOT compliant for PHI).

## Cost Comparison

**Azure OpenAI Whisper pricing:**
- ~$0.006 per minute of audio
- Same as standard OpenAI

**No price difference, but you get:**
- HIPAA compliance
- Zero data retention
- Better audit logs
- Data residency control

## Support

If you encounter issues:
- Azure OpenAI docs: https://learn.microsoft.com/en-us/azure/ai-services/openai/
- Azure support: Available in portal (included with subscription)
